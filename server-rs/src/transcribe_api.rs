//! Dictation endpoints: `POST /transcribe` (speech-to-text through the fleet
//! GPU or Azure, with fallback) and `POST /polish` (clean-up of what was
//! dictated through the LLM gateway, `polish.rs`).

use super::*;

/// Speech-to-text for dictation. The browser posts raw audio bytes with a
/// Content-Type; the optional `project` query param labels the project for the
/// recognition prompt, `dur` (seconds) sizes the GPU's head start, `hints` adds
/// session terms to that prompt. Engines: the fleet GPU (`STT_URL`) and an
/// OpenAI-compatible cloud (`CLOUD_STT_URL`). With both, the GPU gets a head
/// start proportional to the clip and then the cloud is raced against it; a
/// GPU the health probe last saw away is skipped straight to the cloud.
/// `TRANSCRIBE_PRIMARY=cloud` (or `azure`) puts the cloud first. Answers
/// `{ "text": "...", "engine": "gpu"|"cloud" }`.
pub(crate) async fn transcribe(
    Query(params): Query<HashMap<String, String>>,
    State(st): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // A cookie-authenticated POST from another site must not spend our GPU.
    if !same_origin(&headers) {
        return api_error(StatusCode::FORBIDDEN, "cross-site request rejected");
    }
    let user = match ui_user(&params, &headers, &st) {
        Ok(v) => v,
        Err(_) => return (StatusCode::UNAUTHORIZED, "unauthorized").into_response(),
    };
    // Transcription spends GPU/Azure capacity: a waitlisted sign-up must not.
    gate!(require_active(&st, &user));
    let azure_ok = st.azure_url.is_some() && st.azure_key.is_some();
    let gpu_ok = st.stt_url.is_some();
    if !gpu_ok && !azure_ok {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "transcription not configured",
        )
            .into_response();
    }
    if body.is_empty() {
        return (StatusCode::BAD_REQUEST, "empty audio").into_response();
    }
    let _permit = match st.transcribe_limit.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                "too many concurrent transcription requests",
            )
                .into_response()
        }
    };
    let ct = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("audio/webm")
        .to_string();
    let filename = if ct.contains("mp4") || ct.contains("m4a") {
        "audio.mp4"
    } else if ct.contains("mpeg") || ct.contains("mp3") {
        "audio.mp3"
    } else if ct.contains("wav") {
        "audio.wav"
    } else if ct.contains("ogg") {
        "audio.ogg"
    } else {
        "audio.webm"
    };
    if reqwest::multipart::Part::bytes(Vec::new())
        .mime_str(&ct)
        .is_err()
    {
        return (StatusCode::BAD_REQUEST, "invalid audio content type").into_response();
    }
    let hints = params
        .get("hints")
        .map(|h| polish::sanitize_hints(h))
        .unwrap_or_default();
    let prompt = st.transcribe_prompt_on.then(|| {
        polish::transcribe_prompt_with(
            &st.transcribe_glossary,
            params.get("project").map(String::as_str),
            &hints,
        )
    });
    let prompt = prompt.as_deref();
    let dur = clip_seconds(params.get("dur").map(String::as_str), body.len(), &ct);
    let audio = body.to_vec();
    let call = Call {
        st: &st,
        audio: &audio,
        filename,
        ct: &ct,
        prompt,
        hints: &hints,
        dur,
    };

    let outcome = if gpu_ok && azure_ok {
        let gpu = st.stt_health.snapshot();
        if st.transcribe_primary_azure {
            call.sequential(&["cloud", "gpu"], Duration::from_secs(20))
                .await
        } else if !gpu.up {
            // The card is known to be away: no point spending the person's
            // seconds finding that out again. If the cloud fails too, the GPU
            // gets one short try — the probe can lag a tunnel that just came back.
            eprintln!("[transcribe] gpu down per health probe; cloud first");
            call.sequential(&["cloud", "gpu"], Duration::from_secs(3))
                .await
        } else {
            // The card is up: give it the time a clip this long takes there,
            // then race the cloud. A queue in front of us means that time is
            // not ours — race right away.
            // Clips under 3 min ride the box's fast lane and jump the long
            // recordings, so only that lane's queue is in front of a dictation.
            let ahead = if dur <= 180.0 {
                gpu.queued_fast
            } else {
                gpu.queued
            };
            let head_start = if ahead > 0 {
                Duration::ZERO
            } else {
                gpu_head_start(dur)
            };
            call.hedged(head_start, Duration::from_secs(20)).await
        }
    } else if gpu_ok && !st.stt_health.snapshot().up {
        // GPU only, and the probe says it is away: one short try (the probe
        // can be a few seconds behind a tunnel that just came back), then a
        // fast refusal — the phone falls back to its own text and the web
        // offers a retry, instead of both sitting out a 90 s deadline.
        eprintln!("[transcribe] gpu down per health probe; short try");
        call.sequential(&["gpu"], Duration::from_secs(3)).await
    } else if gpu_ok {
        let deadline = Duration::from_secs(
            std::env::var("STT_GPU_DEADLINE_SECS")
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .filter(|v| *v > 0)
                .unwrap_or(90),
        );
        call.sequential(&["gpu"], deadline).await
    } else {
        call.sequential(&["cloud"], Duration::ZERO).await
    };
    match outcome {
        Outcome::Text(engine, text) => {
            Json(serde_json::json!({ "text": text, "engine": engine })).into_response()
        }
        // A written-back prompt is not speech: nothing was said.
        Outcome::Echo(engine) => {
            Json(serde_json::json!({ "text": "", "engine": engine })).into_response()
        }
        Outcome::Failed { timeout: true } => {
            (StatusCode::GATEWAY_TIMEOUT, "transcription timed out").into_response()
        }
        Outcome::Failed { timeout: false } => {
            (StatusCode::BAD_GATEWAY, "transcription failed").into_response()
        }
    }
}

