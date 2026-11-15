//! When a run's state change is worth interrupting a person.
//!
//! A third implementation of one rule. The first is `reconcileActivity` in
//! `web/src/central-reducers.ts`; the second is `NotificationEngine.swift` in
//! `CCRemoteKit`. All three have to agree, or the same event notifies twice on
//! one device and not at all on another.
//!
//! The shared clauses, and why each exists:
//!
//! - the state actually CHANGED. The hub re-sends the whole active-run list on
//!   every delta, so most runs in most frames are unchanged and must be silent.
//! - the new state is one of `needs_attention` / `idle` / `error`. Going
//!   `working` is not news.
//! - this is not the FIRST frame. Connecting is not an event: without this, a
//!   restart would toast every session that happens to be waiting.
//! - the run is YOURS. `activity` carries every run the viewer may SEE, and for
//!   a platform admin or anyone holding a team share that is most of the fleet.
//!   On the shared sandbox that meant a toast for every stranger's session.
//!   See `Watcher::is_mine`.
//!
//! What this file adds on top, and what each clause was bought with:
//!
//! - **`attended`.** The window's own visibility, which this connection used to
//!   pass as `None` on the theory that it does not know what the window shows.
//!   It does not — but it can know whether anyone is LOOKING, and being toasted
//!   about the session already on screen is the single loudest complaint this
//!   client had. The in-app board and the rail badge cover the attended case.
//! - **`idle` is not `needs_attention`.** They were one class, and they are not
//!   one thing: `needs_attention` is the agent BLOCKED on a person, which is
//!   the only event that is worth an interruption on its own, while `idle` is
//!   the end of a TURN. Every reply to every message ends a turn. So a finished
//!   run is announced only when the turn was long enough that someone plausibly
//!   walked away (`IDLE_MIN_WORK`), and it is held briefly first
//!   (`IDLE_GRACE`) so a run that immediately goes back to work is never
//!   announced as finished at all.
//! - **Freshness.** No client checked the AGE of the news it was announcing. A
//!   socket that drains a backlog, or a machine waking from sleep, would
//!   announce state changes from an hour ago as if they had just happened.
//! - **A cap.** More news than a person can read as separate toasts becomes one
//!   line that says how much there is.
//!
//! Without the last two, a client that stops draining its socket and then
//! resumes replays every transition it missed as its own interruption — which
//! is exactly what the SPA in this app's own window was doing.
//!
//! And two that are about the HUB forgetting rather than about the person
//! (24.09.2026, «приходит всякий шлак»):
//!
//! - **An appearance is not a transition.** A run that shows up already
//!   waiting, failed or finished was not just asked or just finished — it was
//!   RE-ADOPTED: the hub restarted (every deploy, a dozen a day) or an agent
//!   reconnected, and the run came back with the state it already had. A run
//!   that really starts is born `working` (or `idle` with no message), so no
//!   news is lost by staying quiet about an entrance.
//! - **A prompt is announced once.** The agent re-issues its pending prompt
//!   after every reconnect with the SAME request id, and a hub that lost its
//!   memory walks the run idle → working → needs_attention again. Measured on
//!   the live hub: ~100 agent reconnects and 13 hub restarts in six hours, and
//!   each one re-announced every question already waiting. `asked` remembers
//!   which prompt was seen per run, across socket drops and reconnects, which
//!   is why the `Watcher` now outlives a connection.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use super::wire::{Run, State};

/// How long a turn must have run before its FINISH is worth announcing.
///
/// The number is "did the person plausibly stop watching". A question answered
/// in eight seconds is one you are sitting in front of; a build that ran four
/// minutes is one you walked away from. Below this the run still lands in the
/// app — it is the sound that is withheld, not the fact.
const IDLE_MIN_WORK: Duration = Duration::from_secs(60);

/// How long a finished run is HELD before it is announced.
///
/// A session that goes idle and straight back to working — a turn boundary
/// inside a skill, a compaction, a tool loop — was never finished, and saying
/// so is worse than saying nothing. Long enough to catch that, short enough
/// that a real finish still feels immediate.
const IDLE_GRACE: Duration = Duration::from_secs(4);

/// News older than this is not news.
///
/// It exists for the case nobody designed for: a socket that stopped draining
/// and then caught up, a laptop that slept. Whatever survives the queue gets
/// announced with no idea how old it is, and "сессия готова" about a run that
/// finished forty minutes ago is not information, it is noise wearing the
/// costume of information.
const STALE_ALERT: Duration = Duration::from_secs(120);

/// More than this many pieces of news AT ONCE becomes one toast that counts
/// them.
///
/// Measured per delivery, not over a rolling window, and that is the whole
/// design. A rolling budget sounds stricter and is worse: once spent it either
/// goes silent on real news or degrades a single event into «1 обновление»,
/// which is strictly less than the toast it replaced. The failure being fixed
/// here is not "too many events over a morning", it is "forty transitions
/// arriving in one gulp because the socket stopped draining" — and that is a
/// property of one delivery.
const BURST_MAX: usize = 3;

