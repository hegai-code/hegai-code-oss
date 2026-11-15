//! The fleet Live Activity (docs/WATCH.md §5): one per user, not one per run.
//!
//! `LiveRegistry` holds each user's push-to-start and activity tokens and runs
//! the aggregation state machine; it does no I/O and takes the clock as an
//! argument. The hub feeds it a fresh `Snapshot` when a run's state moved and
//! asks it what is due on its 500 ms tick; the notifier sends what comes out.
//!
//! Tokens persist (`live_activity_tokens`, a table of the workspace store):
//! a Live Activity outlives a hub restart by hours and a deploy happens many
//! times a day, so a map in memory would orphan an activity on every deploy —
//! it could never be updated or ended again and would sit stale on the lock
//! screen until iOS killed it.

use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::workspace::{db_err, WorkspaceStore};

pub const ATTRIBUTES_TYPE: &str = "HegaiFleetAttributes";
/// Quiet period after the last change before anything is sent.
pub const DEBOUNCE_MS: i64 = 3_000;
/// A fleet that never stops changing still gets a push this often.
pub const MAX_DEFER_MS: i64 = 15_000;
/// Updates that change nothing but the item list.
pub const UPDATE_MIN_GAP_MS: i64 = 15_000;
/// Re-starting an activity the user dismissed.
pub const START_MIN_GAP_MS: i64 = 10 * 60_000;
pub const STALE_AFTER_S: i64 = 20 * 60;
pub const DISMISS_AFTER_S: i64 = 10 * 60;
/// A live activity hears from the hub at least this often, so its `stale-date`
/// passes only when the hub really lost it, not when a run is simply long.
pub const HEARTBEAT_MS: i64 = 10 * 60_000;
/// No second push-to-start while an earlier one never produced an activity
/// token. That card is on the lock screen and nothing can update or end it;
/// another start only stacks a second frozen card beside it. iOS ends an
/// activity after 8 hours, so the hold cannot outlive the card it waits for.
pub const UNCONFIRMED_START_HOLD_MS: i64 = 8 * 3_600_000;
/// Tokens kept per user (oldest evicted): phones and iPads, not a botnet.
const START_TOKENS_MAX: usize = 8;
const ACTIVITY_TOKENS_MAX: usize = 4;
const TOKEN_MAX_LEN: usize = 512;
/// The `activityId` of an `ended` report that names no card: the app is in the
/// foreground and has none (docs/WATCH.md §5).
const NO_CARDS_ID: &str = "no-cards";
const ID_MAX_LEN: usize = 128;

// ------------------------------------------------------------- snapshot

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub title: String,
    /// "needs_attention" | "error" | "working" (the wire names, docs/WATCH.md §5)
    pub state: String,
    /// When the run entered that state (epoch ms).
    pub since_ms: i64,
    /// The session's own plan, `(done, total)`, when it keeps one — the
    /// agent's `plan_progress` status (agent/src/plan-tool.ts).
    pub plan: Option<(u32, u32)>,
}

/// Rows a snapshot lists. The lock screen shows all of them, the Dynamic
/// Island the first three (ios/CCRemoteWidgets/FleetLiveActivity.swift). Five
/// titles of ≤60 characters stay far inside ActivityKit's 4 KB payload.
pub const ITEMS_MAX: usize = 5;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Snapshot {
    pub working: u32,
    pub waiting: u32,
    /// Waiting first, then working, newest first; at most `ITEMS_MAX`.
    pub items: Vec<Item>,
}

impl Snapshot {
    pub fn is_idle(&self) -> bool {
        self.working == 0 && self.waiting == 0
    }
    /// What counts as "a change": the counts and who is listed, not the clock.
    fn signature(&self) -> Sig {
        (
            self.working,
            self.waiting,
            self.items
                .iter()
                .map(|i| (i.title.clone(), i.state.clone(), i.plan))
                .collect(),
        )
    }
    pub fn content_state(&self, updated_ms: i64) -> Value {
        let items: Vec<Value> = self
            .items
            .iter()
            .take(ITEMS_MAX)
            .map(|i| {
                let mut item = json!({"title": i.title, "state": i.state, "sinceMs": i.since_ms});
                // Absent, never null (an optional on the phone; older apps
                // ignore unknown keys).
                if let Some((done, total)) = i.plan {
                    item["planDone"] = json!(done);
                    item["planTotal"] = json!(total);
                }
                item
            })
            .collect();
        json!({
            "working": self.working,
            "waiting": self.waiting,
            "items": items,
            "updatedMs": updated_ms,
        })
    }
}

/// Build the snapshot from `(title, state, since_ms)` of the user's runs
/// (`needs_attention` => waiting, `working`; an `error` run is listed but not
/// counted). The tests' shorthand for runs that keep no plan.
#[cfg(test)]
pub fn snapshot_of(runs: &[(String, &str, i64)]) -> Snapshot {
    let with_plans: Vec<_> = runs
        .iter()
        .map(|(t, s, since)| (t.clone(), *s, *since, None))
        .collect();
    snapshot_with_plans(&with_plans)
}

/// [`snapshot_of`] with each run's plan progress.
pub fn snapshot_with_plans(runs: &[(String, &str, i64, Option<(u32, u32)>)]) -> Snapshot {
    let of = |state: &str| -> Vec<&(String, &str, i64, Option<(u32, u32)>)> {
        runs.iter().filter(|r| r.1 == state).collect()
    };
    let (waiting, errored, working) = (of("needs_attention"), of("error"), of("working"));
    let mut ordered: Vec<Item> = Vec::new();
    for (group, name) in [
        (&waiting, "needs_attention"),
        (&errored, "error"),
        (&working, "working"),
    ] {
        let mut g: Vec<_> = group.iter().collect();
        g.sort_by_key(|r| std::cmp::Reverse(r.2));
        ordered.extend(g.iter().map(|r| Item {
            title: crate::push_payload::excerpt(&crate::push_payload::one_line(&r.0), 60),
            state: name.to_string(),
            since_ms: r.2,
            plan: r.3,
        }));
    }
    ordered.truncate(ITEMS_MAX);
    Snapshot {
        working: working.len() as u32,
        waiting: waiting.len() as u32,
        items: ordered,
    }
}

// --------------------------------------------------------------- actions

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LiveAction {
    /// Push-to-start to every start token of the user.
    Start {
        tokens: Vec<String>,
    },
    /// To every activity token of the user (several devices).
    Update {
        tokens: Vec<String>,
        /// 10 when someone started waiting, else 5.
        priority: u8,
    },
    End {
        tokens: Vec<String>,
    },
}

/// Which kind of push an outcome report is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiveKind {
    Start,
    Update,
    End,
}

