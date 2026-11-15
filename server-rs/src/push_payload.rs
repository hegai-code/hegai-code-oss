//! The APNs alert payload of a run's push (docs/WATCH.md §1): Russian texts,
//! category, thread, the question / plan excerpts a lock screen or a watch can
//! answer from, and the 4096-byte ceiling. Pure functions over a `PushEvent`;
//! the notifier owns the headers and the network.

use serde_json::{json, Map, Value};

use crate::notify::PushEvent;
use crate::push_action::{parse_questions, Question};

/// What APNs accepts for a regular notification.
pub const PAYLOAD_LIMIT: usize = 4096;
const BODY_MAX: usize = 180;
const PLAN_MAX: usize = 300;
const TITLE_MAX: usize = 120;
const SUBTITLE_MAX: usize = 80;
const QUESTIONS_MAX: usize = 4;
const OPTIONS_MAX: usize = 8;
pub const REPLIES_MAX: usize = 3;
pub const REPLY_LABEL_MAX: usize = 24;
pub const REPLY_SEND_MAX: usize = 200;

/// One suggested answer: the button text and what it types.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reply {
    pub label: String,
    pub send: String,
}

/// Everything beyond the bare transition that a push may carry. Filled by the
/// hub at emit time (and by the LLM summary for an admin's idle push).
#[derive(Clone, Debug, Default)]
pub struct PushContent {
    /// The pending tool's full input (AskUserQuestion / ExitPlanMode).
    pub tool_input: Option<Value>,
    /// The turn's last assistant text (idle).
    pub assistant_text: String,
    /// Why the run failed, when the agent said.
    pub error: Option<String>,
    /// The run is being released (a terminal failure): nothing can answer it,
    /// so the push carries no category and no `act`.
    pub no_actions: bool,
    /// The action token (`act`), only when minted.
    pub act: Option<String>,
    /// [admin] LLM summary of the turn.
    pub summary: Option<String>,
    /// [admin] suggested replies, idle only.
    pub replies: Vec<Reply>,
    /// A private machine's push names the machine and nothing of the content.
    pub private: bool,
}

// ---------------------------------------------------------------- text

/// Plain text out of markdown: fences, headings, bullets, emphasis, inline code
/// and links are dressing on a lock screen. Line breaks survive.
pub fn strip_markdown(src: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for raw in src.lines() {
        let mut line = raw.trim();
        if line.starts_with("```") || line.starts_with("~~~") {
            continue;
        }
        if line
            .chars()
            .all(|c| matches!(c, '-' | '*' | '_' | '=' | ' '))
            && line.len() >= 3
        {
            // A horizontal rule or an underline.
            continue;
        }
        line = line.trim_start_matches('>').trim_start();
        let hashes = line.chars().take_while(|c| *c == '#').count();
        if (1..=6).contains(&hashes) && line[hashes..].starts_with(' ') {
            line = line[hashes..].trim_start();
        }
        for bullet in ["- ", "* ", "+ ", "• "] {
            if let Some(rest) = line.strip_prefix(bullet) {
                line = rest.trim_start();
                break;
            }
        }
        let line = strip_inline(line);
        lines.push(line.trim().to_string());
    }
    // Collapse blank runs and the edges.
    let mut out = String::new();
    let mut blank = false;
    for line in lines {
        if line.is_empty() {
            blank = !out.is_empty();
            continue;
        }
        if blank {
            out.push('\n');
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&line);
        blank = false;
    }
    out
}

