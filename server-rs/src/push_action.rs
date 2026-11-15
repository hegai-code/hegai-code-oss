//! Answering a run from a push, the watch or the lock screen (docs/WATCH.md §2-§3).
//!
//! Three things live here, all but the spent-jti table free of I/O so they can
//! be tested to the byte:
//!
//!  - the **action token** a push carries (`act`): a short HS256 JWT bound to
//!    one user, workspace, run and (for decisions) request, single use;
//!  - the **spent-jti table** (SQLite, so a restart keeps it) that makes it single use;
//!  - the **mapping** from a client's action (`answer`, `plan_accept`, ...) to
//!    what the hub sends the agent (`tool_decision` or `input`).
//!
//! The hub applies the result under the same access gate as the WebSocket
//! (`Hub::push_action`), so nothing here widens who may drive a run.

use std::collections::HashSet;
use std::sync::OnceLock;

use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

pub const ISS: &str = "cc-remote";
pub const AUD: &str = "push-action";
/// A question or plan waits for a person, but a stolen push is a live key to the
/// run: two hours.
pub const DECISION_TTL_S: i64 = 2 * 3600;
/// A free-text reply to a finished run is good for six hours.
pub const REPLY_TTL_S: i64 = 6 * 3600;
/// Longest text a client may send as a reply, an answer or a revision.
pub const MAX_TEXT_CHARS: usize = 4000;

/// Hub-wide switches of the watch feature, set once at start (`main.rs`).
#[derive(Debug, Clone, Default)]
pub struct WatchConfig {
    /// `CC_REMOTE_ACTION_TOKEN_SECRET`, validated. `None` => pushes carry no
    /// `act` and the token path of `/api/push-action` answers 503.
    pub secret: Option<String>,
    /// `CC_REMOTE_PLATFORM_ADMIN_IDS`: the rollout gate of every [admin] piece.
    pub admins: HashSet<String>,
}

static CONFIG: OnceLock<WatchConfig> = OnceLock::new();

/// Called once from `main` after the secrets were validated. A second call is
/// ignored (tests never call it).
pub fn init(config: WatchConfig) {
    let _ = CONFIG.set(config);
}

/// The process-wide config; an empty one (feature off) before `init`.
pub fn config() -> &'static WatchConfig {
    static EMPTY: OnceLock<WatchConfig> = OnceLock::new();
    CONFIG
        .get()
        .unwrap_or_else(|| EMPTY.get_or_init(WatchConfig::default))
}

/// The secret an operator configured, or None when it is unusable. Same floor
/// as the other link secrets and never a value that already does another job.
pub fn valid_secret(candidate: Option<&str>, others: &[Option<&str>]) -> Option<String> {
    let s = candidate?.trim();
    if s.len() < 32 || others.iter().flatten().any(|o| *o == s) {
        return None;
    }
    Some(s.to_string())
}

