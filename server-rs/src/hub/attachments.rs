//! Bounds on what a person hands a run — pictures and files — and the
//! `user_turn` frame that tells the other screens about it. Pure functions:
//! nothing here touches hub state.

use super::*;

/// Longest text a `user_turn` carries to the other screens, in characters.
pub(super) const USER_TURN_TEXT_MAX: usize = 16 * 1024;
/// Most file names a `user_turn` lists.
const USER_TURN_FILES_MAX: usize = 20;

/// The `user_turn` frame for what a person just handed a run — or `None` when
/// they handed it nothing (a bare resume). Built from the SANITIZED
/// attachments, so a picture the hub dropped is not announced as sent.
/// Pictures travel as a count and files as names: the other screens need to
/// say that something was attached, not to carry the bytes a second time.
pub(super) fn user_turn_frame(
    run_id: &str,
    session_id: &str,
    text: Option<&str>,
    images: Option<&Value>,
    files: Option<&Value>,
) -> Option<Value> {
    let text = text.unwrap_or("");
    // Other screens need to SHOW the turn, not carry it: the whole text goes to
    // the agent and lands in the transcript. Uncapped, one huge paste was
    // serialised once per attached browser and, being larger than
    // `REPLAY_MAX_BYTES`, evicted the rest of the turn from the replay window.
    let (text, truncated) = match text.char_indices().nth(USER_TURN_TEXT_MAX) {
        Some((cut, _)) => (&text[..cut], true),
        None => (text, false),
    };
    let image_count = images.and_then(Value::as_array).map_or(0, Vec::len);
    let file_names: Vec<Value> = files
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|f| f.get("name").and_then(Value::as_str))
                .take(USER_TURN_FILES_MAX)
                .map(|n| Value::String(n.chars().take(255).collect()))
                .collect()
        })
        .unwrap_or_default();
    if text.trim().is_empty() && image_count == 0 && file_names.is_empty() {
        return None;
    }
    let mut frame = json!({
        "type": message::USER_TURN,
        "runId": run_id,
        "sessionId": session_id,
        "turnId": Uuid::new_v4().to_string(),
        "text": text,
        "ts": now_ms(),
    });
    if truncated {
        frame["truncated"] = json!(true);
    }
    if image_count > 0 {
        frame["images"] = json!(image_count);
    }
    if !file_names.is_empty() {
        frame["files"] = Value::Array(file_names);
    }
    Some(frame)
}

/// The `user_turn` of a PRIVATE machine: the sender's own envelope (text, image
/// count, file names), forwarded untouched. The hub cannot cap, count or trim
/// what it cannot read, and builds no text of its own.
pub(super) fn user_turn_frame_sealed(run_id: &str, session_id: &str, e2e: &Value) -> Value {
    json!({
        "type": message::USER_TURN,
        "runId": run_id,
        "sessionId": session_id,
        "turnId": Uuid::new_v4().to_string(),
        "text": "",
        "ts": now_ms(),
        "e2e": e2e,
    })
}