/// Inline markdown: `[text](url)` and `![alt](url)` keep the text, `**`/`__`
/// and backticks go. A single `*` or `_` may be part of a name and stays.
fn strip_inline(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '!' && chars.get(i + 1) == Some(&'[') {
            i += 1;
            continue;
        }
        if c == '[' {
            if let Some(close) = chars[i + 1..].iter().position(|c| *c == ']') {
                let close = i + 1 + close;
                if chars.get(close + 1) == Some(&'(') {
                    if let Some(end) = chars[close + 2..].iter().position(|c| *c == ')') {
                        out.extend(&chars[i + 1..close]);
                        i = close + 2 + end + 1;
                        continue;
                    }
                }
            }
        }
        if c == '`' {
            i += 1;
            continue;
        }
        if (c == '*' || c == '_') && chars.get(i + 1) == Some(&c) {
            i += 2;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// One line of words: breaks become spaces, runs of space collapse.
pub fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// At most `max` characters; a cut ends in an ellipsis that is counted.
pub fn excerpt(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        return s.to_string();
    }
    let keep = max.saturating_sub(1);
    let mut cut: String = s.chars().take(keep).collect();
    cut.truncate(cut.trim_end().len());
    cut.push('…');
    cut
}

/// The first line of a plan worth reading: a heading that only says «План» is
/// skipped in favour of the first real sentence.
pub fn first_plan_line(plan: &str) -> Option<String> {
    let plain = strip_markdown(plan);
    let mut fallback = None;
    for line in plain.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let bare = line.trim_end_matches(':').to_lowercase();
        if matches!(
            bare.as_str(),
            "plan" | "план" | "implementation plan" | "план работ"
        ) {
            fallback.get_or_insert_with(|| line.to_string());
            continue;
        }
        return Some(line.to_string());
    }
    fallback
}

// ---------------------------------------------------------------- build

/// What the notification says, before it is dressed in JSON.
struct Parts {
    title: String,
    subtitle: String,
    body: String,
    plan: Option<String>,
    questions: Vec<Question>,
    replies: Vec<Reply>,
}

fn category(ev: &PushEvent) -> Option<&'static str> {
    match ev.state.as_str() {
        "needs_attention" => match ev.tool.as_deref() {
            Some("AskUserQuestion") => Some("HEGAI_ASK"),
            Some("ExitPlanMode") => Some("HEGAI_PLAN"),
            Some(_) => Some("TOOL_APPROVAL"),
            // A question without a tool name cannot be answered from here.
            None => None,
        },
        "idle" => Some("HEGAI_DONE"),
        "error" if !ev.content.no_actions => Some("HEGAI_ERROR"),
        _ => None,
    }
}

