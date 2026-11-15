//! A transcript tail shrunk for a 45 mm screen (docs/WATCH.md §4b).
//!
//! The replica already holds the agent's normalized rows for both runtimes
//! (`agent/src/history.ts` for Claude, `agent/src/codex.ts` for Codex):
//! `{type: user|assistant|system, uuid, blocks: [{kind, ...}], ts?}`. This only
//! picks the readable parts: prose of the person and the model, one line for a
//! run of tool calls. Tool results, thinking, images, system/meta rows and
//! sealed (`e2e`) rows are skipped.

use serde_json::{json, Value};

use crate::push_payload::{excerpt, strip_markdown};

/// Longest prose item, in characters (the cut ends in «…»).
pub const TEXT_MAX: usize = 600;
/// Longest tool label, in characters.
const LABEL_MAX: usize = 60;
/// Most items one answer carries.
pub const LIMIT_MAX: usize = 40;
pub const LIMIT_DEFAULT: usize = 24;
/// Raw rows read from the replica to fill `limit` simplified items.
pub const RAW_TAIL: usize = 400;

/// A run of consecutive tool calls, shown as one item.
#[derive(Default)]
struct ToolRun {
    /// `(name, count)` in order of first appearance.
    names: Vec<(String, usize)>,
    /// The label of the only call, while there is only one.
    label: Option<String>,
    calls: usize,
    ts: Option<i64>,
}

impl ToolRun {
    fn add(&mut self, name: &str, label: Option<String>, ts: Option<i64>) {
        match self.names.iter_mut().find(|(n, _)| n == name) {
            Some((_, count)) => *count += 1,
            None => self.names.push((name.to_string(), 1)),
        }
        self.calls += 1;
        self.label = if self.calls == 1 { label } else { None };
        self.ts = ts.or(self.ts);
    }

    fn item(self) -> Option<Value> {
        if self.calls == 0 {
            return None;
        }
        let text = if self.calls == 1 {
            let (name, _) = &self.names[0];
            match &self.label {
                Some(label) => format!("🔧 {name}: {label}"),
                None => format!("🔧 {name}"),
            }
        } else {
            let parts: Vec<String> = self
                .names
                .iter()
                .map(|(n, c)| {
                    if *c > 1 {
                        format!("{n} ×{c}")
                    } else {
                        n.clone()
                    }
                })
                .collect();
            format!("🔧 {}", parts.join(", "))
        };
        Some(item("tool", &excerpt(&text, TEXT_MAX), self.ts))
    }
}

fn item(role: &str, text: &str, ts: Option<i64>) -> Value {
    let mut v = json!({ "role": role, "text": text });
    if let Some(ts) = ts {
        v["ts"] = json!(ts);
    }
    v
}

/// A short label for a tool call: the file's name, the first words of a
/// command, a pattern or a URL.
fn tool_label(input: &Value) -> Option<String> {
    // Codex keeps its arguments as a string when they were not JSON.
    let parsed;
    let input = match input {
        Value::String(s) => match serde_json::from_str::<Value>(s) {
            Ok(v) if v.is_object() => {
                parsed = v;
                &parsed
            }
            _ => return Some(first_words(s)),
        },
        other => other,
    };
    let obj = input.as_object()?;
    for key in ["file_path", "path", "notebook_path"] {
        if let Some(p) = obj.get(key).and_then(Value::as_str) {
            let name = p.trim_end_matches('/').rsplit('/').next().unwrap_or(p);
            if !name.is_empty() {
                return Some(excerpt(name, LABEL_MAX));
            }
        }
    }
    for key in [
        "command",
        "cmd",
        "pattern",
        "query",
        "url",
        "description",
        "prompt",
    ] {
        let text = match obj.get(key) {
            Some(Value::String(s)) => s.clone(),
            // Codex `cmd` arrays.
            Some(Value::Array(a)) => a
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" "),
            _ => continue,
        };
        if !text.trim().is_empty() {
            return Some(first_words(&text));
        }
    }
    None
}

fn first_words(s: &str) -> String {
    let line = s.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    excerpt(
        &line.split_whitespace().collect::<Vec<_>>().join(" "),
        LABEL_MAX,
    )
}