impl LiveAction {
    pub fn kind(&self) -> LiveKind {
        match self {
            LiveAction::Start { .. } => LiveKind::Start,
            LiveAction::Update { .. } => LiveKind::Update,
            LiveAction::End { .. } => LiveKind::End,
        }
    }
}

/// What APNs (or the notifier) said about one token of one push.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiveOutcome {
    Ok,
    /// Network error, 5xx, throttling: worth trying again.
    Transient,
    /// 410 / BadDeviceToken on both endpoints: the token is dead.
    Unregistered,
}

/// A failed push is tried again at most this many times in all.
pub const RETRY_MAX: u32 = 3;
/// Wait before retry n: `RETRY_BACKOFF_MS * n`.
pub const RETRY_BACKOFF_MS: i64 = 15_000;

/// What a start/update changed when it was handed out, so a failure can take
/// it back.
#[derive(Debug)]
struct Undo {
    kind: LiveKind,
    sent_counts: Option<(u32, u32)>,
    sent_sig: Option<Sig>,
    last_update_ms: Option<i64>,
    last_start_ms: Option<i64>,
    unconfirmed_start_ms: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct ActivityToken {
    pub id: String,
    pub token: String,
}

type Sig = (u32, u32, Vec<(String, String, Option<(u32, u32)>)>);

#[derive(Debug, Default)]
struct UserLive {
    start_tokens: Vec<String>,
    /// One per `activityId`, oldest first, at most `ACTIVITY_TOKENS_MAX`.
    activities: Vec<ActivityToken>,
    snap: Snapshot,
    sig: Option<Sig>,
    /// The signature of the last start/update that went out.
    sent_sig: Option<Sig>,
    last_change: i64,
    dirty_since: Option<i64>,
    /// (working, waiting) of the last push that went out.
    sent_counts: Option<(u32, u32)>,
    last_update_ms: Option<i64>,
    last_start_ms: Option<i64>,
    /// A start went out and no activity token has come back for it yet.
    /// Persisted: a deploy must not read as "no card out there".
    unconfirmed_start_ms: Option<i64>,
    /// When the activity last got a fresh `stale-date` (start or update).
    last_fresh_ms: Option<i64>,
    /// The last start/update handed out, until its outcome is known.
    undo: Option<Undo>,
    /// Failed attempts of the push that is being retried.
    attempts: u32,
    /// Nothing is sent to this user before this time (retry backoff).
    retry_at_ms: i64,
}

#[derive(Debug, Default)]
pub struct LiveRegistry {
    users: HashMap<String, UserLive>,
}

impl LiveRegistry {
    pub fn is_empty(&self) -> bool {
        self.users.is_empty()
    }
    /// Test clock: pretend every pending change happened `by_ms` earlier.
    #[cfg(test)]
    pub fn age_changes(&mut self, by_ms: i64) {
        for u in self.users.values_mut() {
            u.last_change -= by_ms;
            u.dirty_since = u.dirty_since.map(|t| t - by_ms);
        }
    }
    pub fn users(&self) -> Vec<String> {
        self.users.keys().cloned().collect()
    }

    pub fn load(rows: Vec<TokenRow>) -> LiveRegistry {
        let mut r = LiveRegistry::default();
        for row in rows {
            match row.activity_id {
                None => r.add_start(&row.user_id, &row.token),
                Some(id) => r.set_activity(&row.user_id, &id, &row.token),
            }
        }
        r
    }

    pub fn add_start(&mut self, user: &str, token: &str) {
        self.claim(user, token);
        let u = self.users.entry(user.to_string()).or_default();
        u.start_tokens.retain(|t| t != token);
        u.start_tokens.push(token.to_string());
        let over = u.start_tokens.len().saturating_sub(START_TOKENS_MAX);
        u.start_tokens.drain(..over);
    }

    pub fn set_activity(&mut self, user: &str, id: &str, token: &str) {
        self.claim(user, token);
        let u = self.users.entry(user.to_string()).or_default();
        u.activities.retain(|a| a.id != id && a.token != token);
        u.activities.push(ActivityToken {
            id: id.to_string(),
            token: token.to_string(),
        });
        let over = u.activities.len().saturating_sub(ACTIVITY_TOKENS_MAX);
        u.activities.drain(..over);
        // The fleet may have changed between the push-to-start and this token
        // (a run went idle: the activity is owed an `end`). Pretend the last
        // observation was what the last push said, so the next observe
        // re-evaluates; when nothing moved it is the same signature and stays
        // quiet (no duplicate update).
        u.sig = u.sent_sig.clone();
        u.last_update_ms = None;
        u.unconfirmed_start_ms = None;
    }

    /// A token belongs to one user: drop it from everybody else.
    fn claim(&mut self, user: &str, token: &str) {
        for (other, u) in &mut self.users {
            if other != user {
                u.start_tokens.retain(|t| t != token);
                u.activities.retain(|a| a.token != token);
            }
        }
    }

    /// The app says this activity ended; only its own token goes. Returns
    /// whether it was a known one.
    pub fn activity_ended(&mut self, user: &str, id: &str) -> bool {
        let Some(u) = self.users.get_mut(user) else {
            return false;
        };
        // The app is reporting on its cards: whatever a pending start was
        // waiting for, the phone is talking again and can answer a new one.
        let was_held = u.unconfirmed_start_ms.take().is_some();
        // The start never became a card, so one is still owed to an unchanged
        // run. A card the person dismissed (a real id) is not brought back.
        if was_held && id == NO_CARDS_ID {
            u.dirty_since.get_or_insert(u.last_change);
        }
        let before = u.activities.len();
        u.activities.retain(|a| a.id != id);
        if u.activities.is_empty() {
            u.sent_sig = None;
            u.sent_counts = None;
            u.last_update_ms = None;
        }
        u.activities.len() != before
    }

    /// APNs refused a token for good, or the app signed out with it.
    pub fn forget_token(&mut self, token: &str) {
        for u in self.users.values_mut() {
            u.start_tokens.retain(|t| t != token);
            u.activities.retain(|a| a.token != token);
            if u.activities.is_empty() {
                u.sent_sig = None;
                u.sent_counts = None;
            }
            if u.start_tokens.is_empty() {
                u.unconfirmed_start_ms = None;
            }
        }
    }

    /// An account was erased.
    pub fn forget_user(&mut self, user: &str) {
        self.users.remove(user);
    }

    /// The start still waiting for its activity token (what the hub persists).
    pub fn unconfirmed_start(&self, user: &str) -> Option<i64> {
        self.users.get(user).and_then(|u| u.unconfirmed_start_ms)
    }

    /// Back from the store on hub start. A user without tokens has no entry
    /// and nothing to hold.
    pub fn restore_unconfirmed_start(&mut self, user: &str, started_ms: i64) {
        if let Some(u) = self.users.get_mut(user) {
            u.unconfirmed_start_ms = Some(started_ms);
        }
    }