fn parts(ev: &PushEvent) -> Parts {
    let c = &ev.content;
    let title = excerpt(&one_line(&ev.title), TITLE_MAX);
    let subtitle = excerpt(&one_line(&ev.machine), SUBTITLE_MAX);
    let mut p = Parts {
        title,
        subtitle,
        body: String::new(),
        plan: None,
        questions: Vec::new(),
        replies: Vec::new(),
    };
    match ev.state.as_str() {
        "needs_attention" => match ev.tool.as_deref() {
            Some("AskUserQuestion") if !c.private => {
                let qs = c
                    .tool_input
                    .as_ref()
                    .map(parse_questions)
                    .unwrap_or_default();
                p.body = qs
                    .first()
                    .map(|q| excerpt(&one_line(&strip_markdown(&q.question)), BODY_MAX))
                    .unwrap_or_default();
                if p.body.is_empty() {
                    p.body = "Нужен ваш ответ".into();
                }
                p.questions = qs.into_iter().take(QUESTIONS_MAX).collect();
                for q in &mut p.questions {
                    q.options.truncate(OPTIONS_MAX);
                }
            }
            Some("ExitPlanMode") if !c.private => {
                let plan = c
                    .tool_input
                    .as_ref()
                    .and_then(|i| i.get("plan"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                p.body = match first_plan_line(plan) {
                    Some(line) => excerpt(&format!("План: {}", one_line(&line)), BODY_MAX),
                    None => "План готов".into(),
                };
                let stripped = strip_markdown(plan);
                if !stripped.is_empty() {
                    p.plan = Some(excerpt(&stripped, PLAN_MAX));
                }
            }
            Some("AskUserQuestion") | Some("ExitPlanMode") => {
                p.body = "Нужен ваш ответ".into();
            }
            // The tool's NAME, never its title: for Bash the title is the
            // command line.
            Some(tool) => {
                p.body = excerpt(&format!("Хочет запустить {}", one_line(tool)), BODY_MAX);
            }
            None => p.body = "Нужен ваш ответ".into(),
        },
        "idle" => {
            let summary = c
                .summary
                .as_deref()
                .map(|s| one_line(&strip_markdown(s)))
                .filter(|s| !s.is_empty());
            let text = one_line(&strip_markdown(&c.assistant_text));
            p.body = match (c.private, summary, text.is_empty()) {
                (true, _, _) => "Готово".into(),
                (false, Some(s), _) => s,
                (false, None, false) => excerpt(&text, BODY_MAX),
                (false, None, true) => "Готово".into(),
            };
            if !c.private {
                p.replies = c.replies.clone();
            }
        }
        "error" => {
            let reason = c
                .error
                .as_deref()
                .map(|e| one_line(&strip_markdown(e)))
                .filter(|e| !e.is_empty() && !c.private);
            p.body = match reason {
                Some(r) => excerpt(&format!("Ошибка: {r}"), BODY_MAX),
                None => "Ошибка".into(),
            };
        }
        other => p.body = format!("Сессия: {other}"),
    }
    p.replies.truncate(REPLIES_MAX);
    p
}

fn assemble(ev: &PushEvent, p: &Parts) -> Value {
    let mut aps = Map::new();
    aps.insert(
        "alert".into(),
        json!({ "title": p.title, "subtitle": p.subtitle, "body": p.body }),
    );
    aps.insert("sound".into(), json!("default"));
    aps.insert("thread-id".into(), json!(ev.session_id));
    aps.insert(
        "interruption-level".into(),
        json!(if ev.state == "needs_attention" {
            "time-sensitive"
        } else {
            "active"
        }),
    );
    if let Some(cat) = category(ev) {
        aps.insert("category".into(), json!(cat));
    }
    aps.insert("mutable-content".into(), json!(0));
    // The app reads these from `userInfo`, so they sit beside `aps`. Optional
    // ones are absent, never null.
    let mut payload = Map::new();
    payload.insert("aps".into(), Value::Object(aps));
    payload.insert("machineId".into(), json!(ev.machine_id));
    payload.insert("sessionId".into(), json!(ev.session_id));
    payload.insert("runId".into(), json!(ev.run_id));
    payload.insert("state".into(), json!(ev.state));
    // A private machine's push says so: the phone then never answers it from the
    // banner over a channel that cannot seal (docs/E2EE.md). Absent otherwise.
    if ev.content.private {
        payload.insert("private".into(), json!(true));
    }
    if let Some(req) = &ev.request_id {
        payload.insert("requestId".into(), json!(req));
    }
    if let Some(tool) = &ev.tool {
        payload.insert("tool".into(), json!(tool));
    }
    if let Some(act) = &ev.content.act {
        payload.insert("act".into(), json!(act));
    }
    if !p.questions.is_empty() {
        let qs: Vec<Value> = p
            .questions
            .iter()
            .map(|q| {
                json!({
                    "key": q.key,
                    "question": q.question,
                    "options": q.options,
                    "multiSelect": q.multi_select,
                })
            })
            .collect();
        payload.insert("ask".into(), json!({ "questions": qs }));
    }
    if let Some(plan) = &p.plan {
        payload.insert("plan".into(), json!(plan));
    }
    if !p.replies.is_empty() {
        let rs: Vec<Value> = p
            .replies
            .iter()
            .map(|r| json!({ "label": r.label, "send": r.send }))
            .collect();
        payload.insert("replies".into(), Value::Array(rs));
    }
    Value::Object(payload)
}

fn size(ev: &PushEvent, p: &Parts) -> usize {
    assemble(ev, p).to_string().len()
}

fn shrink(s: &str, keep: usize) -> String {
    if s.chars().count() <= keep {
        s.to_string()
    } else {
        excerpt(s, keep)
    }
}

/// The payload, trimmed until it fits `limit` bytes: the plan first, then the
/// suggested replies, then the option labels, then the body (with the question
/// text that repeats it, and any question after the first).
pub fn build_payload(ev: &PushEvent, limit: usize) -> Value {
    let mut p = parts(ev);
    // 1. plan
    while size(ev, &p) > limit {
        let Some(plan) = p.plan.take() else { break };
        let keep = plan.chars().count() / 2;
        if keep >= 20 {
            p.plan = Some(shrink(&plan, keep));
        }
    }
    // 2. replies
    while size(ev, &p) > limit && !p.replies.is_empty() {
        p.replies.pop();
    }
    // 3. option labels
    for max in [60usize, 40, 24, 12, 6, 0] {
        if size(ev, &p) <= limit {
            break;
        }
        for q in &mut p.questions {
            for o in &mut q.options {
                *o = if max == 0 {
                    String::new()
                } else {
                    shrink(o, max)
                };
            }
            if max == 0 {
                q.options.clear();
            }
        }
    }
    // 4. body and the question text that mirrors it; then the questions
    //    themselves, last first (a key is the question's own text when it has
    //    no id, so it cannot be cut without breaking the answer map).
    while size(ev, &p) > limit {
        let before = (
            p.body.chars().count(),
            p.questions
                .iter()
                .map(|q| q.question.chars().count())
                .sum::<usize>(),
        );
        p.body = shrink(&p.body, (before.0 / 2).max(12));
        for q in &mut p.questions {
            q.question = shrink(&q.question, (q.question.chars().count() / 2).max(12));
        }
        let after = (
            p.body.chars().count(),
            p.questions
                .iter()
                .map(|q| q.question.chars().count())
                .sum::<usize>(),
        );
        if after == before && p.questions.pop().is_none() {
            break;
        }
    }
    // 5. last resort: the header lines (never reached by sane titles).
    while size(ev, &p) > limit && (p.title.len() > 24 || p.subtitle.len() > 24) {
        p.title = shrink(&p.title, (p.title.chars().count() / 2).max(8));
        p.subtitle = shrink(&p.subtitle, (p.subtitle.chars().count() / 2).max(8));
    }
    // 6. still too big means an oversized identifier, key or token from the
    //    agent frame. Drop the interactive extras (a tap still opens the
    //    session), then the extra ids; never hand APNs more than `limit`.
    if size(ev, &p) > limit {
        p.questions.clear();
        p.plan = None;
        p.replies.clear();
    }
    let mut v = assemble(ev, &p);
    if v.to_string().len() <= limit {
        return v;
    }
    if let Some(o) = v.as_object_mut() {
        for k in ["act", "requestId", "tool", "ask", "plan", "replies"] {
            o.remove(k);
        }
        if let Some(aps) = o.get_mut("aps").and_then(Value::as_object_mut) {
            aps.remove("category");
        }
    }
    if v.to_string().len() <= limit {
        return v;
    }
    json!({ "aps": { "alert": { "title": "Hegai Code", "body": "Откройте сессию" }, "sound": "default" } })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_ids_never_exceed_the_limit() {
        let mut e = ev("needs_attention", Some("AskUserQuestion"));
        e.request_id = Some("r".repeat(5000));
        assert!(build_payload(&e, PAYLOAD_LIMIT).to_string().len() <= PAYLOAD_LIMIT);
        let mut e = ev("idle", None);
        e.session_id = "s".repeat(9000);
        e.run_id = "u".repeat(9000);
        let v = build_payload(&e, PAYLOAD_LIMIT);
        assert!(v.to_string().len() <= PAYLOAD_LIMIT);
        assert!(v["aps"]["alert"]["body"].is_string());
    }

    fn ev(state: &str, tool: Option<&str>) -> PushEvent {
        PushEvent {
            run_id: "run-1".into(),
            title: "Fix the build".into(),
            machine: "Mac".into(),
            machine_id: "mac-1".into(),
            session_id: "sess-1".into(),
            state: state.into(),
            request_id: tool.map(|_| "req-1".into()),
            tool: tool.map(str::to_string),
            device_tokens: vec![],
            owner_user_id: Some("u".into()),
            workspace_id: Some("w".into()),
            content: PushContent::default(),
        }
    }

    fn alert(v: &Value) -> &Value {
        &v["aps"]["alert"]
    }

    #[test]
    fn markdown_comes_off_a_lock_screen_text() {
        let md = "## Итог\n\n- сделал **важное** и `код`\n- см. [доку](https://x.y/z)\n\n```rust\nlet a = 1;\n```\n---\n> цитата";
        assert_eq!(
            strip_markdown(md),
            "Итог\n\nсделал важное и код\nсм. доку\n\nlet a = 1;\nцитата"
        );
        assert_eq!(strip_markdown("snake_case и *.rs"), "snake_case и *.rs");
        assert_eq!(one_line("a\n\n b   c"), "a b c");
    }

    #[test]
    fn excerpt_counts_the_ellipsis_and_cuts_on_chars() {
        assert_eq!(excerpt("коротко", 10), "коротко");
        let cut = excerpt(&"я".repeat(50), 10);
        assert_eq!(cut.chars().count(), 10);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn plan_line_skips_a_bare_heading() {
        assert_eq!(
            first_plan_line("# План\n\n1. Переписать модуль\n2. Тесты").as_deref(),
            Some("1. Переписать модуль")
        );
        assert_eq!(first_plan_line("# Plan").as_deref(), Some("Plan"));
        assert_eq!(first_plan_line(""), None);
    }

    #[test]
    fn ask_push_has_question_body_category_thread_and_ask_block() {
        let mut e = ev("needs_attention", Some("AskUserQuestion"));
        e.content.tool_input = Some(json!({"questions": [{
            "id": "db", "question": "Какую **базу** взять?", "header": "DB",
            "options": [{"label": "SQLite"}, {"label": "Postgres", "description": "x"}],
            "multiSelect": false
        }]}));
        e.content.act = Some("TOKEN".into());
        let v = build_payload(&e, PAYLOAD_LIMIT);
        assert_eq!(
            v,
            json!({
                "aps": {
                    "alert": {"title": "Fix the build", "subtitle": "Mac", "body": "Какую базу взять?"},
                    "sound": "default",
                    "thread-id": "sess-1",
                    "interruption-level": "time-sensitive",
                    "category": "HEGAI_ASK",
                    "mutable-content": 0,
                },
                "machineId": "mac-1", "sessionId": "sess-1", "runId": "run-1",
                "state": "needs_attention", "requestId": "req-1", "tool": "AskUserQuestion",
                "act": "TOKEN",
                "ask": {"questions": [{
                    "key": "db", "question": "Какую **базу** взять?",
                    "options": ["SQLite", "Postgres"], "multiSelect": false
                }]},
            })
        );
    }

    #[test]
    fn plan_push_names_the_first_real_line_and_carries_an_excerpt() {
        let mut e = ev("needs_attention", Some("ExitPlanMode"));
        e.content.tool_input =
            Some(json!({"plan": "# План\n\n**Шаг 1.** Починить сборку\n- и тесты"}));
        let v = build_payload(&e, PAYLOAD_LIMIT);
        assert_eq!(alert(&v)["body"], "План: Шаг 1. Починить сборку");
        assert_eq!(v["aps"]["category"], "HEGAI_PLAN");
        assert_eq!(v["plan"], "План\n\nШаг 1. Починить сборку\nи тесты");
        assert!(v.get("ask").is_none() && v.get("act").is_none());
    }

    #[test]
    fn other_tools_keep_the_approval_category_with_a_russian_body() {
        let mut e = ev("needs_attention", Some("Bash"));
        let v = build_payload(&e, PAYLOAD_LIMIT);
        assert_eq!(alert(&v)["body"], "Хочет запустить Bash");
        assert_eq!(v["aps"]["category"], "TOOL_APPROVAL");
        // The command line (the tool's title) never reaches the push.
        e.content.tool_input = Some(json!({"command": "rm -rf build"}));
        let v = build_payload(&e, PAYLOAD_LIMIT);
        assert_eq!(alert(&v)["body"], "Хочет запустить Bash");
        assert!(!v.to_string().contains("rm -rf"));
        assert_eq!(v["requestId"], "req-1");
        assert_eq!(v["tool"], "Bash");
    }

    #[test]
    fn a_released_failure_carries_no_category_and_no_act() {
        let mut e = ev("error", None);
        e.content.act = Some("A".into());
        assert_eq!(
            build_payload(&e, PAYLOAD_LIMIT)["aps"]["category"],
            "HEGAI_ERROR"
        );
        e.content.no_actions = true;
        e.content.act = None;
        let v = build_payload(&e, PAYLOAD_LIMIT);
        assert!(v["aps"].get("category").is_none() && v.get("act").is_none());
        assert_eq!(alert(&v)["body"], "Ошибка");
    }

    #[test]
    fn idle_push_prefers_the_summary_then_the_stripped_text_then_gotovo() {
        let mut e = ev("idle", None);
        e.content.assistant_text = "## Готово\n\nСобрал **релиз** и выложил.".into();
        let v = build_payload(&e, PAYLOAD_LIMIT);
        assert_eq!(alert(&v)["body"], "Готово Собрал релиз и выложил.");
        assert_eq!(v["aps"]["category"], "HEGAI_DONE");
        assert_eq!(v["aps"]["interruption-level"], "active");
        assert!(v.get("requestId").is_none() && v.get("replies").is_none());

        e.content.summary = Some("Релиз выложен, ждёт проверки".into());
        e.content.replies = vec![Reply {
            label: "Проверь".into(),
            send: "Проверь релиз на бою".into(),
        }];
        let v = build_payload(&e, PAYLOAD_LIMIT);
        assert_eq!(alert(&v)["body"], "Релиз выложен, ждёт проверки");
        assert_eq!(
            v["replies"],
            json!([{"label": "Проверь", "send": "Проверь релиз на бою"}])
        );

        e.content = PushContent::default();
        assert_eq!(alert(&build_payload(&e, PAYLOAD_LIMIT))["body"], "Готово");

        e.content.assistant_text = "я".repeat(500);
        let body = build_payload(&e, PAYLOAD_LIMIT)["aps"]["alert"]["body"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(body.chars().count(), 180);
    }

    #[test]
    fn error_push_adds_the_reason_when_known() {
        let mut e = ev("error", None);
        assert_eq!(alert(&build_payload(&e, PAYLOAD_LIMIT))["body"], "Ошибка");
        e.content.error = Some("Login expired\nrun /login".into());
        let v = build_payload(&e, PAYLOAD_LIMIT);
        assert_eq!(alert(&v)["body"], "Ошибка: Login expired run /login");
        assert_eq!(v["aps"]["category"], "HEGAI_ERROR");
    }

    #[test]
    fn a_private_machine_push_reveals_nothing_of_the_content() {
        let mut e = ev("needs_attention", Some("AskUserQuestion"));
        e.content.private = true;
        e.content.tool_input = Some(json!({"questions": [{"question": "secret?", "options": []}]}));
        e.content.assistant_text = "secret".into();
        e.content.replies = vec![Reply {
            label: "s".into(),
            send: "s".into(),
        }];
        let v = build_payload(&e, PAYLOAD_LIMIT);
        assert_eq!(alert(&v)["body"], "Нужен ваш ответ");
        assert_eq!(v["private"], true);
        assert!(v.get("ask").is_none() && v.get("plan").is_none());
        assert!(!v.to_string().contains("secret"));
        let mut done = ev("idle", None);
        done.content = e.content.clone();
        let v = build_payload(&done, PAYLOAD_LIMIT);
        assert_eq!(alert(&v)["body"], "Готово");
        assert!(v.get("replies").is_none());
    }

    #[test]
    fn an_ordinary_push_carries_no_private_key() {
        let v = build_payload(&ev("needs_attention", Some("Bash")), PAYLOAD_LIMIT);
        assert!(v.get("private").is_none());
    }

    #[test]
    fn optional_keys_are_absent_never_null() {
        for e in [
            ev("idle", None),
            ev("error", None),
            ev("needs_attention", Some("Bash")),
        ] {
            let text = build_payload(&e, PAYLOAD_LIMIT).to_string();
            assert!(!text.contains("null"), "{text}");
        }
    }

    #[test]
    fn a_huge_plan_is_trimmed_to_fit_and_the_rest_survives() {
        let mut e = ev("needs_attention", Some("ExitPlanMode"));
        e.content.tool_input = Some(json!({"plan": "Шаг большой работы. ".repeat(5000)}));
        e.content.act = Some("A".repeat(400));
        let v = build_payload(&e, PAYLOAD_LIMIT);
        assert!(v.to_string().len() <= PAYLOAD_LIMIT);
        assert!(v["plan"].as_str().unwrap().chars().count() <= 300);
        assert_eq!(v["act"].as_str().unwrap().len(), 400);
        // And under a tight budget the plan goes before the body does.
        let tight = build_payload(&e, 900);
        assert!(tight.to_string().len() <= 900);
        assert!(tight["aps"]["alert"]["body"]
            .as_str()
            .unwrap()
            .starts_with("План: "));
    }

    #[test]
    fn huge_questions_trim_plan_then_replies_then_labels_then_body() {
        let questions: Vec<Value> = (0..4)
            .map(|i| {
                json!({
                    "id": format!("q{i}"),
                    "question": format!("Вопрос {i}? {}", "очень длинно ".repeat(300)),
                    "options": (0..8).map(|o| json!({"label": format!("Вариант {o} {}", "слово ".repeat(80))})).collect::<Vec<_>>(),
                    "multiSelect": i % 2 == 0,
                })
            })
            .collect();
        let mut e = ev("needs_attention", Some("AskUserQuestion"));
        e.content.tool_input = Some(json!({"questions": questions}));
        e.content.act = Some("A".repeat(400));
        let v = build_payload(&e, PAYLOAD_LIMIT);
        let len = v.to_string().len();
        assert!(len <= PAYLOAD_LIMIT, "{len}");
        // Still answerable: a question with its key, the act token intact.
        assert!(!v["ask"]["questions"].as_array().unwrap().is_empty());
        assert_eq!(v["ask"]["questions"][0]["key"], "q0");
        assert_eq!(v["act"].as_str().unwrap().len(), 400);

        // Without ids the key IS the text: it cannot be cut, so the question
        // leaves `ask` (the text-reply path still works) and the push fits.
        let bare: Vec<Value> = (0..2)
            .map(|i| json!({"question": format!("Вопрос {i}? {}", "длинно ".repeat(900)), "options": []}))
            .collect();
        e.content.tool_input = Some(json!({"questions": bare}));
        let v = build_payload(&e, PAYLOAD_LIMIT);
        assert!(v.to_string().len() <= PAYLOAD_LIMIT);
        assert!(v.get("ask").is_none());
        assert!(v["aps"]["alert"]["body"]
            .as_str()
            .unwrap()
            .starts_with("Вопрос 0?"));

        // The order: replies go before labels, labels before the body.
        let mut idle = ev("idle", None);
        idle.content.summary = Some("Итог ".repeat(30));
        idle.content.replies = (0..3)
            .map(|i| Reply {
                label: format!("Кнопка {i}"),
                send: "и".repeat(200),
            })
            .collect();
        let full = build_payload(&idle, PAYLOAD_LIMIT);
        assert_eq!(full["replies"].as_array().unwrap().len(), 3);
        let budget = size(&idle, &parts(&idle)) - 300;
        let squeezed = build_payload(&idle, budget);
        assert!(squeezed.to_string().len() <= budget);
        assert!(squeezed["replies"].as_array().map_or(0, Vec::len) < 3);
        assert!(squeezed["aps"]["alert"]["body"]
            .as_str()
            .unwrap()
            .starts_with("Итог"));
    }

    #[test]
    fn counts_are_utf8_bytes_not_characters() {
        let mut e = ev("idle", None);
        e.content.assistant_text = "я".repeat(180);
        let v = build_payload(&e, 300);
        assert!(v.to_string().len() <= 300);
    }
}