/// How long a seen prompt is remembered after the run was last observed.
///
/// A question can honestly wait hours for an answer (the agent's own approval
/// deadline is per machine, and some are long), and the memory has to outlive
/// that wait or a restart late in it re-announces the question anyway. It is
/// one short string per run, so a day costs nothing.
const PROMPT_MEMORY: Duration = Duration::from_secs(24 * 60 * 60);

/// A session that failed is said once in this long, however many times it
/// fails again.
///
/// 24.09.2026: the Claude login on one machine broke for half an hour, every
/// turn of three sessions failed, and each retry — a new run, so a new
/// transition — was its own «завершилась ошибкой». The first says everything;
/// the next ones are the same news. Keyed by SESSION, not run: a retry is a
/// fresh run of the same session.
const ERROR_REPEAT: Duration = Duration::from_secs(15 * 60);

/// How much this person wants to be interrupted. Set from the tray menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Policy {
    /// Everything notable: blocked, failed, and finished.
    #[default]
    All,
    /// Only the two where the agent is stopped and cannot continue without a
    /// person — `needs_attention` and `error`. A finished run waits in the app.
    Blocking,
    /// Nothing. The tray badge still counts; only the sound is off.
    Off,
}

impl Policy {
    fn allows(self, state: State) -> bool {
        match self {
            Policy::All => true,
            Policy::Blocking => !matches!(state, State::Idle),
            Policy::Off => false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Alert {
    pub run_id: String,
    pub machine_id: String,
    pub session_id: String,
    pub title: String,
    pub machine_name: Option<String>,
    pub state: State,
    /// What the run is waiting for — carried from `Run::pending_kind` so the
    /// toast can say "ждёт подтверждения" instead of inventing a question.
    pub pending_kind: Option<String>,
    /// When the transition was OBSERVED, which is what `STALE_ALERT` measures.
    at: Instant,
}

impl Alert {
    /// Toast body: which machine, and what happened.
    pub fn body(&self) -> String {
        match self.machine_name.as_deref() {
            Some(m) if !m.is_empty() => format!(
                "{m} · сессия {}",
                self.state.verb_for(self.pending_kind.as_deref())
            ),
            _ => format!(
                "Сессия {}",
                self.state.verb_for(self.pending_kind.as_deref())
            ),
        }
    }
}

/// What the tray is asked to show. Either one run, or a count.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Toast {
    Run(Alert),
    /// A batch too large to read as separate toasts. `waiting` is how many of
    /// them are BLOCKED on a person, because that is the part that decides
    /// whether this is worth opening now or later.
    Digest { count: usize, waiting: usize },
}

impl Toast {
    /// The toast's heading. A single run is named; a batch is not, because
    /// naming one of several is how a digest turns back into a lie.
    pub fn title(&self) -> String {
        match self {
            Toast::Run(a) => format!("Hegai Code — {}", a.title),
            Toast::Digest { .. } => "Hegai Code".to_string(),
        }
    }

    /// What it says. A digest leads with how much there is and then with how
    /// much of it is BLOCKED on a person, because that is the part that decides
    /// whether to open it now or after lunch.
    pub fn body(&self) -> String {
        match self {
            Toast::Run(a) => a.body(),
            Toast::Digest { count, waiting: 0 } => {
                format!("{count} {} по вашим сессиям", plural_update(*count))
            }
            // A digest mixes questions and permission prompts, so it says the
            // one thing true of both rather than picking the wrong half.
            Toast::Digest { count, waiting } => format!(
                "{count} {}, {waiting} {} решения",
                plural_update(*count),
                if *waiting == 1 { "ждёт" } else { "ждут" }
            ),
        }
    }

    /// Where opening this toast should land.
    ///
    /// `None` means the app itself rather than a session — a digest names no
    /// single run, and guessing one of them would be worse than the rail.
    ///
    /// Only the WinRT toast can act on this today, because it is the only
    /// backend here that reports a click. The answer is kept on every platform
    /// rather than gated with it: this is the POLICY layer, it is tested as
    /// such, and the day a macOS backend reports activation the fact it needs
    /// is already computed.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn target(&self) -> Option<(&str, &str)> {
        match self {
            Toast::Run(a) => Some((a.machine_id.as_str(), a.session_id.as_str())),
            Toast::Digest { .. } => None,
        }
    }
}

/// Russian plural for «обновление». Three forms, and the teens are the trap:
/// 11 takes the same form as 5, not as 1.
fn plural_update(n: usize) -> &'static str {
    let (tens, ones) = (n % 100, n % 10);
    if (11..=14).contains(&tens) {
        "обновлений"
    } else {
        match ones {
            1 => "обновление",
            2..=4 => "обновления",
            _ => "обновлений",
        }
    }
}