    #[cfg(test)]
    pub fn activities_of(&self, user: &str) -> Vec<ActivityToken> {
        self.users
            .get(user)
            .map(|u| u.activities.clone())
            .unwrap_or_default()
    }
    #[cfg(test)]
    pub fn start_tokens_of(&self, user: &str) -> Vec<String> {
        self.users
            .get(user)
            .map(|u| u.start_tokens.clone())
            .unwrap_or_default()
    }

    /// Record what the user's fleet looks like now. A different signature
    /// restarts the debounce; the same one only refreshes the clock fields.
    pub fn observe(&mut self, user: &str, snap: Snapshot, now_ms: i64) {
        let Some(u) = self.users.get_mut(user) else {
            return;
        };
        let sig = snap.signature();
        if u.sig.as_ref() != Some(&sig) {
            u.sig = Some(sig);
            u.last_change = now_ms;
            u.dirty_since.get_or_insert(now_ms);
        }
        u.snap = snap;
    }

    /// The notifier's report on one push. Returns the tokens the hub must now
    /// delete from the database: dead ones (any kind) and the activity tokens
    /// of an `end` that went out (or ran out of retries).
    pub fn sent(
        &mut self,
        user: &str,
        kind: LiveKind,
        results: &[(String, LiveOutcome)],
        now_ms: i64,
    ) -> Vec<String> {
        let mut dropped = Vec::new();
        for (token, outcome) in results {
            if *outcome == LiveOutcome::Unregistered {
                self.forget_token(token);
                dropped.push(token.clone());
            }
        }
        let Some(u) = self.users.get_mut(user) else {
            return dropped;
        };
        let any_ok = results.iter().any(|(_, o)| *o == LiveOutcome::Ok);
        let transient: Vec<&String> = results
            .iter()
            .filter(|(_, o)| *o == LiveOutcome::Transient)
            .map(|(t, _)| t)
            .collect();
        if kind == LiveKind::End {
            for (token, outcome) in results {
                if *outcome == LiveOutcome::Ok {
                    u.activities.retain(|a| &a.token != token);
                    dropped.push(token.clone());
                }
            }
            if transient.is_empty() {
                u.attempts = 0;
                return dropped;
            }
            u.attempts += 1;
            if u.attempts >= RETRY_MAX {
                // Out of attempts: the activity goes stale on its own.
                u.attempts = 0;
                for token in transient {
                    u.activities.retain(|a| &a.token != token);
                    dropped.push(token.clone());
                }
            } else if !u.activities.is_empty() {
                u.dirty_since = Some(now_ms);
                u.retry_at_ms = now_ms + RETRY_BACKOFF_MS * i64::from(u.attempts);
            }
            return dropped;
        }
        let undo = u.undo.take().filter(|undo| undo.kind == kind);
        if kind == LiveKind::Start && !any_ok {
            // Nothing reached a phone: there is no card to wait for.
            if let Some(undo) = &undo {
                u.unconfirmed_start_ms = undo.unconfirmed_start_ms;
            }
        }
        if any_ok || transient.is_empty() {
            u.attempts = 0;
            return dropped;
        }
        u.attempts += 1;
        if u.attempts >= RETRY_MAX {
            u.attempts = 0;
            return dropped;
        }
        if let Some(undo) = undo {
            u.sent_counts = undo.sent_counts;
            u.sent_sig = undo.sent_sig;
            u.last_update_ms = undo.last_update_ms;
            u.last_start_ms = undo.last_start_ms;
            u.dirty_since = Some(now_ms);
            u.retry_at_ms = now_ms + RETRY_BACKOFF_MS * i64::from(u.attempts);
        }
        dropped
    }