/// Validate + bound the optional `images` array against the wire ImageInput
/// shape (see shared/src/protocol.ts) before it reaches an agent: keep only
/// objects with an allowed `media_type` and a non-empty, size-bounded base64
/// `data` string, cap the count, and rebuild each entry so junk fields are
/// dropped. Returns None for a non-array, an empty array, or an all-invalid one
/// — so a bare `[]` never counts as a turn or forwards to the agent.
pub(super) fn sanitize_images(v: &Value) -> Option<Value> {
    const MAX_IMAGES: usize = 8;
    const MAX_B64_LEN: usize = 8 * 1024 * 1024; // ~6MB decoded per image
    const ALLOWED: [&str; 4] = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    let arr = v.as_array()?;
    let mut out = Vec::new();
    for item in arr {
        if out.len() >= MAX_IMAGES {
            break;
        }
        let (Some(mt), Some(data)) = (
            item.get("media_type").and_then(Value::as_str),
            item.get("data").and_then(Value::as_str),
        ) else {
            continue;
        };
        if !ALLOWED.contains(&mt) || data.is_empty() || data.len() > MAX_B64_LEN {
            continue;
        }
        // The API's many-image ceiling, enforced for EVERY client rather than
        // only the browser that learned to shrink before sending (see
        // src/images.rs). Header-probed first, so an image already inside the
        // line costs nothing on the message loop.
        match crate::images::shrink(mt, data) {
            Some((new_mt, new_data)) => out.push(json!({ "media_type": new_mt, "data": new_data })),
            None => out.push(json!({ "media_type": mt, "data": data })),
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(Value::Array(out))
    }
}

/// Recursively drop null object fields so optional protocol fields are absent
/// rather than `null`. Keys carrying opaque data are preserved verbatim.
/// Validate + bound the optional `files` array against the wire `FileInput`.
///
/// Sibling of `sanitize_images`, with two differences that matter: any content
/// type is allowed (a file is bytes the agent writes to disk, not something the
/// hub has to understand), and `name` is carried through — bounded here, and
/// reduced to a safe basename by the agent, which is the side that touches a
/// filesystem. The hub never opens these.
pub(super) fn sanitize_files(v: &Value) -> Option<Value> {
    const MAX_FILES: usize = 4;
    const MAX_B64_LEN: usize = 12 * 1024 * 1024; // ~9MB decoded per file
    const MAX_NAME: usize = 255;
    let arr = v.as_array()?;
    let mut out = Vec::new();
    for item in arr {
        if out.len() >= MAX_FILES {
            break;
        }
        let (Some(name), Some(data)) = (
            item.get("name").and_then(Value::as_str),
            item.get("data").and_then(Value::as_str),
        ) else {
            continue;
        };
        if name.is_empty() || name.len() > MAX_NAME || data.is_empty() || data.len() > MAX_B64_LEN {
            continue;
        }
        let mut file = json!({ "name": name, "data": data });
        if let Some(mt) = item
            .get("media_type")
            .and_then(Value::as_str)
            .filter(|m| !m.is_empty() && m.len() <= MAX_NAME)
        {
            file["media_type"] = Value::String(mt.to_string());
        }
        out.push(file);
    }
    if out.is_empty() {
        None
    } else {
        Some(Value::Array(out))
    }
}

/// Total base64 across images AND files in ONE message.
///
/// The per-item caps above cannot bound this on their own: 8 images of 8MB plus
/// 4 files of 12MB is 112MB of base64 in a single frame. That matters because a
/// frame over the socket ceiling is not a rejected request — it is a protocol
/// violation that closes the connection (see `WS_MAX_MESSAGE_BYTES` in ws_api.rs),
/// so the person's message vanishes and the app reconnects with no explanation.
///
/// The budget is therefore shared, and the tail that does not fit is dropped.
/// The web refuses over this before it sends, so a message arriving here over
/// budget means a non-web client or a tab running older code.
pub(super) const MAX_ATTACH_B64_TOTAL: usize = 20 * 1024 * 1024;

/// Sanitise both attachment arrays under one shared byte budget.
///
/// Every path that forwards attachments to an agent (`open`, `new_session`,
/// `input`) goes through this, so the bound cannot be enforced on one road and
/// forgotten on another.
pub(super) fn sanitize_attachments(
    images: Option<&Value>,
    files: Option<&Value>,
) -> (Option<Value>, Option<Value>) {
    let mut budget = MAX_ATTACH_B64_TOTAL;
    // Images first: one inlined screenshot is the common case and the one a
    // person notices losing. Files are read from disk by path, so a dropped tail
    // degrades to "the agent was told about fewer files", not a broken turn.
    let images = images
        .and_then(sanitize_images)
        .and_then(|v| fit_budget(v, &mut budget));
    let files = files
        .and_then(sanitize_files)
        .and_then(|v| fit_budget(v, &mut budget));
    (images, files)
}

/// What `sanitize_attachments` left out, as one sentence for the person who
/// attached it — or None when everything went through.
///
/// The budget used to be enforced in silence: the tail that did not fit was
/// dropped, the turn went on without it, and the person found out when the
/// agent answered about a picture it had never seen. Counting in and out is
/// enough to say so; the client shows it as an error with `attachments_dropped`
/// while still delivering the text.
pub(super) fn attachment_loss(
    images_in: Option<&Value>,
    files_in: Option<&Value>,
    images_out: Option<&Value>,
    files_out: Option<&Value>,
) -> Option<String> {
    let count = |v: Option<&Value>| v.and_then(Value::as_array).map_or(0, Vec::len);
    let (img_in, img_out) = (count(images_in), count(images_out));
    let (fil_in, fil_out) = (count(files_in), count(files_out));
    let mut parts = Vec::new();
    if img_out < img_in {
        parts.push(format!("{} of {} image(s)", img_in - img_out, img_in));
    }
    if fil_out < fil_in {
        parts.push(format!("{} of {} file(s)", fil_in - fil_out, fil_in));
    }
    if parts.is_empty() {
        return None;
    }
    Some(format!(
        "{} did not fit and were NOT sent (per message: at most {} images and {} files, {} MB of attachments in total). The text was delivered.",
        parts.join(" and "),
        8,
        4,
        MAX_ATTACH_B64_TOTAL / (1024 * 1024),
    ))
}

/// Keep leading entries while they fit `budget`, drop the rest.
fn fit_budget(v: Value, budget: &mut usize) -> Option<Value> {
    let arr = v.as_array()?;
    let mut out = Vec::new();
    for item in arr {
        let len = item.get("data").and_then(Value::as_str).map_or(0, str::len);
        if len > *budget {
            break;
        }
        *budget -= len;
        out.push(item.clone());
    }
    if out.is_empty() {
        None
    } else {
        Some(Value::Array(out))
    }
}

const NO_RECURSE: &[&str] = &[
    "input", "params", "result", "raw", "messages", "images", "files",
];
pub(super) fn clean(v: &Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(
            m.iter()
                .filter(|(_, val)| !val.is_null())
                .map(|(k, val)| {
                    let nv = if NO_RECURSE.contains(&k.as_str()) {
                        val.clone()
                    } else {
                        clean(val)
                    };
                    (k.clone(), nv)
                })
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.iter().map(clean).collect()),
        other => other.clone(),
    }
}