/// What a run was doing last time we looked, and since when.
#[derive(Debug, Clone, Copy)]
struct Seen {
    state: State,
    /// When this state was first observed — the age of the CURRENT state, not
    /// of the run. `IDLE_MIN_WORK` reads this off the previous entry to learn
    /// how long the turn that just ended had been running.
    since: Instant,
    /// The viewer's own run — the only kind the badge counts.
    mine: bool,
}

/// An `idle` waiting out its grace period. See `IDLE_GRACE`.
struct Held {
    alert: Alert,
    ready_at: Instant,
}

#[derive(Default)]
pub struct Watcher {
    seen: HashMap<String, Seen>,
    /// False until the first frame OF THIS CONNECTION has been folded in.
    seeded: bool,
    /// Who is looking, out of the `snapshot`'s viewer. See `is_mine`.
    viewer_id: Option<String>,
    held: Vec<Held>,
    /// The prompt each run was last seen stopped on, and when it was last
    /// seen. Survives the run vanishing from the list and the socket
    /// reconnecting — that is its whole point. See the module note.
    asked: HashMap<String, (String, Instant)>,
    /// When each session last failed out loud. See `ERROR_REPEAT`.
    failed: HashMap<String, Instant>,
}

impl Watcher {
    pub fn new() -> Self {
        Self::default()
    }

    /// A new socket to the hub. Its first frame seeds again — connecting is
    /// not an event — but what this watcher knows about prompts it has
    /// already seen is kept, because a reconnect is exactly when the same
    /// prompts come back.
    pub fn reconnected(&mut self) {
        self.seeded = false;
    }

    /// Remember whose socket this is. Called from the `snapshot`, which the hub
    /// sends on connect — so in practice the viewer is known before the first
    /// `activity` delta, and a reconnect builds a fresh `Watcher` rather than
    /// carrying the previous sign-in's identity forward.
    pub fn set_viewer(&mut self, user_id: &str) {
        self.viewer_id = Some(user_id.to_string());
    }

    /// Is this run the viewer's own?
    ///
    /// The web and the phone write this as `run.ownerUserId === viewerId`, and
    /// comparing the two `Option`s is that same expression. What the other two
    /// add is a `viewerId` non-null guard, which makes them silent until the
    /// snapshot lands; this one deliberately leaves it out.
    ///
    /// The difference only shows against a hub that never names a viewer at
    /// all, and there the guard costs more here than it does there: the web is
    /// a screen someone is looking at, so its silence gets noticed, while a
    /// tray that quietly stops toasting is a background process nobody hears go
    /// quiet. Without the guard that case — an unowned run and no viewer — is
    /// the single-user hub, where the run IS yours. It cannot leak a
    /// colleague's session either, because a colleague's run always names its
    /// owner, and a named owner never matches an unknown viewer.
    fn is_mine(&self, run: &Run) -> bool {
        run.owner_user_id == self.viewer_id
    }