    /// What is due now, per user, with the snapshot to send. State advances as
    /// if the pushes went out; `sent` takes it back when they did not.
    pub fn due(&mut self, now_ms: i64) -> Vec<(String, LiveAction, Snapshot)> {
        let mut out = Vec::new();
        for (user, u) in &mut self.users {
            if u.dirty_since.is_none()
                && !u.activities.is_empty()
                && !u.snap.is_idle()
                && u.last_fresh_ms.is_some_and(|t| now_ms - t >= HEARTBEAT_MS)
            {
                u.dirty_since = Some(now_ms);
            }
            // The card the hold waited for is gone by now, and an unchanged run
            // would never say so.
            if u.dirty_since.is_none()
                && u.activities.is_empty()
                && !u.snap.is_idle()
                && u.unconfirmed_start_ms
                    .is_some_and(|t| now_ms - t >= UNCONFIRMED_START_HOLD_MS)
            {
                u.dirty_since = Some(now_ms);
            }
            let Some(dirty_since) = u.dirty_since else {
                continue;
            };
            if now_ms < u.retry_at_ms {
                continue;
            }
            if now_ms - u.last_change < DEBOUNCE_MS && now_ms - dirty_since < MAX_DEFER_MS {
                continue;
            }
            let counts = (u.snap.working, u.snap.waiting);
            if u.snap.is_idle() {
                u.dirty_since = None;
                if !u.activities.is_empty() {
                    // The tokens stay until the push is confirmed (`sent`): a
                    // failed end must be able to go again.
                    let tokens = u.activities.iter().map(|a| a.token.clone()).collect();
                    u.sent_sig = None;
                    u.sent_counts = None;
                    u.last_update_ms = None;
                    u.last_fresh_ms = None;
                    out.push((user.clone(), LiveAction::End { tokens }, u.snap.clone()));
                }
                continue;
            }
            if !u.activities.is_empty() {
                if u.sent_counts == Some(counts)
                    && u.last_update_ms
                        .is_some_and(|t| now_ms - t < UPDATE_MIN_GAP_MS)
                {
                    // Only the list moved, and one went out a moment ago: stay
                    // dirty and let a later tick send it.
                    continue;
                }
                let grew = counts.1 > u.sent_counts.map_or(0, |(_, w)| w);
                let priority = if grew { 10 } else { 5 };
                u.undo = Some(Undo {
                    kind: LiveKind::Update,
                    sent_counts: u.sent_counts,
                    sent_sig: u.sent_sig.clone(),
                    last_update_ms: u.last_update_ms,
                    last_start_ms: u.last_start_ms,
                    unconfirmed_start_ms: u.unconfirmed_start_ms,
                });
                u.sent_counts = Some(counts);
                u.sent_sig = u.sig.clone();
                u.last_update_ms = Some(now_ms);
                u.last_fresh_ms = Some(now_ms);
                u.dirty_since = None;
                out.push((
                    user.clone(),
                    LiveAction::Update {
                        tokens: u.activities.iter().map(|a| a.token.clone()).collect(),
                        priority,
                    },
                    u.snap.clone(),
                ));
                continue;
            }
            if u.start_tokens.is_empty() {
                u.dirty_since = None;
                continue;
            }
            // Stay dirty: this start is owed as soon as the gap or the hold lifts.
            if u.last_start_ms
                .is_some_and(|t| now_ms - t < START_MIN_GAP_MS)
                || u.unconfirmed_start_ms
                    .is_some_and(|t| now_ms - t < UNCONFIRMED_START_HOLD_MS)
            {
                continue;
            }
            u.dirty_since = None;
            u.undo = Some(Undo {
                kind: LiveKind::Start,
                sent_counts: u.sent_counts,
                sent_sig: u.sent_sig.clone(),
                last_update_ms: u.last_update_ms,
                last_start_ms: u.last_start_ms,
                unconfirmed_start_ms: u.unconfirmed_start_ms,
            });
            u.last_start_ms = Some(now_ms);
            u.unconfirmed_start_ms = Some(now_ms);
            u.last_fresh_ms = Some(now_ms);
            u.sent_counts = Some(counts);
            u.sent_sig = u.sig.clone();
            out.push((
                user.clone(),
                LiveAction::Start {
                    tokens: u.start_tokens.clone(),
                },
                u.snap.clone(),
            ));
        }
        out
    }
}

// -------------------------------------------------------------- the push

/// The APNs `priority` and JSON body of one Live Activity push.
pub fn request(action: &LiveAction, snap: &Snapshot, now_ms: i64) -> (u8, Value) {
    let now_s = now_ms / 1000;
    let state = snap.content_state(now_ms);
    let mut aps = json!({
        "timestamp": now_s,
        "content-state": state,
    });
    let priority = match action {
        LiveAction::Start { .. } => {
            aps["event"] = json!("start");
            aps["attributes-type"] = json!(ATTRIBUTES_TYPE);
            aps["attributes"] = json!({});
            // iOS 18+: without this the started activity gets no push token,
            // and the hub could never update or end it (docs/WATCH.md §5).
            aps["input-push-token"] = json!(1);
            aps["stale-date"] = json!(now_s + STALE_AFTER_S);
            aps["alert"] = json!({
                "title": "Hegai Code",
                "body": summary_line(snap),
                "sound": "default",
            });
            10
        }
        LiveAction::Update { priority, .. } => {
            aps["event"] = json!("update");
            aps["stale-date"] = json!(now_s + STALE_AFTER_S);
            *priority
        }
        LiveAction::End { .. } => {
            aps["event"] = json!("end");
            aps["dismissal-date"] = json!(now_s + DISMISS_AFTER_S);
            5
        }
    };
    (priority, json!({ "aps": aps }))
}

fn summary_line(snap: &Snapshot) -> String {
    match (snap.waiting, snap.working) {
        (0, w) => format!("Работают: {w}"),
        (n, 0) => format!("Ждут вас: {n}"),
        (n, w) => format!("Ждут вас: {n} · работают: {w}"),
    }
}

// ------------------------------------------------------------ persistence

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenRow {
    pub user_id: String,
    /// None => a push-to-start token.
    pub activity_id: Option<String>,
    pub token: String,
}

pub(crate) fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS live_activity_tokens (
          user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
          token       TEXT NOT NULL,
          activity_id TEXT,
          updated_ms  INTEGER NOT NULL,
          PRIMARY KEY (user_id, token)
        );
        CREATE TABLE IF NOT EXISTS live_activity_pending_start (
          user_id    TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
          started_ms INTEGER NOT NULL
        );
        "#,
    )
    .map_err(db_err)
}

pub fn token_ok(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= TOKEN_MAX_LEN
        && token.bytes().all(|b| b.is_ascii_hexdigit())
}
pub fn id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= ID_MAX_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}

impl LiveRegistry {
    /// What a hub start rebuilds: the tokens and the starts still unanswered.
    /// A store that cannot answer starts empty; the activity then cannot be
    /// updated until the phone registers again.
    pub(crate) fn from_store(store: &WorkspaceStore) -> LiveRegistry {
        let mut live = LiveRegistry::load(store.live_tokens_all().unwrap_or_default());
        for (user, started_ms) in store.live_pending_starts_all().unwrap_or_default() {
            live.restore_unconfirmed_start(&user, started_ms);
        }
        live
    }
}