/// Simplify `rows` (oldest first). Returns every item in order; the caller
/// keeps the newest `limit`.
pub fn simplify(rows: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut run = ToolRun::default();
    for row in rows {
        let role = match row.get("type").and_then(Value::as_str) {
            Some("user") => "user",
            Some("assistant") => "assistant",
            _ => continue,
        };
        // A sealed row has no blocks the hub may read.
        if row.get("e2e").is_some() {
            continue;
        }
        let ts = row.get("ts").and_then(Value::as_i64);
        let Some(blocks) = row.get("blocks").and_then(Value::as_array) else {
            continue;
        };
        let mut text = String::new();
        let flush = |text: &mut String, out: &mut Vec<Value>, run: &mut ToolRun| {
            if text.trim().is_empty() {
                text.clear();
                return;
            }
            let plain = strip_markdown(text);
            text.clear();
            if plain.is_empty() {
                return;
            }
            if let Some(tool) = std::mem::take(run).item() {
                out.push(tool);
            }
            out.push(item(role, &excerpt(&plain, TEXT_MAX), ts));
        };
        for block in blocks {
            match block.get("kind").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(t) = block.get("text").and_then(Value::as_str) {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(t);
                    }
                }
                Some("tool_use") if role == "assistant" => {
                    flush(&mut text, &mut out, &mut run);
                    let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                    let label = block.get("input").and_then(tool_label);
                    run.add(name, label, ts);
                }
                // tool_result, thinking, image, compact_*: not for a watch.
                _ => {}
            }
        }
        flush(&mut text, &mut out, &mut run);
    }
    if let Some(tool) = run.item() {
        out.push(tool);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(ty: &str, blocks: Value) -> Value {
        json!({"type": ty, "uuid": "u", "blocks": blocks})
    }

    #[test]
    fn claude_rows_keep_prose_and_collapse_tool_calls() {
        let rows = vec![
            row("user", json!([{"kind":"text","text":"**сделай** `это`"}])),
            row("assistant", json!([{"kind":"thinking","text":"hmm"}])),
            row(
                "assistant",
                json!([
                    {"kind":"text","text":"## Смотрю"},
                    {"kind":"tool_use","id":"1","name":"Bash","input":{"command":"ls -la /tmp"}},
                ]),
            ),
            row(
                "user",
                json!([{"kind":"tool_result","toolUseId":"1","text":"big"}]),
            ),
            row(
                "assistant",
                json!([{"kind":"tool_use","id":"2","name":"Bash","input":{"command":"pwd"}}]),
            ),
            row(
                "assistant",
                json!([{"kind":"tool_use","id":"3","name":"Edit","input":{"file_path":"/a/b/main.rs"}}]),
            ),
            row(
                "assistant",
                json!([{"kind":"tool_use","id":"4","name":"Bash","input":{"command":"x"}}]),
            ),
            row("assistant", json!([{"kind":"text","text":"Готово"}])),
            json!({"type":"system","blocks":[{"kind":"compact_boundary"}]}),
            row("user", json!([{"kind":"image","ref":"u#0"}])),
        ];
        let items = simplify(&rows);
        let got: Vec<(&str, &str)> = items
            .iter()
            .map(|i| (i["role"].as_str().unwrap(), i["text"].as_str().unwrap()))
            .collect();
        assert_eq!(
            got,
            [
                ("user", "сделай это"),
                ("assistant", "Смотрю"),
                ("tool", "🔧 Bash ×3, Edit"),
                ("assistant", "Готово"),
            ]
        );
    }

    #[test]
    fn a_lone_tool_call_names_its_target() {
        let rows = vec![row(
            "assistant",
            json!([{"kind":"tool_use","id":"1","name":"Read","input":{"file_path":"/srv/app/src/lib.rs"}}]),
        )];
        assert_eq!(simplify(&rows)[0]["text"], "🔧 Read: lib.rs");
    }

    #[test]
    fn codex_rows_with_string_arguments_and_cmd_arrays() {
        let rows = vec![
            row("user", json!([{"kind":"text","text":"привет"}])),
            row(
                "assistant",
                json!([{"kind":"tool_use","id":"c1","name":"shell","input":{"cmd":["git","status","-s"]}}]),
            ),
            row(
                "assistant",
                json!([{"kind":"tool_result","toolUseId":"c1","text":"ok"}]),
            ),
            row(
                "assistant",
                json!([{"kind":"tool_use","id":"c2","name":"exec_command","input":"cargo test --all"}]),
            ),
        ];
        let items = simplify(&rows);
        assert_eq!(items.len(), 2);
        assert_eq!(items[1]["role"], "tool");
        assert_eq!(items[1]["text"], "🔧 shell, exec_command");
        let single = simplify(&rows[3..]);
        assert_eq!(single[0]["text"], "🔧 exec_command: cargo test --all");
        let cmd = simplify(&rows[1..2]);
        assert_eq!(cmd[0]["text"], "🔧 shell: git status -s");
    }

    #[test]
    fn long_text_is_cut_with_an_ellipsis_and_sealed_rows_are_skipped() {
        let long = "а".repeat(900);
        let mut sealed = row("user", json!([{"kind":"text","text":"secret"}]));
        sealed["e2e"] = json!({"v":1});
        let mut stamped = row("assistant", json!([{"kind":"text","text":long}]));
        stamped["ts"] = json!(1234);
        let items = simplify(&[sealed, stamped]);
        assert_eq!(items.len(), 1);
        let text = items[0]["text"].as_str().unwrap();
        assert_eq!(text.chars().count(), TEXT_MAX);
        assert!(text.ends_with('…'));
        assert_eq!(items[0]["ts"], 1234);
        let long_label = simplify(&[row(
            "assistant",
            json!([{"kind":"tool_use","id":"1","name":"Bash","input":{"command":"y".repeat(200)}}]),
        )]);
        assert!(long_label[0]["text"].as_str().unwrap().chars().count() < 80);
        assert!(!items[0].to_string().contains("null"));
    }
}