    /// Fold in a run list and return what deserves a toast.
    ///
    /// `attended` is "someone is looking at this app right now" — the window
    /// visible AND focused. It is not per-session, because this connection
    /// genuinely cannot know which session the window shows; what it can know
    /// is that the app is on screen, and an app on screen reports attention
    /// itself, in the rail and on the board.
    pub fn ingest(
        &mut self,
        runs: &[Run],
        attended: bool,
        policy: Policy,
        now: Instant,
    ) -> Vec<Toast> {
        let mut alerts = Vec::new();
        let mut next = HashMap::with_capacity(runs.len());
        for run in runs {
            let previous = self.seen.get(&run.run_id).copied();
            let changed = previous.map(|p| p.state) != Some(run.state);
            // `since` is the age of the STATE. Carry it forward when nothing
            // moved, or the "how long was this turn" question below could never
            // answer anything but "no time at all" — the hub re-sends the whole
            // list on every delta, so an unchanged run is re-seen constantly.
            let since = match previous {
                Some(p) if !changed => p.since,
                _ => now,
            };
            let mine = self.is_mine(run);
            next.insert(run.run_id.clone(), Seen { state: run.state, since, mine });

            // Is this a prompt we have already seen? Recorded on EVERY sighting,
            // including the seed frame and frames nobody was toasted for — a
            // prompt the person saw on screen is not news once they look away.
            let repeat_prompt = match (run.state, run.pending_request_id.as_deref()) {
                (State::NeedsAttention, Some(req)) => {
                    let known = self.asked.get(&run.run_id).is_some_and(|(r, _)| r == req);
                    self.asked.insert(run.run_id.clone(), (req.to_string(), now));
                    known
                }
                _ => false,
            };

            if !self.seeded
                // An entrance, not a transition — see the module note.
                || previous.is_none()
                || !changed
                || repeat_prompt
                || !run.state.is_notable()
                || !self.is_mine(run)
            {
                continue;
            }
            if run.state == State::Error {
                let key = format!("{}::{}", run.machine_id, run.session_id);
                let recent = self
                    .failed
                    .get(&key)
                    .is_some_and(|at| now.saturating_duration_since(*at) < ERROR_REPEAT);
                if recent {
                    continue;
                }
                self.failed.insert(key, now);
            }
            let alert = Alert {
                run_id: run.run_id.clone(),
                machine_id: run.machine_id.clone(),
                session_id: run.session_id.clone(),
                title: run.label(),
                machine_name: run.machine_name.clone(),
                state: run.state,
                pending_kind: run.pending_kind.clone(),
                at: now,
            };
            if run.state == State::Idle {
                // A turn nobody had time to walk away from is not an event.
                let worked = previous
                    .filter(|p| p.state == State::Working)
                    .map(|p| now.duration_since(p.since))
                    .unwrap_or_default();
                if worked < IDLE_MIN_WORK {
                    continue;
                }
                self.held.push(Held { alert, ready_at: now + IDLE_GRACE });
            } else {
                alerts.push(alert);
            }
        }
        // A held finish whose run has moved on was never a finish. Checked
        // against the frame being folded in, not against `seen`, so a run that
        // vanished from the list is dropped too.
        self.held.retain(|h| {
            next.get(&h.alert.run_id).map(|s| s.state) == Some(State::Idle)
        });
        // A run still in the list keeps its memory fresh; one that has been
        // gone for a day is gone.
        for (run_id, (_, at)) in self.asked.iter_mut() {
            if next.contains_key(run_id) {
                *at = now;
            }
        }
        self.asked
            .retain(|_, (_, at)| now.saturating_duration_since(*at) < PROMPT_MEMORY);
        self.failed
            .retain(|_, at| now.saturating_duration_since(*at) < ERROR_REPEAT);

        self.seen = next;
        self.seeded = true;

        alerts.extend(self.take_ripe(now));
        self.emit(alerts, attended, policy, now)
    }

    /// Release finishes whose grace period has passed.
    ///
    /// Called on a timer as well as on every frame: the hub goes quiet when
    /// nothing is happening, and a run that finished into silence would
    /// otherwise wait for the next unrelated delta to be announced.
    pub fn tick(&mut self, attended: bool, policy: Policy, now: Instant) -> Vec<Toast> {
        let ripe = self.take_ripe(now);
        if ripe.is_empty() {
            return Vec::new();
        }
        self.emit(ripe, attended, policy, now)
    }

    fn take_ripe(&mut self, now: Instant) -> Vec<Alert> {
        let mut out = Vec::new();
        self.held.retain(|h| {
            if h.ready_at > now {
                return true;
            }
            out.push(h.alert.clone());
            false
        });
        out
    }

    /// Apply the three things that are about the PERSON rather than the run:
    /// are they looking, do they want this class of news, and is this more news
    /// than one glance can hold.
    fn emit(
        &mut self,
        alerts: Vec<Alert>,
        attended: bool,
        policy: Policy,
        now: Instant,
    ) -> Vec<Toast> {
        if alerts.is_empty() || attended || policy == Policy::Off {
            return Vec::new();
        }
        let alerts: Vec<Alert> = alerts
            .into_iter()
            .filter(|a| policy.allows(a.state))
            // Stale news is dropped SILENTLY rather than counted into the
            // digest: a digest is an offer to come and look, and there is
            // nothing to look at in a run that finished an hour ago.
            .filter(|a| now.duration_since(a.at) < STALE_ALERT)
            .collect();
        if alerts.is_empty() {
            return Vec::new();
        }

        if alerts.len() > BURST_MAX {
            let waiting = alerts.iter().filter(|a| a.state.is_waiting()).count();
            return vec![Toast::Digest { count: alerts.len(), waiting }];
        }
        alerts.into_iter().map(Toast::Run).collect()
    }