impl WorkspaceStore {
    pub(crate) fn live_token_put(
        &self,
        user_id: &str,
        token: &str,
        activity_id: Option<&str>,
        now_ms: i64,
    ) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        // A token belongs to one person: whoever signed in on the device last.
        conn.execute(
            "DELETE FROM live_activity_tokens WHERE token=?1 AND user_id<>?2",
            params![token, user_id],
        )
        .map_err(db_err)?;
        if let Some(id) = activity_id {
            // One activity per id: a rotated token replaces the old row.
            conn.execute(
                "DELETE FROM live_activity_tokens WHERE user_id=?1 AND activity_id=?2",
                params![user_id, id],
            )
            .map_err(db_err)?;
        }
        conn.execute(
            "INSERT INTO live_activity_tokens(user_id,token,activity_id,updated_ms) VALUES(?1,?2,?3,?4)
             ON CONFLICT(user_id,token) DO UPDATE SET activity_id=excluded.activity_id, updated_ms=excluded.updated_ms",
            params![user_id, token, activity_id, now_ms],
        )
        .map_err(db_err)?;
        // Bounded per kind: the newest stay.
        for (is_activity, cap) in [(false, START_TOKENS_MAX), (true, ACTIVITY_TOKENS_MAX)] {
            let filter = if is_activity {
                "activity_id IS NOT NULL"
            } else {
                "activity_id IS NULL"
            };
            conn.execute(
                &format!(
                    "DELETE FROM live_activity_tokens WHERE user_id=?1 AND {filter} AND rowid NOT IN (
                       SELECT rowid FROM live_activity_tokens WHERE user_id=?1 AND {filter}
                       ORDER BY updated_ms DESC, rowid DESC LIMIT ?2)"
                ),
                params![user_id, cap as i64],
            )
            .map_err(db_err)?;
        }
        Ok(())
    }

    pub(crate) fn live_token_delete_activity(
        &self,
        user_id: &str,
        activity_id: &str,
    ) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.execute(
            "DELETE FROM live_activity_tokens WHERE user_id=?1 AND activity_id=?2",
            params![user_id, activity_id],
        )
        .map_err(db_err)?;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn live_token_delete(&self, token: &str) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.execute(
            "DELETE FROM live_activity_tokens WHERE token=?1",
            params![token],
        )
        .map_err(db_err)?;
        Ok(())
    }

    /// Sign-out: these tokens (start and activity) leave every user.
    pub(crate) fn live_tokens_delete_many(&self, tokens: &[String]) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        for token in tokens {
            conn.execute(
                "DELETE FROM live_activity_tokens WHERE token=?1",
                params![token],
            )
            .map_err(db_err)?;
        }
        Ok(())
    }

    /// Mirror `LiveRegistry::unconfirmed_start`: a value is stored, None clears.
    pub(crate) fn live_pending_start_set(
        &self,
        user_id: &str,
        started_ms: Option<i64>,
    ) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        match started_ms {
            Some(ms) => conn.execute(
                "INSERT INTO live_activity_pending_start(user_id,started_ms) VALUES(?1,?2)
                 ON CONFLICT(user_id) DO UPDATE SET started_ms=excluded.started_ms",
                params![user_id, ms],
            ),
            None => conn.execute(
                "DELETE FROM live_activity_pending_start WHERE user_id=?1",
                params![user_id],
            ),
        }
        .map_err(db_err)?;
        Ok(())
    }

    pub(crate) fn live_pending_starts_all(&self) -> Result<Vec<(String, i64)>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare("SELECT user_id,started_ms FROM live_activity_pending_start")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(db_err)?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub(crate) fn live_tokens_all(&self) -> Result<Vec<TokenRow>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT user_id,token,activity_id FROM live_activity_tokens ORDER BY updated_ms,rowid",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(TokenRow {
                    user_id: r.get(0)?,
                    token: r.get(1)?,
                    activity_id: r.get(2)?,
                })
            })
            .map_err(db_err)?;
        Ok(rows.filter_map(Result::ok).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(working: u32, waiting: u32) -> Snapshot {
        Snapshot {
            working,
            waiting,
            items: vec![Item {
                title: "run".into(),
                state: if waiting > 0 {
                    "needs_attention"
                } else {
                    "working"
                }
                .into(),
                since_ms: 1000,
                plan: None,
            }],
        }
    }

    fn registry() -> LiveRegistry {
        let mut r = LiveRegistry::default();
        r.add_start("u", "aa11");
        r
    }

    #[test]
    fn nothing_is_sent_before_the_debounce_then_one_start() {
        let mut r = registry();
        r.observe("u", snap(1, 0), 0);
        assert!(r.due(2_999).is_empty());
        let due = r.due(3_000);
        assert_eq!(due.len(), 1);
        assert_eq!(
            due[0].1,
            LiveAction::Start {
                tokens: vec!["aa11".into()]
            }
        );
        // Not again: nothing changed since.
        assert!(r.due(10_000).is_empty());
    }

    #[test]
    fn a_change_inside_the_window_restarts_it_but_not_past_the_cap() {
        let mut r = registry();
        r.observe("u", snap(1, 0), 0);
        r.observe("u", snap(2, 0), 2_000);
        assert!(r.due(4_000).is_empty(), "debounce restarted at 2 s");
        assert_eq!(r.due(5_000).len(), 1);

        let mut r = registry();
        // A fleet that never calms down is still announced within 15 s.
        for t in (0..=14).map(|s| s * 1_000) {
            r.observe("u", snap(1 + (t / 1000) as u32, 0), t);
            assert!(r.due(t).is_empty() || t >= MAX_DEFER_MS);
        }
        r.observe("u", snap(30, 0), 15_000);
        assert_eq!(r.due(15_000).len(), 1);
    }

    #[test]
    fn a_start_without_an_activity_token_holds_back_the_next_one() {
        let mut r = registry();
        r.observe("u", snap(1, 0), 0);
        assert_eq!(r.due(3_000).len(), 1);
        assert_eq!(r.unconfirmed_start("u"), Some(3_000));
        // Idle, then busy again a minute later: no second start yet.
        r.observe("u", Snapshot::default(), 60_000);
        assert!(r.due(63_000).is_empty());
        r.observe("u", snap(1, 0), 120_000);
        assert!(r.due(123_000).is_empty());
        // The 04.11 stack: every later run started another frozen card.
        r.observe("u", snap(2, 0), 700_000);
        assert!(r.due(703_000).is_empty());
        // iOS has ended the first card by now.
        r.observe("u", snap(3, 0), UNCONFIRMED_START_HOLD_MS + 4_000);
        let due = r.due(UNCONFIRMED_START_HOLD_MS + 7_000);
        assert!(matches!(due[0].1, LiveAction::Start { .. }));
    }

    #[test]
    fn a_start_held_back_goes_when_the_hold_lifts_without_another_change() {
        let mut r = registry();
        r.observe("u", snap(1, 0), 0);
        assert_eq!(r.due(3_000).len(), 1);
        r.observe("u", snap(2, 0), 700_000);
        assert!(r.due(703_000).is_empty());
        // The phone says it has no cards; the run has not changed since.
        r.activity_ended("u", NO_CARDS_ID);
        let due = r.due(704_000);
        assert!(matches!(due[0].1, LiveAction::Start { .. }), "{due:?}");
    }

    #[test]
    fn no_cards_owes_an_unchanged_run_a_start_but_a_dismissed_card_does_not() {
        let mut r = registry();
        r.observe("u", snap(1, 0), 0);
        assert_eq!(r.due(3_000).len(), 1);
        r.activity_ended("u", NO_CARDS_ID);
        assert!(r.due(4_000).is_empty(), "the ten-minute gap still applies");
        let due = r.due(3_000 + START_MIN_GAP_MS);
        assert!(matches!(due[0].1, LiveAction::Start { .. }), "{due:?}");

        let mut r = registry();
        r.observe("u", snap(1, 0), 0);
        assert_eq!(r.due(3_000).len(), 1);
        r.activity_ended("u", "a-dismissed-card");
        assert!(r.due(3_000 + START_MIN_GAP_MS).is_empty());
    }

    #[test]
    fn an_unchanged_run_gets_a_new_card_once_the_old_one_is_past_its_life() {
        let mut r = registry();
        r.observe("u", snap(1, 0), 0);
        assert_eq!(r.due(3_000).len(), 1);
        assert!(r.due(UNCONFIRMED_START_HOLD_MS).is_empty());
        let due = r.due(3_000 + UNCONFIRMED_START_HOLD_MS);
        assert!(matches!(due[0].1, LiveAction::Start { .. }), "{due:?}");
        assert!(r.due(4_000 + UNCONFIRMED_START_HOLD_MS).is_empty());
    }

    #[test]
    fn a_confirmed_or_ended_activity_lifts_the_hold_on_the_next_start() {
        // The ten-minute gap still applies; only the eight-hour hold goes.
        let mut r = registry();
        r.observe("u", snap(1, 0), 0);
        assert_eq!(r.due(3_000).len(), 1);
        r.set_activity("u", "a1", "bb22");
        assert_eq!(r.unconfirmed_start("u"), None);

        let mut r = registry();
        r.observe("u", snap(1, 0), 0);
        assert_eq!(r.due(3_000).len(), 1);
        r.activity_ended("u", "never-registered");
        assert_eq!(r.unconfirmed_start("u"), None);
        r.observe("u", snap(2, 0), 700_000);
        let due = r.due(703_000);
        assert!(matches!(due[0].1, LiveAction::Start { .. }));
    }

    #[test]
    fn a_start_that_reached_no_phone_holds_nothing_back() {
        let mut r = registry();
        r.observe("u", snap(1, 0), 0);
        assert_eq!(r.due(3_000).len(), 1);
        r.sent(
            "u",
            LiveKind::Start,
            &[("aa11".to_string(), LiveOutcome::Transient)],
            3_500,
        );
        assert_eq!(r.unconfirmed_start("u"), None);
        // ... and one that did keeps it.
        let due = r.due(3_500 + RETRY_BACKOFF_MS);
        assert!(matches!(due[0].1, LiveAction::Start { .. }));
        r.sent(
            "u",
            LiveKind::Start,
            &[("aa11".to_string(), LiveOutcome::Ok)],
            19_000,
        );
        assert_eq!(r.unconfirmed_start("u"), Some(3_500 + RETRY_BACKOFF_MS));
    }

    #[test]
    fn a_long_run_refreshes_the_stale_date_and_an_idle_or_unknown_one_does_not() {
        let mut r = registry();
        r.observe("u", snap(1, 0), 0);
        assert_eq!(r.due(3_000).len(), 1);
        // No token: nothing can be refreshed, the card goes stale by itself.
        assert!(r.due(3_000 + HEARTBEAT_MS).is_empty());
        r.set_activity("u", "a1", "bb22");
        let due = r.due(3_000 + HEARTBEAT_MS);
        assert!(
            matches!(due[0].1, LiveAction::Update { priority: 5, .. }),
            "{due:?}"
        );
        assert!(r.due(3_000 + HEARTBEAT_MS + 1_000).is_empty());
        let due = r.due(3_000 + 2 * HEARTBEAT_MS);
        assert_eq!(due.len(), 1);
        // Idle: one end, and no heartbeat after it.
        r.observe("u", Snapshot::default(), 3_000 + 2 * HEARTBEAT_MS + 1);
        let due = r.due(3_000 + 2 * HEARTBEAT_MS + 4_000);
        assert!(matches!(due[0].1, LiveAction::End { .. }));
        assert!(r.due(3_000 + 4 * HEARTBEAT_MS).is_empty());
    }

    #[test]
    fn with_an_activity_token_counts_update_immediately_and_priority_follows_waiting() {
        let mut r = registry();
        r.set_activity("u", "act-1", "bb22");
        r.observe("u", snap(1, 0), 0);
        let due = r.due(3_000);
        assert_eq!(
            due[0].1,
            LiveAction::Update {
                tokens: vec!["bb22".into()],
                priority: 5
            },
            "the working count rose, nobody started waiting"
        );
        // Working count moves, waiting unchanged: low priority, immediate.
        r.observe("u", snap(2, 0), 4_000);
        let due = r.due(7_000);
        assert_eq!(
            due[0].1,
            LiveAction::Update {
                tokens: vec!["bb22".into()],
                priority: 5
            }
        );
        // Someone starts waiting: high priority.
        r.observe("u", snap(1, 1), 8_000);
        let due = r.due(11_000);
        assert_eq!(
            due[0].1,
            LiveAction::Update {
                tokens: vec!["bb22".into()],
                priority: 10
            }
        );
    }

    #[test]
    fn updates_with_unchanged_counts_wait_fifteen_seconds() {
        let mut r = registry();
        r.set_activity("u", "act-1", "bb22");
        r.observe("u", snap(1, 0), 0);
        assert_eq!(r.due(3_000).len(), 1);
        // Same counts, another title: held back until 15 s after the last one.
        let mut s = snap(1, 0);
        s.items[0].title = "other".into();
        r.observe("u", s, 4_000);
        assert!(r.due(7_000).is_empty());
        assert!(r.due(17_999).is_empty());
        assert_eq!(r.due(18_000).len(), 1);
        assert!(r.due(40_000).is_empty());
    }

    #[test]
    fn idle_fleet_ends_the_activity_once_and_only_if_there_was_one() {
        let mut r = registry();
        r.set_activity("u", "act-1", "bb22");
        r.observe("u", snap(1, 0), 0);
        r.due(3_000);
        r.observe("u", Snapshot::default(), 10_000);
        let due = r.due(13_000);
        assert_eq!(
            due[0].1,
            LiveAction::End {
                tokens: vec!["bb22".into()]
            }
        );
        // Tokens stay until the end is confirmed.
        assert_eq!(r.activities_of("u").len(), 1);
        let dropped = r.sent(
            "u",
            LiveKind::End,
            &[("bb22".into(), LiveOutcome::Ok)],
            13_000,
        );
        assert_eq!(dropped, vec!["bb22".to_string()]);
        assert!(r.activities_of("u").is_empty());
        // Nothing more once idle; and an idle fleet without an activity is silent.
        assert!(r.due(60_000).is_empty());
        let mut quiet = registry();
        quiet.observe("u", Snapshot::default(), 0);
        assert!(quiet.due(5_000).is_empty());
    }

    #[test]
    fn registering_an_activity_does_not_trigger_a_duplicate_update() {
        let mut r = registry();
        r.observe("u", snap(1, 0), 0);
        assert!(matches!(r.due(3_000)[0].1, LiveAction::Start { .. }));
        r.set_activity("u", "act-1", "bb22");
        r.observe("u", snap(1, 0), 4_000); // same signature: not a change
        assert!(r.due(8_000).is_empty());
    }

    #[test]
    fn app_ended_and_apns_refusals_drop_tokens() {
        let mut r = registry();
        r.set_activity("u", "act-1", "bb22");
        assert!(!r.activity_ended("u", "other"));
        assert!(r.activity_ended("u", "act-1"));
        assert!(r.activities_of("u").is_empty());
        r.set_activity("u", "act-2", "cc33");
        r.forget_token("cc33");
        r.forget_token("aa11");
        assert!(r.activities_of("u").is_empty());
        assert!(r.start_tokens_of("u").is_empty());
    }

    #[test]
    fn push_bodies_follow_the_contract() {
        let s = snap(2, 1);
        let (prio, start) = request(
            &LiveAction::Start {
                tokens: vec!["aa".into()],
            },
            &s,
            1_800_000_000_000,
        );
        assert_eq!(prio, 10);
        let aps = &start["aps"];
        assert_eq!(aps["event"], "start");
        assert_eq!(aps["timestamp"], 1_800_000_000);
        assert_eq!(aps["attributes-type"], "HegaiFleetAttributes");
        assert_eq!(aps["attributes"], json!({}));
        assert_eq!(aps["input-push-token"], 1);
        assert_eq!(aps["stale-date"], 1_800_000_000 + 1200);
        assert_eq!(aps["alert"]["title"], "Hegai Code");
        assert_eq!(
            aps["content-state"],
            json!({
                "working": 2, "waiting": 1,
                "items": [{"title": "run", "state": "needs_attention", "sinceMs": 1000}],
                "updatedMs": 1_800_000_000_000i64,
            })
        );

        let (prio, upd) = request(
            &LiveAction::Update {
                tokens: vec!["bb".into()],
                priority: 5,
            },
            &s,
            1_800_000_000_000,
        );
        assert_eq!(prio, 5);
        assert_eq!(upd["aps"]["event"], "update");
        assert_eq!(upd["aps"]["stale-date"], 1_800_000_000 + 1200);
        assert!(upd["aps"].get("alert").is_none() && upd["aps"].get("attributes").is_none());

        let (_, end) = request(
            &LiveAction::End {
                tokens: vec!["bb".into()],
            },
            &Snapshot::default(),
            1_800_000_000_000,
        );
        assert_eq!(end["aps"]["event"], "end");
        assert_eq!(end["aps"]["dismissal-date"], 1_800_000_000 + 600);
        assert!(end["aps"].get("stale-date").is_none());
    }

    #[test]
    fn snapshot_lists_waiting_first_newest_first_and_at_most_five() {
        let runs: Vec<(String, &str, i64)> = vec![
            ("w-old".into(), "working", 10),
            ("w-new".into(), "working", 50),
            ("w-3".into(), "working", 30),
            ("w-4".into(), "working", 5),
            ("ask-old".into(), "needs_attention", 20),
            ("ask-new".into(), "needs_attention", 40),
            ("idle".into(), "idle", 99),
        ];
        let s = snapshot_of(&runs);
        assert_eq!((s.working, s.waiting), (4, 2));
        let titles: Vec<&str> = s.items.iter().map(|i| i.title.as_str()).collect();
        assert_eq!(titles, vec!["ask-new", "ask-old", "w-new", "w-3", "w-old"]);
        assert_eq!(s.items[0].state, "needs_attention");
    }

    #[test]
    fn a_plan_rides_its_row_and_counts_as_a_change() {
        let runs = vec![
            ("planned".to_string(), "working", 10, Some((2, 5))),
            ("plain".to_string(), "working", 5, None),
        ];
        let s = snapshot_with_plans(&runs);
        let state = s.content_state(1);
        assert_eq!(state["items"][0]["planDone"], 2);
        assert_eq!(state["items"][0]["planTotal"], 5);
        assert!(
            state["items"][1].get("planDone").is_none(),
            "absent, never null"
        );
        let mut moved = runs.clone();
        moved[0].3 = Some((3, 5));
        assert_ne!(
            s.signature(),
            snapshot_with_plans(&moved).signature(),
            "a step done is news for the card"
        );
    }

    #[test]
    fn tokens_persist_and_come_back_in_order() {
        let ws = WorkspaceStore::open_memory();
        ws.ensure_user("u", "u@example.com", None).unwrap();
        ws.live_token_put("u", "aa11", None, 1).unwrap();
        ws.live_token_put("u", "bb22", Some("act-1"), 2).unwrap();
        // A rotated activity token replaces the row of the same activity.
        ws.live_token_put("u", "cc33", Some("act-1"), 3).unwrap();
        let reg = LiveRegistry::load(ws.live_tokens_all().unwrap());
        assert_eq!(reg.start_tokens_of("u"), vec!["aa11".to_string()]);
        assert_eq!(reg.activities_of("u")[0].token, "cc33");
        ws.live_token_delete_activity("u", "act-1").unwrap();
        ws.live_token_delete("aa11").unwrap();
        assert!(ws.live_tokens_all().unwrap().is_empty());
    }

    #[test]
    fn token_and_id_shapes_are_checked() {
        assert!(token_ok("00ff"));
        assert!(!token_ok(""));
        assert!(!token_ok("xyz"));
        assert!(!token_ok(&"a".repeat(513)));
        assert!(id_ok("ABC-123_x.y"));
        assert!(!id_ok("a/b"));
        assert!(!id_ok(""));
    }

    #[test]
    fn an_activity_registered_after_the_fleet_went_idle_is_ended_not_forgotten() {
        let mut r = registry();
        r.observe("u", snap(1, 0), 0);
        assert!(matches!(r.due(3_000)[0].1, LiveAction::Start { .. }));
        // The run ended between the push-to-start and the activity token.
        r.observe("u", Snapshot::default(), 4_000);
        assert!(r.due(8_000).is_empty(), "no activity yet: nothing to end");
        r.set_activity("u", "act-1", "bb22");
        r.observe("u", Snapshot::default(), 9_000);
        assert_eq!(
            r.due(12_000)[0].1,
            LiveAction::End {
                tokens: vec!["bb22".into()]
            }
        );
    }

    #[test]
    fn an_activity_registered_after_the_fleet_changed_gets_an_update() {
        let mut r = registry();
        r.observe("u", snap(1, 0), 0);
        r.due(3_000);
        r.observe("u", snap(1, 1), 4_000);
        r.set_activity("u", "act-1", "bb22");
        r.observe("u", snap(1, 1), 5_000);
        assert!(matches!(r.due(8_000)[0].1, LiveAction::Update { .. }));
    }

    #[test]
    fn several_activities_all_get_updates_and_ends_and_ended_removes_one() {
        let mut r = registry();
        r.set_activity("u", "a1", "bb22");
        r.set_activity("u", "a2", "cc33");
        r.set_activity("u", "a1", "dd44"); // rotated token replaces a1's
        r.observe("u", snap(1, 0), 0);
        let LiveAction::Update { tokens, .. } = &r.due(3_000)[0].1 else {
            panic!("update expected");
        };
        assert_eq!(tokens, &vec!["cc33".to_string(), "dd44".to_string()]);
        assert!(r.activity_ended("u", "a2"));
        assert_eq!(r.activities_of("u").len(), 1);
        r.observe("u", Snapshot::default(), 20_000);
        assert_eq!(
            r.due(24_000)[0].1,
            LiveAction::End {
                tokens: vec!["dd44".into()]
            }
        );
    }

    #[test]
    fn activity_tokens_are_bounded_per_user() {
        let mut r = LiveRegistry::default();
        for i in 0..10 {
            r.set_activity("u", &format!("a{i}"), &format!("{i:02x}"));
        }
        assert_eq!(r.activities_of("u").len(), ACTIVITY_TOKENS_MAX);
        assert_eq!(r.activities_of("u").last().unwrap().id, "a9");
    }

    #[test]
    fn a_token_moves_to_the_latest_user_and_signout_drops_it_everywhere() {
        let ws = WorkspaceStore::open_memory();
        ws.ensure_user("u1", "a@example.com", None).unwrap();
        ws.ensure_user("u2", "b@example.com", None).unwrap();
        ws.live_token_put("u1", "aa11", None, 1).unwrap();
        ws.live_token_put("u1", "bb22", Some("act"), 2).unwrap();
        ws.live_token_put("u2", "aa11", None, 3).unwrap();
        ws.live_token_put("u2", "bb22", Some("act"), 4).unwrap();
        let rows = ws.live_tokens_all().unwrap();
        assert!(rows.iter().all(|r| r.user_id == "u2"), "{rows:?}");
        let mut reg = LiveRegistry::load(rows);
        reg.add_start("u1", "aa11");
        assert!(reg.start_tokens_of("u2").is_empty(), "claimed by u1 now");
        ws.live_tokens_delete_many(&["aa11".into(), "bb22".into()])
            .unwrap();
        assert!(ws.live_tokens_all().unwrap().is_empty());
    }

    #[test]
    fn error_items_serialize_as_error_and_are_not_counted() {
        let runs: Vec<(String, &str, i64)> = vec![
            ("bad".into(), "error", 5),
            ("ask".into(), "needs_attention", 6),
            ("busy".into(), "working", 7),
        ];
        let s = snapshot_of(&runs);
        assert_eq!((s.working, s.waiting), (1, 1));
        let v = s.content_state(9);
        let states: Vec<&str> = v["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["state"].as_str().unwrap())
            .collect();
        assert_eq!(states, vec!["needs_attention", "error", "working"]);
    }

    fn res(t: &str, o: LiveOutcome) -> Vec<(String, LiveOutcome)> {
        vec![(t.to_string(), o)]
    }

    #[test]
    fn a_transient_start_failure_retries_with_backoff_then_gives_up() {
        let mut r = registry();
        r.observe("u", snap(1, 0), 0);
        assert!(matches!(r.due(3_000)[0].1, LiveAction::Start { .. }));
        r.sent(
            "u",
            LiveKind::Start,
            &res("aa11", LiveOutcome::Transient),
            3_100,
        );
        assert!(r.due(10_000).is_empty(), "backoff not over");
        assert!(matches!(r.due(18_100)[0].1, LiveAction::Start { .. }));
        r.sent(
            "u",
            LiveKind::Start,
            &res("aa11", LiveOutcome::Transient),
            18_200,
        );
        assert!(r.due(40_000).is_empty(), "second backoff is 30 s");
        assert!(matches!(r.due(48_200)[0].1, LiveAction::Start { .. }));
        // Third failure: out of attempts, no more.
        r.sent(
            "u",
            LiveKind::Start,
            &res("aa11", LiveOutcome::Transient),
            48_300,
        );
        assert!(r.due(200_000).is_empty());
    }

    #[test]
    fn a_confirmed_start_is_committed() {
        let mut r = registry();
        r.observe("u", snap(1, 0), 0);
        r.due(3_000);
        r.sent("u", LiveKind::Start, &res("aa11", LiveOutcome::Ok), 3_100);
        r.observe("u", snap(2, 0), 4_000);
        // No activity token yet and the start gap holds: nothing re-sent.
        assert!(r.due(8_000).is_empty());
    }

    #[test]
    fn a_transient_update_failure_stays_dirty_and_resends() {
        let mut r = registry();
        r.set_activity("u", "act-1", "bb22");
        r.observe("u", snap(1, 0), 0);
        let LiveAction::Update { .. } = &r.due(3_000)[0].1 else {
            panic!()
        };
        r.sent(
            "u",
            LiveKind::Update,
            &res("bb22", LiveOutcome::Transient),
            3_100,
        );
        assert!(r.due(10_000).is_empty());
        assert!(matches!(r.due(18_100)[0].1, LiveAction::Update { .. }));
        r.sent("u", LiveKind::Update, &res("bb22", LiveOutcome::Ok), 18_200);
        assert!(r.due(60_000).is_empty());
    }

    #[test]
    fn a_failed_end_keeps_its_token_and_retries() {
        let mut r = registry();
        r.set_activity("u", "act-1", "bb22");
        r.observe("u", snap(1, 0), 0);
        r.due(3_000);
        r.observe("u", Snapshot::default(), 10_000);
        assert!(matches!(r.due(13_000)[0].1, LiveAction::End { .. }));
        let dropped = r.sent(
            "u",
            LiveKind::End,
            &res("bb22", LiveOutcome::Transient),
            13_100,
        );
        assert!(dropped.is_empty());
        assert_eq!(r.activities_of("u").len(), 1);
        assert!(r.due(20_000).is_empty());
        let LiveAction::End { tokens } = &r.due(28_100)[0].1 else {
            panic!()
        };
        assert_eq!(tokens, &vec!["bb22".to_string()]);
        let dropped = r.sent("u", LiveKind::End, &res("bb22", LiveOutcome::Ok), 28_200);
        assert_eq!(dropped, vec!["bb22".to_string()]);
        assert!(r.activities_of("u").is_empty());
    }

    #[test]
    fn a_dead_token_is_dropped_for_any_kind() {
        let mut r = registry();
        r.set_activity("u", "act-1", "bb22");
        r.observe("u", snap(1, 0), 0);
        r.due(3_000);
        let dropped = r.sent(
            "u",
            LiveKind::Update,
            &res("bb22", LiveOutcome::Unregistered),
            3_100,
        );
        assert_eq!(dropped, vec!["bb22".to_string()]);
        assert!(r.activities_of("u").is_empty());
        let dropped = r.sent(
            "u",
            LiveKind::Start,
            &res("aa11", LiveOutcome::Unregistered),
            3_200,
        );
        assert_eq!(dropped, vec!["aa11".to_string()]);
        assert!(r.start_tokens_of("u").is_empty());
    }

    #[test]
    fn an_end_that_keeps_failing_is_dropped_after_the_last_attempt() {
        let mut r = registry();
        r.set_activity("u", "act-1", "bb22");
        r.observe("u", snap(1, 0), 0);
        r.due(3_000);
        r.observe("u", Snapshot::default(), 10_000);
        r.due(13_000);
        r.sent(
            "u",
            LiveKind::End,
            &res("bb22", LiveOutcome::Transient),
            13_100,
        );
        r.due(28_100);
        r.sent(
            "u",
            LiveKind::End,
            &res("bb22", LiveOutcome::Transient),
            28_200,
        );
        r.due(60_000);
        let dropped = r.sent(
            "u",
            LiveKind::End,
            &res("bb22", LiveOutcome::Transient),
            60_100,
        );
        assert_eq!(dropped, vec!["bb22".to_string()]);
        assert!(r.activities_of("u").is_empty());
    }
}