// ------------------------------------------------------------------ token

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Ask,
    Plan,
    Tool,
    Reply,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Ask => "ask",
            Kind::Plan => "plan",
            Kind::Tool => "tool",
            Kind::Reply => "reply",
        }
    }
    pub fn parse(s: &str) -> Option<Kind> {
        Some(match s {
            "ask" => Kind::Ask,
            "plan" => Kind::Plan,
            "tool" => Kind::Tool,
            "reply" => Kind::Reply,
            _ => return None,
        })
    }
    /// What a pending tool is, as far as answering it goes.
    pub fn of_tool(tool: Option<&str>) -> Kind {
        match tool {
            Some("AskUserQuestion") => Kind::Ask,
            Some("ExitPlanMode") => Kind::Plan,
            _ => Kind::Tool,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActionClaims {
    pub iss: String,
    pub aud: String,
    pub sub: String,
    pub ws: String,
    pub run: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub req: Option<String>,
    pub k: String,
    pub exp: i64,
    pub jti: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenError {
    /// Malformed, wrongly signed, wrong audience/issuer, or expired: all 401.
    Invalid,
}

/// Sign an action token. `now_s` is injected so expiry is testable.
pub fn mint(
    secret: &str,
    user: &str,
    workspace: &str,
    run: &str,
    request: Option<&str>,
    kind: Kind,
    now_s: i64,
) -> Option<String> {
    let ttl = if kind == Kind::Reply {
        REPLY_TTL_S
    } else {
        DECISION_TTL_S
    };
    let claims = ActionClaims {
        iss: ISS.into(),
        aud: AUD.into(),
        sub: user.into(),
        ws: workspace.into(),
        run: run.into(),
        req: request.map(str::to_string),
        k: kind.as_str().into(),
        exp: now_s + ttl,
        jti: uuid::Uuid::new_v4().simple().to_string(),
    };
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .ok()
}

/// Verify signature, issuer, audience and expiry (no leeway: the clock is the
/// hub's own). Returns the claims and the kind they name.
pub fn verify(secret: &str, token: &str, now_s: i64) -> Result<(ActionClaims, Kind), TokenError> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_audience(&[AUD]);
    validation.set_issuer(&[ISS]);
    validation.set_required_spec_claims(&["exp", "aud", "iss", "sub"]);
    validation.leeway = 0;
    // Expiry is judged below against the injected clock, not the system one.
    validation.validate_exp = false;
    let data = decode::<ActionClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map_err(|_| TokenError::Invalid)?;
    let claims = data.claims;
    if claims.exp <= now_s || claims.jti.is_empty() || claims.run.is_empty() {
        return Err(TokenError::Invalid);
    }
    let kind = Kind::parse(&claims.k).ok_or(TokenError::Invalid)?;
    Ok((claims, kind))
}

/// Redeemed token ids live in SQLite (`push_action_spent`) until their own
/// `exp`, so a hub restart does not reopen replays. `spend` is one
/// `INSERT OR IGNORE`: checking and spending are the same statement.
pub(crate) fn init_schema(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS push_action_spent (
           jti TEXT PRIMARY KEY,
           exp INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS push_action_spent_exp ON push_action_spent(exp);",
    )
    .map_err(crate::workspace::db_err)
}

impl crate::workspace::WorkspaceStore {
    pub(crate) fn jti_is_spent(&self, jti: &str) -> Result<bool, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM push_action_spent WHERE jti=?1)",
            [jti],
            |r| r.get(0),
        )
        .map_err(crate::workspace::db_err)
    }

    /// Redeem `jti`: true when this call is the one that spent it, false when
    /// it was spent before. Expired entries are pruned on the way.
    pub(crate) fn jti_spend(&self, jti: &str, exp: i64, now_s: i64) -> Result<bool, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.execute("DELETE FROM push_action_spent WHERE exp<=?1", [now_s])
            .map_err(crate::workspace::db_err)?;
        conn.execute(
            "INSERT OR IGNORE INTO push_action_spent(jti,exp) VALUES(?1,?2)",
            rusqlite::params![jti, exp],
        )
        .map(|n| n == 1)
        .map_err(crate::workspace::db_err)
    }
}

// -------------------------------------------------------------- questions

/// One question of an `AskUserQuestion`, as the push, the inbox and the
/// answer mapping all read it.
#[derive(Debug, Clone, PartialEq)]
pub struct Question {
    /// The key an answer goes under: the question's `id`, else its text
    /// (`web/src/components/QuestionModal.tsx`).
    pub key: String,
    pub question: String,
    pub options: Vec<String>,
    pub multi_select: bool,
}