    /// How many of YOUR runs are blocked on you right now — the tray badge.
    ///
    /// Scoped to the viewer, like the toast and the web's bell (30.09.2026, by
    /// request). It used to count the whole fleet, so a platform admin's menu
    /// bar showed «1» for a colleague's session waiting on the colleague —
    /// with the bell empty and nothing of theirs to answer. The board still
    /// shows everyone; the number beside the icon is a call to act, and only
    /// your own runs are yours to act on.
    pub fn waiting(&self) -> usize {
        self.seen.values().filter(|s| s.mine && s.state.is_waiting()).count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A run the hub could not attribute — no `ownerUserId` on the wire.
    fn run(id: &str, state: State) -> Run {
        Run {
            run_id: id.to_string(),
            machine_id: "m1".into(),
            session_id: format!("session-{id}"),
            machine_name: Some("mac-mini".into()),
            title: Some(format!("задача {id}")),
            owner_user_id: None,
            state,
            pending_kind: None,
            pending_request_id: None,
        }
    }

    /// A run stopped on a specific prompt, the way the hub publishes it.
    fn asking(id: &str, request: &str) -> Run {
        Run {
            pending_kind: Some("question".into()),
            pending_request_id: Some(request.to_string()),
            ..run(id, State::NeedsAttention)
        }
    }

    fn owned(id: &str, state: State, owner: &str) -> Run {
        Run {
            owner_user_id: Some(owner.to_string()),
            ..run(id, state)
        }
    }

    /// Unattended, everything allowed — the case every older test assumed.
    fn ingest(w: &mut Watcher, runs: &[Run], now: Instant) -> Vec<Toast> {
        w.ingest(runs, false, Policy::All, now)
    }

    /// A run that worked long enough for its finish to count, then finished.
    /// Returns what the finish produced, grace already waited out.
    fn work_then_finish(w: &mut Watcher, id: &str, t0: Instant) -> Vec<Toast> {
        ingest(w, &[run(id, State::Working)], t0);
        let done = t0 + IDLE_MIN_WORK + Duration::from_secs(1);
        ingest(w, &[run(id, State::Idle)], done);
        w.tick(false, Policy::All, done + IDLE_GRACE)
    }

    fn only(toasts: &[Toast]) -> &Alert {
        match toasts {
            [Toast::Run(a)] => a,
            other => panic!("expected exactly one run toast, got {other:?}"),
        }
    }

    #[test]
    fn connecting_is_not_an_event() {
        // The case this clause exists for: restart the app while three sessions
        // are waiting, and get three toasts for news that is hours old.
        let t0 = Instant::now();
        let mut w = Watcher::new();
        let first = ingest(
            &mut w,
            &[
                run("a", State::NeedsAttention),
                run("b", State::Error),
                run("c", State::Idle),
            ],
            t0,
        );
        assert!(first.is_empty(), "the first frame seeds, it does not notify");
        // But the badge is correct immediately.
        assert_eq!(w.waiting(), 1);
    }

    #[test]
    fn only_a_real_transition_notifies() {
        let t0 = Instant::now();
        let mut w = Watcher::new();
        ingest(&mut w, &[run("a", State::Working)], t0);
        // The hub re-sends every run on every delta; unchanged ones stay quiet.
        assert!(ingest(&mut w, &[run("a", State::Working)], t0).is_empty());
        let alerts = ingest(&mut w, &[run("a", State::NeedsAttention)], t0);
        assert_eq!(only(&alerts).state, State::NeedsAttention);
        // And it does not repeat while it stays there.
        assert!(ingest(&mut w, &[run("a", State::NeedsAttention)], t0).is_empty());
    }

    #[test]
    fn going_busy_is_not_news() {
        let t0 = Instant::now();
        let mut w = Watcher::new();
        ingest(&mut w, &[run("a", State::Idle)], t0);
        assert!(ingest(&mut w, &[run("a", State::Working)], t0).is_empty());
    }

    #[test]
    fn nothing_is_announced_while_someone_is_looking() {
        // The complaint this exists for: a toast about the session on screen.
        let t0 = Instant::now();
        let mut w = Watcher::new();
        w.ingest(&[run("a", State::Working)], true, Policy::All, t0);
        let alerts = w.ingest(&[run("a", State::NeedsAttention)], true, Policy::All, t0);
        assert!(alerts.is_empty(), "the app is on screen and says this itself");
        // Not merely deferred: the same transition does not re-fire on the next
        // frame once the window goes away, because it is no longer a change.
        assert!(ingest(&mut w, &[run("a", State::NeedsAttention)], t0).is_empty());
    }

    #[test]
    fn a_quick_reply_does_not_interrupt_anyone() {
        // Every turn ends. A session you are talking to ends one every few
        // seconds, and announcing each was most of the noise.
        let t0 = Instant::now();
        let mut w = Watcher::new();
        ingest(&mut w, &[run("a", State::Working)], t0);
        let quick = t0 + Duration::from_secs(8);
        assert!(ingest(&mut w, &[run("a", State::Idle)], quick).is_empty());
        assert!(
            w.tick(false, Policy::All, quick + IDLE_GRACE * 2).is_empty(),
            "a short turn is not held for later either — it is simply not news"
        );
    }

    #[test]
    fn a_long_turn_finishing_is_worth_saying() {
        let mut w = Watcher::new();
        let toasts = work_then_finish(&mut w, "a", Instant::now());
        assert_eq!(only(&toasts).state, State::Idle);
    }

    #[test]
    fn a_finish_that_goes_straight_back_to_work_is_never_announced() {
        // Turn boundaries inside a skill, compaction, a tool loop: the run dips
        // through idle and carries on. It was never finished.
        let t0 = Instant::now();
        let mut w = Watcher::new();
        ingest(&mut w, &[run("a", State::Working)], t0);
        let done = t0 + IDLE_MIN_WORK + Duration::from_secs(1);
        assert!(ingest(&mut w, &[run("a", State::Idle)], done).is_empty(), "held, not sent");
        // Back to work inside the grace window.
        ingest(&mut w, &[run("a", State::Working)], done + Duration::from_secs(1));
        assert!(w.tick(false, Policy::All, done + IDLE_GRACE * 4).is_empty());
    }

    #[test]
    fn blocked_and_failed_are_never_held() {
        // The two classes differ: a blocked agent is not doing anything until a
        // person answers, so delaying it delays the work itself.
        let t0 = Instant::now();
        let mut w = Watcher::new();
        ingest(&mut w, &[run("a", State::Working), run("b", State::Working)], t0);
        let alerts = ingest(&mut w, &[run("a", State::NeedsAttention), run("b", State::Error)], t0);
        assert_eq!(alerts.len(), 2, "both immediately, no grace period");
    }

    #[test]
    fn a_backlog_becomes_one_line_instead_of_a_stack() {
        // The bug: a client stops draining its socket, then catches up, and
        // announces every transition it missed as its own interruption.
        let t0 = Instant::now();
        let mut w = Watcher::new();
        let busy: Vec<Run> = (0..12).map(|i| run(&format!("r{i}"), State::Working)).collect();
        ingest(&mut w, &busy, t0);
        let blocked: Vec<Run> = (0..12)
            .map(|i| run(&format!("r{i}"), State::NeedsAttention))
            .collect();
        let toasts = ingest(&mut w, &blocked, t0);
        assert_eq!(toasts, vec![Toast::Digest { count: 12, waiting: 12 }]);
        assert!(toasts[0].target().is_none(), "a digest names no single session");
    }

    #[test]
    fn a_handful_at_once_still_arrives_as_itself() {
        // The cap is for a gulp, not for a busy minute. Three sessions
        // finishing together are three things you can read.
        let t0 = Instant::now();
        let mut w = Watcher::new();
        let ids = ["a", "b", "c"];
        let working: Vec<Run> = ids.iter().map(|i| run(i, State::Working)).collect();
        ingest(&mut w, &working, t0);
        let blocked: Vec<Run> = ids.iter().map(|i| run(i, State::NeedsAttention)).collect();
        let toasts = ingest(&mut w, &blocked, t0);
        assert_eq!(toasts.len(), 3);
        assert!(toasts.iter().all(|t| matches!(t, Toast::Run(_))));
    }

    #[test]
    fn news_that_waited_too_long_is_not_announced() {
        // A finish held while the machine slept. Whatever survives the queue
        // must not be announced as if it had just happened.
        let t0 = Instant::now();
        let mut w = Watcher::new();
        ingest(&mut w, &[run("a", State::Working)], t0);
        let done = t0 + IDLE_MIN_WORK + Duration::from_secs(1);
        ingest(&mut w, &[run("a", State::Idle)], done);
        assert!(w.tick(false, Policy::All, done + STALE_ALERT + Duration::from_secs(1)).is_empty());
    }

    #[test]
    fn the_policy_decides_which_classes_speak() {
        let t0 = Instant::now();
        let mut w = Watcher::new();
        ingest(&mut w, &[run("a", State::Working)], t0);
        assert!(
            w.ingest(&[run("a", State::NeedsAttention)], false, Policy::Off, t0).is_empty(),
            "off is off"
        );

        let mut w = Watcher::new();
        ingest(&mut w, &[run("b", State::Working)], t0);
        let toasts = w.ingest(&[run("b", State::NeedsAttention)], false, Policy::Blocking, t0);
        assert_eq!(toasts.len(), 1, "blocking still hears the thing that blocks");

        // …but not a finish, even a long one.
        let mut w = Watcher::new();
        ingest(&mut w, &[run("c", State::Working)], t0);
        let done = t0 + IDLE_MIN_WORK + Duration::from_secs(1);
        ingest(&mut w, &[run("c", State::Idle)], done);
        assert!(w.tick(false, Policy::Blocking, done + IDLE_GRACE).is_empty());
    }

    #[test]
    fn a_toast_knows_which_session_to_open() {
        // The gap this closes: neither the tray toast nor the web one had a
        // click handler at all, so the one gesture a notification invites did
        // nothing.
        let mut w = Watcher::new();
        let toasts = work_then_finish(&mut w, "a", Instant::now());
        assert_eq!(toasts[0].target(), Some(("m1", "session-a")));
    }

    #[test]
    fn an_unknown_state_is_never_worth_interrupting_someone_for() {
        let t0 = Instant::now();
        let mut w = Watcher::new();
        ingest(&mut w, &[run("a", State::Working)], t0);
        assert!(ingest(&mut w, &[run("a", State::Unknown)], t0).is_empty());
    }

    #[test]
    fn a_colleagues_session_is_none_of_your_business() {
        // The bug this whole clause exists for: on the shared sandbox the hub
        // sends every run the viewer may SEE, and the tray toasted for all of
        // them — seven interruptions in a morning, none of them about you.
        let t0 = Instant::now();
        let mut w = Watcher::new();
        w.set_viewer("u1");
        ingest(
            &mut w,
            &[
                owned("mine", State::Working, "u1"),
                owned("theirs", State::Working, "u2"),
            ],
            t0,
        );
        let alerts = ingest(
            &mut w,
            &[
                owned("mine", State::NeedsAttention, "u1"),
                owned("theirs", State::NeedsAttention, "u2"),
            ],
            t0,
        );
        assert_eq!(only(&alerts).run_id, "mine");
        // The badge counts only yours too: a colleague's question is not a
        // «1» in your menu bar.
        assert_eq!(w.waiting(), 1);
    }

    #[test]
    fn an_owned_run_waits_until_we_know_who_is_looking() {
        let t0 = Instant::now();
        let mut w = Watcher::new();
        ingest(&mut w, &[owned("a", State::Working, "u1")], t0);
        assert!(
            ingest(&mut w, &[owned("a", State::NeedsAttention, "u1")], t0).is_empty(),
            "a named owner cannot match a viewer we have not been told about"
        );
        w.set_viewer("u1");
        assert_eq!(
            ingest(&mut w, &[owned("a", State::Error, "u1")], t0).len(),
            1
        );
    }

    #[test]
    fn a_hub_that_names_nobody_still_speaks() {
        // The deliberate difference from the web and the phone. An unowned run
        // on a hub that never sends a viewer is the single-user setup, and a
        // tray gone silent there has nobody to notice it.
        let t0 = Instant::now();
        let mut w = Watcher::new();
        ingest(&mut w, &[run("a", State::Working)], t0);
        assert_eq!(ingest(&mut w, &[run("a", State::NeedsAttention)], t0).len(), 1);
    }

    #[test]
    fn a_run_that_disappears_and_returns_is_not_news() {
        // The opposite used to be asserted here, and it was most of the noise:
        // a run leaves the list and comes back because the hub restarted or
        // its agent reconnected, not because anything happened to it.
        let t0 = Instant::now();
        let mut w = Watcher::new();
        ingest(&mut w, &[run("a", State::Working)], t0);
        ingest(&mut w, &[run("a", State::NeedsAttention)], t0);
        assert!(ingest(&mut w, &[], t0).is_empty(), "vanishing is not an alert");
        assert_eq!(w.waiting(), 0);
        let back = ingest(&mut w, &[run("a", State::NeedsAttention)], t0);
        assert!(back.is_empty(), "coming back with the state it had is not news");
        assert_eq!(w.waiting(), 1, "but it counts again at once");
    }

    #[test]
    fn a_question_re_issued_after_an_agent_reconnect_is_not_asked_twice() {
        // What the agent sends after its socket blips: `run_status: started`
        // and then the SAME tool_request. A hub older than 24.09.2026 walked
        // the run needs_attention -> working -> needs_attention on it.
        let t0 = Instant::now();
        let mut w = Watcher::new();
        ingest(&mut w, &[run("a", State::Working)], t0);
        assert_eq!(ingest(&mut w, &[asking("a", "req-1")], t0).len(), 1);
        ingest(&mut w, &[run("a", State::Working)], t0);
        assert!(ingest(&mut w, &[asking("a", "req-1")], t0).is_empty());
    }

    #[test]
    fn a_hub_restart_does_not_replay_the_questions_already_waiting() {
        // The deploy case end to end: the socket drops, the new connection's
        // snapshot arrives before the agents are back, and each run is
        // re-adopted as idle, re-announced as working, and asked again.
        let t0 = Instant::now();
        let mut w = Watcher::new();
        ingest(&mut w, &[run("a", State::Working)], t0);
        assert_eq!(ingest(&mut w, &[asking("a", "req-1")], t0).len(), 1);

        w.reconnected();
        assert!(ingest(&mut w, &[], t0).is_empty(), "the new snapshot seeds");
        assert!(ingest(&mut w, &[run("a", State::Idle)], t0).is_empty());
        assert!(ingest(&mut w, &[run("a", State::Working)], t0).is_empty());
        assert!(
            ingest(&mut w, &[asking("a", "req-1")], t0).is_empty(),
            "the question it asked before the restart is not a new one"
        );
    }

    #[test]
    fn a_new_question_on_the_same_run_is_news() {
        let t0 = Instant::now();
        let mut w = Watcher::new();
        ingest(&mut w, &[run("a", State::Working)], t0);
        assert_eq!(ingest(&mut w, &[asking("a", "req-1")], t0).len(), 1);
        ingest(&mut w, &[run("a", State::Working)], t0);
        assert_eq!(ingest(&mut w, &[asking("a", "req-2")], t0).len(), 1);
    }

    #[test]
    fn a_question_seen_on_screen_is_not_announced_when_the_screen_goes_away() {
        let t0 = Instant::now();
        let mut w = Watcher::new();
        w.ingest(&[run("a", State::Working)], true, Policy::All, t0);
        assert!(w.ingest(&[asking("a", "req-1")], true, Policy::All, t0).is_empty());
        // A reconnect while nobody is looking re-issues it.
        w.reconnected();
        ingest(&mut w, &[run("a", State::Working)], t0);
        ingest(&mut w, &[run("a", State::Working)], t0);
        assert!(ingest(&mut w, &[asking("a", "req-1")], t0).is_empty());
    }

    #[test]
    fn a_session_that_keeps_failing_is_said_once() {
        // Each retry is a new run of the same session; only the first failure
        // interrupts anyone, until ERROR_REPEAT has passed.
        let t0 = Instant::now();
        let mut w = Watcher::new();
        let attempt = |id: &str, state| Run { session_id: "s".into(), ..run(id, state) };
        ingest(&mut w, &[attempt("r1", State::Working)], t0);
        assert_eq!(ingest(&mut w, &[attempt("r1", State::Error)], t0).len(), 1);
        ingest(&mut w, &[attempt("r2", State::Working)], t0);
        assert!(ingest(&mut w, &[attempt("r2", State::Error)], t0).is_empty(), "the same news again");
        let later = t0 + ERROR_REPEAT + Duration::from_secs(1);
        ingest(&mut w, &[attempt("r3", State::Working)], later);
        assert_eq!(ingest(&mut w, &[attempt("r3", State::Error)], later).len(), 1, "but not forever");
    }

    #[test]
    fn prompt_memory_is_forgotten_a_day_after_the_run_is_gone() {
        let t0 = Instant::now();
        let mut w = Watcher::new();
        ingest(&mut w, &[asking("a", "req-1")], t0);
        assert_eq!(w.asked.len(), 1);
        ingest(&mut w, &[], t0 + Duration::from_secs(60));
        ingest(&mut w, &[], t0 + PROMPT_MEMORY + Duration::from_secs(120));
        assert!(w.asked.is_empty());
    }

    #[test]
    fn the_badge_counts_only_what_is_blocked_on_a_person() {
        let t0 = Instant::now();
        let mut w = Watcher::new();
        ingest(
            &mut w,
            &[
                run("a", State::NeedsAttention),
                run("b", State::NeedsAttention),
                run("c", State::Working),
                run("d", State::Error),
                run("e", State::Idle),
            ],
            t0,
        );
        assert_eq!(w.waiting(), 2, "error and idle are worth a toast, not a badge");
    }

    #[test]
    fn a_digest_counts_in_russian() {
        // The teens are the trap: 11 takes the «обновлений» form, not «1».
        let d = |count, waiting| Toast::Digest { count, waiting }.body();
        assert_eq!(d(4, 0), "4 обновления по вашим сессиям");
        assert_eq!(d(5, 0), "5 обновлений по вашим сессиям");
        assert_eq!(d(11, 0), "11 обновлений по вашим сессиям");
        assert_eq!(d(21, 0), "21 обновление по вашим сессиям");
        assert_eq!(d(7, 1), "7 обновлений, 1 ждёт решения");
        assert_eq!(d(7, 2), "7 обновлений, 2 ждут решения");
    }

    #[test]
    fn a_digest_names_no_single_session() {
        assert_eq!(Toast::Digest { count: 9, waiting: 1 }.title(), "Hegai Code");
    }

    #[test]
    fn the_toast_says_which_machine() {
        let a = Alert {
            run_id: "r".into(),
            machine_id: "m".into(),
            session_id: "s".into(),
            title: "починить логин".into(),
            machine_name: Some("buildbox-pc".into()),
            state: State::NeedsAttention,
            pending_kind: Some("permission".into()),
            at: Instant::now(),
        };
        assert_eq!(
            a.body(),
            "buildbox-pc · сессия ждёт подтверждения",
            "a tool prompt is a permission — calling it a question is what sent people \
             looking for one that was never asked"
        );
        let asked = Alert { pending_kind: Some("question".into()), ..a.clone() };
        assert_eq!(asked.body(), "buildbox-pc · сессия ждёт ответа");
        let old_hub = Alert { pending_kind: None, ..a.clone() };
        assert_eq!(
            old_hub.body(),
            "buildbox-pc · сессия ждёт решения",
            "a hub too old to say which is the one case we may not claim either"
        );
        let nameless = Alert { machine_name: None, ..a };
        assert_eq!(nameless.body(), "Сессия ждёт подтверждения");
    }
}