/// Seconds of audio in the clip: the client's `dur` when it sent one, else a
/// guess from the size at a generous bitrate (a guess that runs long only
/// makes the GPU's head start longer — the slower failure mode, not a wrong one).
fn clip_seconds(dur: Option<&str>, bytes: usize, ct: &str) -> f64 {
    if let Some(d) = dur.and_then(|d| d.trim().parse::<f64>().ok()) {
        if d.is_finite() && d > 0.0 {
            return d.min(3600.0);
        }
    }
    // webm/ogg opus records at ~32 kbit/s; the iOS app's m4a/aac at 48 (mono).
    let bytes_per_sec = if ct.contains("mp4") || ct.contains("m4a") || ct.contains("mpeg") {
        6_000.0
    } else if ct.contains("wav") {
        32_000.0
    } else {
        4_000.0
    };
    bytes as f64 / bytes_per_sec
}

/// How long the GPU gets alone before the cloud is raced against it. The card
/// does a 15 s clip in ~1.5 s round trip through both tunnels when it is free;
/// this leaves it 2.5 s + 12% of the clip, capped at 10 s — over that it is not
/// free, and waiting longer only costs the person.
fn gpu_head_start(clip_secs: f64) -> Duration {
    let base = std::env::var("STT_HEDGE_BASE_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(2_500);
    let extra = (clip_secs.max(0.0) * 120.0) as u64;
    Duration::from_millis((base + extra).min(10_000))
}

enum Outcome {
    Text(&'static str, String),
    Echo(&'static str),
    Failed { timeout: bool },
}

/// One dictation's audio and everything an engine needs to read it.
struct Call<'a> {
    st: &'a AppState,
    audio: &'a [u8],
    filename: &'a str,
    ct: &'a str,
    prompt: Option<&'a str>,
    /// Sanitised session hints (also in `prompt`), for the echo check.
    hints: &'a str,
    /// Clip length in seconds, for the cloud's timeout.
    dur: f64,
}

/// One engine's attempt. `Err` carries a loggable reason; ECHO marks a
/// written-back prompt (that engine heard nothing it could use).
type Attempt = Result<String, String>;
const ECHO: &str = "prompt echo";

impl Call<'_> {
    async fn run(&self, engine: &'static str, gpu_deadline: Duration) -> Attempt {
        let started = Instant::now();
        let result = if engine == "gpu" {
            let base = self.st.stt_url.clone().unwrap_or_default();
            transcribe_gpu(
                self.st,
                &base,
                self.audio.to_vec(),
                self.filename,
                self.ct,
                self.prompt,
                gpu_deadline,
            )
            .await
        } else {
            transcribe_azure(
                self.st,
                self.audio.to_vec(),
                self.filename,
                self.ct,
                self.prompt,
                self.dur,
            )
            .await
        };
        let ms = started.elapsed().as_millis();
        match result {
            // Nothing heard counts as silence, not a win: an empty fast answer
            // must not cancel a slower engine that is reading real speech.
            Ok(text)
                if text.trim().is_empty()
                    || self
                        .prompt
                        .is_some_and(|p| polish::is_prompt_echo(&text, p))
                    || polish::is_hints_echo(&text, self.hints) =>
            {
                eprintln!("[transcribe] {engine}: empty or prompt echo ({ms} ms)");
                Err(ECHO.into())
            }
            Ok(text) => {
                eprintln!("[transcribe] {engine}: ok in {ms} ms");
                Ok(text)
            }
            Err(reason) => {
                eprintln!("[transcribe] {engine} failed in {ms} ms: {reason}");
                Err(reason)
            }
        }
    }

    /// Engines one after another; the first that reads the clip wins.
    async fn sequential(&self, order: &[&'static str], gpu_deadline: Duration) -> Outcome {
        let mut failures = Vec::new();
        for engine in order {
            match self.run(engine, gpu_deadline).await {
                Ok(text) => return Outcome::Text(engine, text),
                Err(reason) => failures.push((*engine, reason)),
            }
        }
        settle(&failures)
    }

    /// GPU first; the cloud joins after `head_start` (or the moment the GPU
    /// fails), and whichever reads the clip first wins. The loser is dropped:
    /// a GPU job left behind is deleted by its guard so it does not hold the
    /// card for the next dictation.
    async fn hedged(&self, head_start: Duration, gpu_deadline: Duration) -> Outcome {
        let gpu_failed = tokio::sync::Notify::new();
        let gpu = async {
            let r = self.run("gpu", gpu_deadline).await;
            if r.is_err() {
                gpu_failed.notify_one();
            }
            r
        };
        let cloud = async {
            tokio::select! {
                _ = tokio::time::sleep(head_start) => {
                    eprintln!("[transcribe] gpu silent after {} ms; racing cloud", head_start.as_millis());
                }
                _ = gpu_failed.notified() => {}
            }
            self.run("cloud", gpu_deadline).await
        };
        tokio::pin!(gpu, cloud);
        let mut failures: Vec<(&'static str, String)> = Vec::new();
        let (mut gpu_done, mut cloud_done) = (false, false);
        while !(gpu_done && cloud_done) {
            tokio::select! {
                r = &mut gpu, if !gpu_done => {
                    gpu_done = true;
                    match r {
                        Ok(text) => return Outcome::Text("gpu", text),
                        Err(reason) => failures.push(("gpu", reason)),
                    }
                }
                r = &mut cloud, if !cloud_done => {
                    cloud_done = true;
                    match r {
                        Ok(text) => return Outcome::Text("cloud", text),
                        Err(reason) => failures.push(("cloud", reason)),
                    }
                }
            }
        }
        settle(&failures)
    }
}

/// Every engine failed: an echo anywhere means the clip held nothing to read
/// (an empty answer, not an error); otherwise the last reason picks the status.
fn settle(failures: &[(&'static str, String)]) -> Outcome {
    // Silence only when every engine heard silence: an echo next to a real
    // failure is a 5xx, so the client keeps the clip for a retry.
    if let Some((engine, _)) = failures
        .first()
        .filter(|_| failures.iter().all(|(_, r)| r == ECHO))
    {
        return Outcome::Echo(engine);
    }
    Outcome::Failed {
        timeout: failures
            .last()
            .is_some_and(|(_, r)| r == TRANSCRIBE_TIMEOUT),
    }
}

/// What the hub last heard from the GPU box's `/health`, refreshed in the
/// background (`watch_stt_health`) so a dictation never pays for finding out
/// that the card is away.
#[derive(Default)]
pub(crate) struct SttHealth {
    /// Unix ms of the last good probe; 0 = never.
    last_ok_ms: std::sync::atomic::AtomicU64,
    queued: std::sync::atomic::AtomicU64,
    queued_fast: std::sync::atomic::AtomicU64,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct SttHealthSnapshot {
    pub up: bool,
    pub queued: u64,
    /// The box's fast lane (clips under 3 min), which dictation rides.
    pub queued_fast: u64,
}

/// Probe period and timeout, and how stale the last good probe may be before
/// the card counts as away: two whole missed cycles (sleep + timed-out probe)
/// plus slack — one slow `/health` from a busy box must not flip the route.
const STT_PROBE_EVERY: Duration = Duration::from_secs(5);
const STT_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const STT_STALE_MS: u64 = 2 * (5_000 + 3_000) + 2_000;

impl SttHealth {
    pub(crate) fn snapshot(&self) -> SttHealthSnapshot {
        use std::sync::atomic::Ordering::Relaxed;
        let last = self.last_ok_ms.load(Relaxed);
        SttHealthSnapshot {
            // Never probed yet (hub just started): assume up, the hedge covers it.
            up: last == 0 || now_ms().saturating_sub(last) <= STT_STALE_MS,
            queued: self.queued.load(Relaxed),
            queued_fast: self.queued_fast.load(Relaxed),
        }
    }

    fn record(&self, ok: bool, queued: u64, queued_fast: u64) {
        use std::sync::atomic::Ordering::Relaxed;
        if ok {
            self.last_ok_ms.store(now_ms(), Relaxed);
            self.queued.store(queued, Relaxed);
            self.queued_fast.store(queued_fast, Relaxed);
        } else if self.last_ok_ms.load(Relaxed) == 0 {
            // First probe failed: mark as known-away rather than "never probed".
            self.last_ok_ms.store(1, Relaxed);
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Background probe of `STT_URL/health`, spawned whenever a GPU is configured:
/// with a cloud it picks the route, without one it turns a 90 s wait on a
/// card that is away into a fast refusal.
pub(crate) async fn watch_stt_health(st: AppState) {
    let Some(base) = st.stt_url.clone() else {
        return;
    };
    let mut was_up: Option<bool> = None;
    loop {
        let mut req = st
            .azure_http
            .get(format!("{base}/health"))
            .timeout(STT_PROBE_TIMEOUT);
        if let Some(tok) = st.stt_token.as_ref() {
            req = req.bearer_auth(tok);
        }
        let probe = async {
            let resp = req.send().await.ok()?;
            if !resp.status().is_success() {
                return None;
            }
            let v: serde_json::Value = resp.json().await.ok()?;
            // `model_loaded: false` is NOT away: the box loads whisper lazily on
            // the first job after a restart (a few seconds, then it stays).
            if v.get("ok").and_then(|b| b.as_bool()) == Some(false) {
                return None;
            }
            let n = |k: &str| v.get(k).and_then(|q| q.as_u64());
            let queued = n("queued").unwrap_or(0);
            // An older server has no fast lane: everything waits in `queued`.
            Some((queued, n("queued_fast").unwrap_or(queued)))
        };
        let queues = probe.await;
        let (queued, queued_fast) = queues.unwrap_or((0, 0));
        st.stt_health.record(queues.is_some(), queued, queued_fast);
        let up = queues.is_some();
        if was_up != Some(up) {
            eprintln!(
                "[transcribe] gpu health: {}",
                if up { "up" } else { "down" }
            );
            was_up = Some(up);
        }
        tokio::time::sleep(STT_PROBE_EVERY).await;
    }
}

/// The `language` sent to the cloud engine — `CLOUD_STT_LANGUAGE`, default
/// `ru`; `auto` (or empty) sends none. xAI's `/v1/stt` with `language=ru`
/// spells English terms in Cyrillic («юз рекордер», «джорнал сити эл»); left
/// to detect, it keeps `useRecorder` and `journalctl` as written.
fn cloud_language() -> Option<&'static str> {
    static LANG: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    LANG.get_or_init(|| {
        let v = std::env::var("CLOUD_STT_LANGUAGE").unwrap_or_else(|_| "ru".into());
        let v = v.trim();
        (!v.is_empty() && !v.eq_ignore_ascii_case("auto")).then(|| v.to_string())
    })
    .as_deref()
}

/// Reason string of an engine that ran out of time (maps to a 504).
const TRANSCRIBE_TIMEOUT: &str = "timed out";

/// The cloud engine: any OpenAI-compatible `/audio/transcriptions` endpoint —
/// xAI `/v1/stt` in production (`CLOUD_STT_LANGUAGE=auto`), Azure
/// gpt-4o-transcribe before it
/// (`CLOUD_STT_*`, falling back to the old `AZURE_TRANSCRIBE_*` names).
/// `Err` is a loggable reason.
async fn transcribe_azure(
    st: &AppState,
    audio: Vec<u8>,
    filename: &str,
    ct: &str,
    prompt: Option<&str>,
    dur: f64,
) -> Result<String, String> {
    let (Some(url), Some(key)) = (st.azure_url.as_ref(), st.azure_key.as_ref()) else {
        return Err("not configured".into());
    };
    let part = reqwest::multipart::Part::bytes(audio)
        .file_name(filename.to_string())
        .mime_str(ct)
        .map_err(|_| "invalid content type".to_string())?;
    let mut form = reqwest::multipart::Form::new().text("model", st.azure_model.clone());
    if let Some(lang) = cloud_language() {
        form = form.text("language", lang);
    }
    let mut form = form.part("file", part);
    if let Some(prompt) = prompt {
        form = form.text("prompt", prompt.to_string());
    }
    // Bounded by the clip: a dictation (the cloud reads minutes in a second or
    // two) stays inside the phone's 45 s; a long web recording gets the time
    // an engine like gpt-4o-transcribe needs, up to the client's 90 s.
    let budget = (15.0 + dur.max(0.0) * 0.25).min(90.0);
    let response = st
        .azure_http
        .post(url)
        .timeout(Duration::from_secs_f64(budget))
        .bearer_auth(key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                TRANSCRIBE_TIMEOUT.to_string()
            } else {
                format!("request: {e}")
            }
        })?;
    let status = response.status();
    let txt = response
        .text()
        .await
        .map_err(|e| format!("response body: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "status {status}: {}",
            txt.chars().take(300).collect::<String>()
        ));
    }
    // Only the OpenAI-compatible shape counts: a 200 error envelope or a
    // proxy's HTML page must not win the race against the GPU — or be sent.
    serde_json::from_str::<serde_json::Value>(&txt)
        .ok()
        .and_then(|v| v.get("text").and_then(|t| t.as_str()).map(str::to_string))
        .ok_or_else(|| {
            format!(
                "unexpected body: {}",
                txt.chars().take(120).collect::<String>()
            )
        })
}

/// Rewrite dictated text as what the person meant to type (`polish.rs`).
///
/// Answers `{ text, polished }`. A gateway failure is NOT an error for the
/// client: it gets its own text back with `polished: false`, so the one thing
/// that can never happen is a dictation lost to a clean-up step. Unconfigured
/// is a 503 the web latches, so it stops paying a round trip per recording.
pub(crate) async fn polish_text(
    Query(params): Query<HashMap<String, String>>,
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<polish::PolishRequest>,
) -> Response {
    let user = match ui_user(&params, &headers, &st) {
        Ok(v) => v,
        Err(_) => return (StatusCode::UNAUTHORIZED, "unauthorized").into_response(),
    };
    // Spends the shared subscription: a waitlisted sign-up must not.
    gate!(require_active(&st, &user));
    let Some(polisher) = st.polisher.clone() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "polish not configured").into_response();
    };
    // Per person, because the seat is shared: a dictation is one call per
    // recording, so a minute holds a handful and an hour a busy day's worth.
    // Past that it is not dictation — it is free inference on the service key,
    // and it would starve everyone else's permits and the enrichment quota.
    // The client inserts the raw text on a 429, so a real person loses nothing.
    let mut windows = Vec::with_capacity(2);
    for (scope, limit, window_ms) in [("m", 20, 60_000), ("h", 150, 3_600_000)] {
        match check_window_quota(
            &st,
            &format!("polish:{scope}:{user}"),
            limit,
            window_ms,
            "too many polish requests",
        ) {
            Ok(key) => windows.push((key, window_ms)),
            Err(e) => return e,
        }
    }
    for (key, window_ms) in &windows {
        record_window_hit(&st, key, *window_ms);
    }
    if req.text.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "empty text").into_response();
    }
    if req.text.chars().count() > polish::MAX_TEXT {
        return (StatusCode::PAYLOAD_TOO_LARGE, "text too long").into_response();
    }
    match polisher.polish(&req).await {
        Ok(text) => Json(json!({ "text": text, "polished": true })).into_response(),
        Err(reason) => {
            eprintln!("[polish] {reason}");
            Json(json!({ "text": req.text.trim(), "polished": false })).into_response()
        }
    }
}

/// Transcribe on the fleet's GPU (faster-whisper / large-v3 on buildbox-pc).
///
/// The job API is ASYNCHRONOUS by design — a card is one queue and an hour of
/// audio is minutes of work, so it hands back an id and is polled. Dictation is
/// the short tail of that: measured on this fleet, 8s of speech is 1.5s of GPU
/// and 15s is 1.9s, so the poll is what decides the felt latency, not the card.
/// Hence 150ms here rather than the CLI's ten seconds — the CLI is built for
/// hour-long files, and using it as-is made a two-second job look like eleven.
///
/// The URL is a LOOPBACK address: buildbox-pc has no inbound ports and dials a
/// reverse tunnel to dev-box-1, which dials a second one to this box. Both hops
/// can be down; every failure below is therefore reported as a plain refusal so
/// the composer keeps the recording instead of silently losing it.
async fn transcribe_gpu(
    st: &AppState,
    base: &str,
    audio: Vec<u8>,
    filename: &str,
    ct: &str,
    prompt: Option<&str>,
    deadline: Duration,
) -> Result<String, String> {
    // The deadline covers the WHOLE attempt — submit included — so a hung
    // tunnel cannot hold the request past the point where the fallback engine
    // (and the phone's own timeout) still has a chance.
    let deadline = Instant::now() + deadline;
    let left = || deadline.saturating_duration_since(Instant::now());
    let part = reqwest::multipart::Part::bytes(audio)
        .file_name(filename.to_string())
        .mime_str(ct)
        .map_err(|_| "invalid content type".to_string())?;
    // `language=ru` is not a guess: this product speaks Russian to its users and
    // whisper's autodetect on two seconds of speech is a coin toss that fails
    // loudly — a Russian sentence transcribed as Polish is worse than nothing.
    let mut form = reqwest::multipart::Form::new()
        .text("language", "ru")
        .text("word_timestamps", "false")
        .part("file", part);
    if let Some(prompt) = prompt {
        form = form.text("initial_prompt", prompt.to_string());
    }
    let mut req = st
        .azure_http
        .post(format!("{base}/jobs"))
        .timeout(left())
        .multipart(form);
    if let Some(tok) = st.stt_token.as_ref() {
        req = req.bearer_auth(tok);
    }
    // The submit runs in its own task. If this attempt is dropped while the
    // box has already queued the job but its id is still on the wire — the
    // cloud won the race, the client hung up — the guard below does not exist
    // yet; the task sees nobody waiting for the id and deletes the job itself.
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let http = st.azure_http.clone();
    let token = st.stt_token.clone();
    let jobs_url = format!("{base}/jobs");
    tokio::spawn(async move {
        let result = async {
            let submitted = req.send().await.map_err(|e| {
                if e.is_timeout() {
                    TRANSCRIBE_TIMEOUT.to_string()
                } else {
                    format!("submit: {e}")
                }
            })?;
            if !submitted.status().is_success() {
                return Err(format!("submit status {}", submitted.status()));
            }
            let job: serde_json::Value = submitted
                .json()
                .await
                .map_err(|e| format!("submit body: {e}"))?;
            job.get("id")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .ok_or_else(|| "submit: no job id".to_string())
        }
        .await;
        if let Err(Ok(id)) = tx.send(result) {
            drop(GpuJobGuard {
                http,
                url: format!("{jobs_url}/{id}"),
                token,
                armed: true,
            });
        }
    });
    let id = rx.await.map_err(|_| "submit: task lost".to_string())??;
    let id = id.as_str();
    // One card, one worker: a job this request walks away from — deadline,
    // poll error, or the client hanging up and the handler being dropped —
    // would still be computed and delay every dictation behind it.
    let mut guard = GpuJobGuard {
        http: st.azure_http.clone(),
        url: format!("{base}/jobs/{id}"),
        token: st.stt_token.clone(),
        armed: true,
    };

    // Bounded wait. A dictation clip is seconds of work, but the card is shared
    // with whatever else the fleet submitted, so the ceiling covers a short
    // queue without letting a stuck worker hold this request open forever.
    loop {
        if left().is_zero() {
            return Err(TRANSCRIBE_TIMEOUT.into());
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
        let mut poll = st.azure_http.get(&guard.url).timeout(
            left()
                .min(Duration::from_secs(5))
                .max(Duration::from_millis(100)),
        );
        if let Some(tok) = st.stt_token.as_ref() {
            poll = poll.bearer_auth(tok);
        }
        let state: serde_json::Value = poll
            .send()
            .await
            .map_err(|e| format!("poll: {e}"))?
            .json()
            .await
            .map_err(|e| format!("poll body: {e}"))?;
        match state.get("status").and_then(|v| v.as_str()) {
            Some("done") => {
                guard.armed = false;
                let text = state.get("text").and_then(|t| t.as_str()).unwrap_or("");
                return Ok(text.trim().to_string());
            }
            Some("error") => {
                guard.armed = false;
                return Err(format!(
                    "job {id}: {}",
                    state.get("error").and_then(|e| e.as_str()).unwrap_or("?")
                ));
            }
            _ => {}
        }
    }
}

/// Deletes an unfinished GPU job on any exit that did not see it finish.
/// Fire-and-forget with a short timeout: the answer is moot.
struct GpuJobGuard {
    http: reqwest::Client,
    url: String,
    token: Option<String>,
    armed: bool,
}

impl Drop for GpuJobGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut req = self
            .http
            .delete(std::mem::take(&mut self.url))
            .timeout(Duration::from_secs(5));
        if let Some(tok) = self.token.as_ref() {
            req = req.bearer_auth(tok);
        }
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async move {
                let _ = req.send().await;
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_seconds_prefers_client_duration() {
        assert_eq!(clip_seconds(Some("12.5"), 1, "audio/webm"), 12.5);
        assert_eq!(clip_seconds(Some("nan"), 40_000, "audio/webm"), 10.0);
        assert_eq!(clip_seconds(Some("-3"), 60_000, "audio/mp4"), 10.0);
        assert_eq!(clip_seconds(None, 320_000, "audio/wav"), 10.0);
        assert_eq!(clip_seconds(Some("1e9"), 1, "audio/webm"), 3600.0);
    }

    #[test]
    fn gpu_head_start_grows_with_the_clip_and_is_capped() {
        assert_eq!(gpu_head_start(0.0), Duration::from_millis(2_500));
        assert_eq!(gpu_head_start(15.0), Duration::from_millis(4_300));
        assert_eq!(gpu_head_start(600.0), Duration::from_millis(10_000));
    }

    #[test]
    fn settle_reads_echo_as_silence_and_timeout_as_504() {
        let echo = settle(&[("gpu", ECHO.into()), ("cloud", ECHO.into())]);
        assert!(matches!(echo, Outcome::Echo("gpu")));
        let mixed = settle(&[("gpu", TRANSCRIBE_TIMEOUT.into()), ("cloud", ECHO.into())]);
        assert!(matches!(mixed, Outcome::Failed { timeout: false }));
        let t = settle(&[
            ("cloud", "status 500".into()),
            ("gpu", TRANSCRIBE_TIMEOUT.into()),
        ]);
        assert!(matches!(t, Outcome::Failed { timeout: true }));
        let f = settle(&[
            ("gpu", TRANSCRIBE_TIMEOUT.into()),
            ("cloud", "status 500".into()),
        ]);
        assert!(matches!(f, Outcome::Failed { timeout: false }));
    }

    #[test]
    fn health_snapshot_goes_stale() {
        let h = SttHealth::default();
        assert!(h.snapshot().up, "never probed: assume up");
        h.record(false, 0, 0);
        assert!(!h.snapshot().up, "first probe failed: away");
        h.record(true, 2, 0);
        let s = h.snapshot();
        assert!(s.up && s.queued == 2 && s.queued_fast == 0);
        h.last_ok_ms.store(
            now_ms() - STT_STALE_MS - 1,
            std::sync::atomic::Ordering::Relaxed,
        );
        assert!(!h.snapshot().up);
    }

    // ------------------------------------------------- the race, end to end

    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A fake GPU box (`/jobs` API) that finishes after `gpu_ms` (or refuses
    /// the submit when `None`), and a fake cloud that answers after `cloud_ms`.
    /// Returns the state pointed at both plus the count of GPU job DELETEs.
    async fn fakes(
        gpu_ms: Option<u64>,
        cloud_ms: u64,
    ) -> (AppState, Arc<AtomicUsize>, std::path::PathBuf) {
        fakes_with(gpu_ms, cloud_ms, 0, "cloud text").await
    }

    async fn fakes_with(
        gpu_ms: Option<u64>,
        cloud_ms: u64,
        submit_ms: u64,
        cloud_text: &'static str,
    ) -> (AppState, Arc<AtomicUsize>, std::path::PathBuf) {
        use axum::routing::{get, post};
        let deletes = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(Mutex::new(None::<Instant>));
        let (s1, s2, d) = (started.clone(), started.clone(), deletes.clone());
        let gpu = Router::new()
            .route(
                "/jobs",
                post(move || {
                    let s1 = s1.clone();
                    async move {
                        if gpu_ms.is_none() {
                            return (StatusCode::INTERNAL_SERVER_ERROR, "no").into_response();
                        }
                        // Queued on arrival; the id comes back `submit_ms` later.
                        *s1.lock().unwrap() = Some(Instant::now());
                        tokio::time::sleep(Duration::from_millis(submit_ms)).await;
                        Json(serde_json::json!({ "id": "j1" })).into_response()
                    }
                }),
            )
            .route(
                "/jobs/j1",
                get(move || {
                    let s2 = s2.clone();
                    async move {
                        let at = s2.lock().unwrap().unwrap();
                        let done = at.elapsed() >= Duration::from_millis(gpu_ms.unwrap_or(0));
                        Json(if done {
                            serde_json::json!({ "status": "done", "text": "gpu text" })
                        } else {
                            serde_json::json!({ "status": "running" })
                        })
                    }
                })
                .delete(move || {
                    let d = d.clone();
                    async move {
                        d.fetch_add(1, Ordering::SeqCst);
                        StatusCode::OK
                    }
                }),
            );
        let cloud = Router::new().route(
            "/v1/audio/transcriptions",
            post(move || async move {
                tokio::time::sleep(Duration::from_millis(cloud_ms)).await;
                Json(serde_json::json!({ "text": cloud_text }))
            }),
        );
        let serve = |app: Router| async move {
            let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = l.local_addr().unwrap();
            tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
            format!("http://{addr}")
        };
        let gpu_url = serve(gpu).await;
        let cloud_url = serve(cloud).await;
        let store = WorkspaceStore::open_memory();
        let db = crate::account::tests::temp_db();
        let mut st = crate::account::tests::app_state(store, &db);
        st.stt_url = Some(gpu_url);
        st.azure_url = Some(format!("{cloud_url}/v1/audio/transcriptions"));
        st.azure_key = Some("k".into());
        (st, deletes, db)
    }

    async fn race(st: &AppState, head_start_ms: u64) -> (Outcome, Duration) {
        let audio = vec![0u8; 16];
        let call = Call {
            st,
            audio: &audio,
            filename: "a.webm",
            ct: "audio/webm",
            prompt: None,
            hints: "",
            dur: 5.0,
        };
        let t = Instant::now();
        let out = call
            .hedged(
                Duration::from_millis(head_start_ms),
                Duration::from_secs(20),
            )
            .await;
        (out, t.elapsed())
    }

    #[tokio::test]
    async fn a_free_gpu_wins_inside_its_head_start() {
        let (st, deletes, db) = fakes(Some(100), 50).await;
        let (out, took) = race(&st, 1_500).await;
        assert!(matches!(out, Outcome::Text("gpu", ref t) if t == "gpu text"));
        assert!(took < Duration::from_millis(1_500), "{took:?}");
        assert_eq!(deletes.load(Ordering::SeqCst), 0);
        crate::account::tests::cleanup(&db);
    }

    #[tokio::test]
    async fn a_slow_gpu_loses_to_the_cloud_and_its_job_is_deleted() {
        let (st, deletes, db) = fakes(Some(10_000), 50).await;
        let (out, took) = race(&st, 300).await;
        assert!(matches!(out, Outcome::Text("cloud", ref t) if t == "cloud text"));
        assert!(took < Duration::from_secs(2), "{took:?}");
        // The guard's DELETE is fire-and-forget; give it a moment.
        for _ in 0..40 {
            if deletes.load(Ordering::SeqCst) > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(
            deletes.load(Ordering::SeqCst),
            1,
            "abandoned GPU job must be deleted"
        );
        crate::account::tests::cleanup(&db);
    }

    #[tokio::test]
    async fn a_failing_gpu_starts_the_cloud_at_once() {
        let (st, _deletes, db) = fakes(None, 50).await;
        let (out, took) = race(&st, 10_000).await;
        assert!(matches!(out, Outcome::Text("cloud", _)));
        assert!(
            took < Duration::from_secs(2),
            "did not wait out the head start: {took:?}"
        );
        crate::account::tests::cleanup(&db);
    }

    async fn wait_for_delete(deletes: &AtomicUsize) -> usize {
        for _ in 0..60 {
            if deletes.load(Ordering::SeqCst) > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        deletes.load(Ordering::SeqCst)
    }

    #[tokio::test]
    async fn a_job_queued_while_its_id_is_in_flight_is_still_deleted() {
        // The box queues the job at once but answers the submit 800 ms later;
        // the cloud wins at ~50 ms, before the attempt ever learns the id.
        let (st, deletes, db) = fakes_with(Some(10_000), 50, 800, "cloud text").await;
        let (out, took) = race(&st, 0).await;
        assert!(matches!(out, Outcome::Text("cloud", _)));
        assert!(took < Duration::from_millis(700), "{took:?}");
        assert_eq!(
            wait_for_delete(&deletes).await,
            1,
            "orphaned GPU job must be deleted"
        );
        crate::account::tests::cleanup(&db);
    }

    #[tokio::test]
    async fn an_empty_fast_answer_does_not_beat_real_speech() {
        let (st, deletes, db) = fakes_with(Some(400), 20, 0, "").await;
        let (out, _) = race(&st, 0).await;
        assert!(matches!(out, Outcome::Text("gpu", ref t) if t == "gpu text"));
        assert_eq!(deletes.load(Ordering::SeqCst), 0);
        crate::account::tests::cleanup(&db);
    }
}