/// The questions in a pending `AskUserQuestion` input; empty when the shape is
/// not recognisable.
pub fn parse_questions(input: &Value) -> Vec<Question> {
    let Some(list) = input.get("questions").and_then(Value::as_array) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|q| {
            let question = q.get("question").and_then(Value::as_str)?.trim();
            if question.is_empty() {
                return None;
            }
            let key = q
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or(question);
            let options = q
                .get("options")
                .and_then(Value::as_array)
                .map(|opts| {
                    opts.iter()
                        .filter_map(|o| {
                            o.get("label")
                                .and_then(Value::as_str)
                                .or_else(|| o.as_str())
                                .map(str::to_string)
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(Question {
                key: key.to_string(),
                question: question.to_string(),
                options,
                multi_select: q.get("multiSelect").and_then(Value::as_bool) == Some(true),
            })
        })
        .collect()
}

// ----------------------------------------------------------------- actions

/// Why an action was not applied; the HTTP layer maps each to a status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionError {
    /// 400
    BadRequest(&'static str),
    /// 403: the caller may not drive this run (or the workspace claim is off).
    Forbidden,
    /// 403 `private_machine`: a private machine takes an answer only sealed.
    PrivateMachine,
    /// 404 `run_gone`
    RunGone,
    /// 409 `stale`: the request is not the one pending.
    Stale,
    /// 409 `used`: the token was already redeemed.
    Used,
    /// 409 `busy`: another writer holds the session (reply without a run).
    Busy,
    /// 404 `not_found`: the session is not on the machine (or is archived).
    SessionGone,
    /// 503 `machine_offline`
    MachineOffline,
    /// 500: the store could not record the redemption; nothing was sent.
    Internal,
}

impl ActionError {
    pub fn status(&self) -> u16 {
        match self {
            ActionError::BadRequest(_) => 400,
            ActionError::Forbidden | ActionError::PrivateMachine => 403,
            ActionError::RunGone => 404,
            ActionError::Stale | ActionError::Used | ActionError::Busy => 409,
            ActionError::SessionGone => 404,
            ActionError::MachineOffline => 503,
            ActionError::Internal => 500,
        }
    }
    pub fn code(&self) -> &'static str {
        match self {
            ActionError::BadRequest(m) => m,
            ActionError::Forbidden => "forbidden",
            ActionError::PrivateMachine => "private_machine",
            ActionError::RunGone => "run_gone",
            ActionError::Stale => "stale",
            ActionError::Used => "used",
            ActionError::Busy => "busy",
            ActionError::SessionGone => "not_found",
            ActionError::MachineOffline => "machine_offline",
            ActionError::Internal => "internal",
        }
    }
}

/// What the agent is waiting on, as far as mapping an action needs.
pub struct Pending<'a> {
    pub request_id: Option<&'a str>,
    pub tool: Option<&'a str>,
    pub input: Option<&'a Value>,
}

/// A `tool_decision` the hub will send, minus the identity of the sender.
#[derive(Debug, Clone, PartialEq)]
pub struct Decision {
    pub request_id: String,
    pub allow: bool,
    pub updated_input: Option<Value>,
    pub permission_mode: Option<&'static str>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Decision(Decision),
    /// Plain text typed into the run.
    Input(String),
}

fn clean_text(text: Option<&str>) -> Result<Option<String>, ActionError> {
    match text {
        None => Ok(None),
        Some(t) => {
            let t = t.trim();
            if t.chars().count() > MAX_TEXT_CHARS {
                return Err(ActionError::BadRequest("text_too_long"));
            }
            Ok((!t.is_empty()).then(|| t.to_string()))
        }
    }
}

/// An `answers` map from a client: question key -> label, or labels for a
/// multi-select. Anything else is a malformed body.
fn clean_answers(answers: &Map<String, Value>) -> Result<Map<String, Value>, ActionError> {
    if answers.is_empty() || answers.len() > 20 {
        return Err(ActionError::BadRequest("bad_answers"));
    }
    let mut out = Map::new();
    for (key, value) in answers {
        let ok = match value {
            Value::String(s) => !s.trim().is_empty() && s.chars().count() <= MAX_TEXT_CHARS,
            Value::Array(items) => {
                !items.is_empty()
                    && items.len() <= 20
                    && items.iter().all(|i| {
                        i.as_str()
                            .is_some_and(|s| !s.trim().is_empty() && s.chars().count() <= 1000)
                    })
            }
            _ => false,
        };
        if !ok {
            return Err(ActionError::BadRequest("bad_answers"));
        }
        out.insert(key.clone(), value.clone());
    }
    Ok(out)
}

/// Map a client action onto what the hub sends the agent.
///
/// `token_kind` is the `k` of the action token, `None` for the session mode
/// (the kind is then read off the pending tool). `request_id` is the id the
/// client names (the token's `req`, or the body's `requestId`).
pub fn resolve(
    token_kind: Option<Kind>,
    action: &str,
    text: Option<&str>,
    answers: Option<&Map<String, Value>>,
    request_id: Option<&str>,
    pending: &Pending<'_>,
) -> Result<Outcome, ActionError> {
    if !matches!(
        action,
        "allow" | "deny" | "answer" | "plan_accept" | "plan_accept_edits" | "plan_revise" | "reply"
    ) {
        return Err(ActionError::BadRequest("unknown_action"));
    }
    let text = clean_text(text)?;
    if action == "reply" {
        // Allowed with any token kind; needs words.
        return text
            .map(Outcome::Input)
            .ok_or(ActionError::BadRequest("text_required"));
    }
    // A token of `reply` kind carries no request and so decides nothing.
    if token_kind == Some(Kind::Reply) {
        return Err(ActionError::BadRequest("action_not_allowed"));
    }
    let request_id = request_id.ok_or(ActionError::BadRequest("request_id_required"))?;
    if pending.request_id != Some(request_id) {
        return Err(ActionError::Stale);
    }
    let pending_kind = Kind::of_tool(pending.tool);
    if token_kind.is_some_and(|k| k != pending_kind) {
        return Err(ActionError::BadRequest("action_not_allowed"));
    }
    let decision = |allow: bool,
                    updated_input: Option<Value>,
                    permission_mode: Option<&'static str>,
                    message: Option<String>| {
        Ok(Outcome::Decision(Decision {
            request_id: request_id.to_string(),
            allow,
            updated_input,
            permission_mode,
            message,
        }))
    };
    let echoed = || {
        pending
            .input
            .filter(|i| i.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}))
    };
    match (action, pending_kind) {
        ("allow", Kind::Tool) => decision(true, None, None, None),
        ("deny", Kind::Tool) => decision(false, None, None, None),
        ("answer", Kind::Ask) => {
            let questions = pending.input.map(parse_questions).unwrap_or_default();
            if let Some(map) = answers {
                let mut updated = echoed();
                updated["answers"] = Value::Object(clean_answers(map)?);
                return decision(true, Some(updated), None, None);
            }
            let text = text.ok_or(ActionError::BadRequest("text_required"))?;
            match questions.as_slice() {
                [only] => {
                    let value = if only.multi_select {
                        json!([text])
                    } else {
                        json!(text)
                    };
                    let mut updated = echoed();
                    updated["answers"] = json!({ only.key.clone(): value });
                    decision(true, Some(updated), None, None)
                }
                // Several questions (or none we can read): the words cannot be
                // pinned to one of them, so they go back as the refusal's reason.
                _ => decision(false, None, None, Some(text)),
            }
        }
        ("plan_accept", Kind::Plan) => decision(true, Some(echoed()), Some("default"), None),
        ("plan_accept_edits", Kind::Plan) => {
            decision(true, Some(echoed()), Some("acceptEdits"), None)
        }
        ("plan_revise", Kind::Plan) => {
            let text = text.ok_or(ActionError::BadRequest("text_required"))?;
            decision(false, None, None, Some(text))
        }
        ("allow" | "deny" | "answer" | "plan_accept" | "plan_accept_edits" | "plan_revise", _) => {
            Err(ActionError::BadRequest("action_not_allowed"))
        }
        _ => Err(ActionError::BadRequest("unknown_action")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "0123456789abcdef0123456789abcdef-secret";
    const NOW: i64 = 1_800_000_000;

    fn ask_input(n: usize, multi: bool) -> Value {
        let qs: Vec<Value> = (0..n)
            .map(|i| {
                let mut q = json!({
                    "question": format!("Question {i}?"),
                    "options": [{"label": "A"}, {"label": "B", "description": "d"}],
                    "multiSelect": multi,
                });
                if i == 0 && n == 1 {
                    q["id"] = json!("q-id");
                }
                q
            })
            .collect();
        json!({ "questions": qs })
    }

    fn pending<'a>(tool: &'a str, input: &'a Value) -> Pending<'a> {
        Pending {
            request_id: Some("req-1"),
            tool: Some(tool),
            input: Some(input),
        }
    }

    #[test]
    fn token_round_trip_carries_every_claim() {
        let t = mint(SECRET, "u1", "w1", "run-1", Some("req-1"), Kind::Ask, NOW).unwrap();
        let (c, k) = verify(SECRET, &t, NOW + 10).unwrap();
        assert_eq!(k, Kind::Ask);
        assert_eq!(
            (
                c.iss.as_str(),
                c.aud.as_str(),
                c.sub.as_str(),
                c.ws.as_str()
            ),
            ("cc-remote", "push-action", "u1", "w1")
        );
        assert_eq!(c.run, "run-1");
        assert_eq!(c.req.as_deref(), Some("req-1"));
        assert_eq!(c.exp, NOW + DECISION_TTL_S);
        assert!(!c.jti.is_empty());
    }

    #[test]
    fn reply_token_lives_six_hours_and_has_no_request() {
        let t = mint(SECRET, "u1", "w1", "run-1", None, Kind::Reply, NOW).unwrap();
        let (c, k) = verify(SECRET, &t, NOW).unwrap();
        assert_eq!(k, Kind::Reply);
        assert_eq!(c.req, None);
        assert_eq!(c.exp, NOW + 6 * 3600);
        // `req` is absent from the wire form, never null.
        let payload = t.split('.').nth(1).unwrap();
        let raw =
            base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, payload)
                .unwrap();
        let v: Value = serde_json::from_slice(&raw).unwrap();
        assert!(v.get("req").is_none());
    }

    #[test]
    fn expired_wrong_secret_wrong_audience_and_garbage_are_invalid() {
        let t = mint(SECRET, "u1", "w1", "r", Some("q"), Kind::Plan, NOW).unwrap();
        assert!(verify(SECRET, &t, NOW + DECISION_TTL_S - 1).is_ok());
        assert_eq!(
            verify(SECRET, &t, NOW + DECISION_TTL_S),
            Err(TokenError::Invalid)
        );
        assert_eq!(
            verify("another-secret-another-secret-another", &t, NOW),
            Err(TokenError::Invalid)
        );
        assert_eq!(verify(SECRET, "not.a.jwt", NOW), Err(TokenError::Invalid));
        // A token of another purpose signed with the same key is refused.
        let mut other = ActionClaims {
            iss: ISS.into(),
            aud: "something-else".into(),
            sub: "u".into(),
            ws: "w".into(),
            run: "r".into(),
            req: None,
            k: "reply".into(),
            exp: NOW + 100,
            jti: "j".into(),
        };
        let sign = |c: &ActionClaims| {
            encode(
                &Header::new(Algorithm::HS256),
                c,
                &EncodingKey::from_secret(SECRET.as_bytes()),
            )
            .unwrap()
        };
        assert_eq!(verify(SECRET, &sign(&other), NOW), Err(TokenError::Invalid));
        other.aud = AUD.into();
        assert!(verify(SECRET, &sign(&other), NOW).is_ok());
        other.iss = "evil".into();
        assert_eq!(verify(SECRET, &sign(&other), NOW), Err(TokenError::Invalid));
        // `alg: none` style forgery is not a signature.
        let forged = format!(
            "{}.{}.",
            base64::Engine::encode(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD,
                br#"{"alg":"none","typ":"JWT"}"#
            ),
            t.split('.').nth(1).unwrap()
        );
        assert_eq!(verify(SECRET, &forged, NOW), Err(TokenError::Invalid));
    }

    #[test]
    fn a_spent_jti_is_remembered_until_its_expiry_only_and_survives_a_restart() {
        let path = std::env::temp_dir().join(format!("jti-{}.db", uuid::Uuid::new_v4().simple()));
        let ws = crate::workspace::WorkspaceStore::open(&path).unwrap();
        assert!(!ws.jti_is_spent("j1").unwrap());
        assert!(ws.jti_spend("j1", NOW + 100, NOW).unwrap());
        assert!(
            !ws.jti_spend("j1", NOW + 100, NOW).unwrap(),
            "second spend loses"
        );
        assert!(ws.jti_is_spent("j1").unwrap());
        drop(ws);
        // A restart: same file, the jti is still spent.
        let ws = crate::workspace::WorkspaceStore::open(&path).unwrap();
        assert!(ws.jti_is_spent("j1").unwrap());
        // A later spend prunes what has expired.
        assert!(ws.jti_spend("j2", NOW + 500, NOW + 200).unwrap());
        assert!(!ws.jti_is_spent("j1").unwrap());
        assert!(ws.jti_is_spent("j2").unwrap());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn secret_must_be_long_and_distinct() {
        let long = "x".repeat(32);
        assert_eq!(valid_secret(Some(&long), &[]), Some(long.clone()));
        assert_eq!(valid_secret(Some("short"), &[]), None);
        assert_eq!(valid_secret(None, &[]), None);
        assert_eq!(valid_secret(Some(&long), &[None, Some(&long)]), None);
    }

    #[test]
    fn questions_are_keyed_by_id_else_text() {
        let qs = parse_questions(&ask_input(1, false));
        assert_eq!(qs[0].key, "q-id");
        assert_eq!(qs[0].options, vec!["A", "B"]);
        let qs = parse_questions(&ask_input(2, true));
        assert_eq!(qs[1].key, "Question 1?");
        assert!(qs[1].multi_select);
        assert!(parse_questions(&json!({"questions": "nope"})).is_empty());
    }

    #[test]
    fn answer_text_to_one_question_fills_answers_under_its_key() {
        let input = ask_input(1, false);
        let out = resolve(
            Some(Kind::Ask),
            "answer",
            Some("  Option B please "),
            None,
            Some("req-1"),
            &pending("AskUserQuestion", &input),
        )
        .unwrap();
        let Outcome::Decision(d) = out else {
            panic!("expected a decision")
        };
        assert!(d.allow);
        assert_eq!(
            d.updated_input.unwrap(),
            json!({
                "questions": input["questions"],
                "answers": {"q-id": "Option B please"},
            })
        );
        assert_eq!(d.message, None);
    }

    #[test]
    fn answer_text_to_a_multiselect_is_a_one_element_list() {
        let input =
            json!({"questions": [{"question": "Which?", "options": [], "multiSelect": true}]});
        let Outcome::Decision(d) = resolve(
            None,
            "answer",
            Some("both"),
            None,
            Some("req-1"),
            &pending("AskUserQuestion", &input),
        )
        .unwrap() else {
            panic!()
        };
        assert_eq!(
            d.updated_input.unwrap()["answers"],
            json!({"Which?": ["both"]})
        );
    }

    #[test]
    fn answer_text_to_several_questions_is_a_denial_with_the_words_as_reason() {
        let input = ask_input(2, false);
        let Outcome::Decision(d) = resolve(
            Some(Kind::Ask),
            "answer",
            Some("skip both"),
            None,
            Some("req-1"),
            &pending("AskUserQuestion", &input),
        )
        .unwrap() else {
            panic!()
        };
        assert!(!d.allow);
        assert_eq!(d.message.as_deref(), Some("skip both"));
        assert_eq!(d.updated_input, None);
    }

    #[test]
    fn an_answers_map_is_validated_and_merged_into_the_input() {
        let input = ask_input(2, false);
        let good = json!({"Question 0?": "A", "Question 1?": ["A", "B"]});
        let Outcome::Decision(d) = resolve(
            Some(Kind::Ask),
            "answer",
            None,
            good.as_object(),
            Some("req-1"),
            &pending("AskUserQuestion", &input),
        )
        .unwrap() else {
            panic!()
        };
        assert!(d.allow);
        assert_eq!(d.updated_input.unwrap()["answers"], good);
        for bad in [
            json!({}),
            json!({"q": 3}),
            json!({"q": ""}),
            json!({"q": []}),
        ] {
            assert_eq!(
                resolve(
                    None,
                    "answer",
                    None,
                    bad.as_object(),
                    Some("req-1"),
                    &pending("AskUserQuestion", &input)
                ),
                Err(ActionError::BadRequest("bad_answers")),
                "{bad}"
            );
        }
    }

    #[test]
    fn plan_actions_map_to_the_native_dialog_choices() {
        let input = json!({"plan": "1. do it"});
        let p = pending("ExitPlanMode", &input);
        let go = |action, text| resolve(Some(Kind::Plan), action, text, None, Some("req-1"), &p);
        for (action, mode) in [
            ("plan_accept", "default"),
            ("plan_accept_edits", "acceptEdits"),
        ] {
            let Outcome::Decision(d) = go(action, None).unwrap() else {
                panic!()
            };
            assert!(d.allow);
            assert_eq!(d.permission_mode, Some(mode));
            assert_eq!(d.updated_input, Some(input.clone()));
        }
        let Outcome::Decision(d) = go("plan_revise", Some("smaller steps")).unwrap() else {
            panic!()
        };
        assert!(!d.allow);
        assert_eq!(d.message.as_deref(), Some("smaller steps"));
        assert_eq!(d.permission_mode, None);
        assert_eq!(
            go("plan_revise", Some("   ")),
            Err(ActionError::BadRequest("text_required"))
        );
        // A plan cannot be "allowed" like a tool, nor answered like a question.
        assert_eq!(
            go("allow", None),
            Err(ActionError::BadRequest("action_not_allowed"))
        );
        assert_eq!(
            go("answer", Some("x")),
            Err(ActionError::BadRequest("action_not_allowed"))
        );
    }

    #[test]
    fn tool_allow_and_deny_need_a_tool_token() {
        let input = json!({"command": "ls"});
        let p = pending("Bash", &input);
        let Outcome::Decision(d) =
            resolve(Some(Kind::Tool), "allow", None, None, Some("req-1"), &p).unwrap()
        else {
            panic!()
        };
        assert!(d.allow && d.updated_input.is_none());
        let Outcome::Decision(d) = resolve(None, "deny", None, None, Some("req-1"), &p).unwrap()
        else {
            panic!()
        };
        assert!(!d.allow);
        // A question's token cannot approve a Bash.
        assert_eq!(
            resolve(Some(Kind::Ask), "allow", None, None, Some("req-1"), &p),
            Err(ActionError::BadRequest("action_not_allowed"))
        );
    }

    #[test]
    fn a_decision_for_another_request_is_stale() {
        let input = json!({"plan": "p"});
        let p = pending("ExitPlanMode", &input);
        assert_eq!(
            resolve(None, "plan_accept", None, None, Some("req-OLD"), &p),
            Err(ActionError::Stale)
        );
        let none = Pending {
            request_id: None,
            tool: None,
            input: None,
        };
        assert_eq!(
            resolve(None, "plan_accept", None, None, Some("req-1"), &none),
            Err(ActionError::Stale)
        );
        assert_eq!(
            resolve(None, "plan_accept", None, None, None, &p),
            Err(ActionError::BadRequest("request_id_required"))
        );
    }

    #[test]
    fn reply_works_with_any_token_and_without_a_pending_request() {
        let none = Pending {
            request_id: None,
            tool: None,
            input: None,
        };
        for kind in [Some(Kind::Reply), Some(Kind::Ask), None] {
            assert_eq!(
                resolve(kind, "reply", Some("go on"), None, None, &none),
                Ok(Outcome::Input("go on".into()))
            );
        }
        assert_eq!(
            resolve(Some(Kind::Reply), "reply", Some(" "), None, None, &none),
            Err(ActionError::BadRequest("text_required"))
        );
        // A reply token decides nothing.
        assert_eq!(
            resolve(Some(Kind::Reply), "allow", None, None, Some("r"), &none),
            Err(ActionError::BadRequest("action_not_allowed"))
        );
        let long = "я".repeat(MAX_TEXT_CHARS + 1);
        assert_eq!(
            resolve(None, "reply", Some(&long), None, None, &none),
            Err(ActionError::BadRequest("text_too_long"))
        );
        assert_eq!(
            resolve(None, "fly", None, None, Some("r"), &none),
            Err(ActionError::BadRequest("unknown_action"))
        );
    }

    #[test]
    fn errors_carry_the_documented_statuses() {
        assert_eq!(ActionError::BadRequest("x").status(), 400);
        assert_eq!(ActionError::Forbidden.status(), 403);
        assert_eq!(ActionError::RunGone.status(), 404);
        assert_eq!(ActionError::Stale.status(), 409);
        assert_eq!(ActionError::Used.status(), 409);
        assert_eq!(ActionError::Used.code(), "used");
        assert_eq!(ActionError::MachineOffline.status(), 503);
    }
}
