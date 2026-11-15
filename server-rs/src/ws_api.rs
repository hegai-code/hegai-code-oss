//! The two WebSocket endpoints — `/agent` (a machine's daemon) and `/ui` (a
//! browser or app) — and the per-socket read/write loops that bridge them to the
//! hub task. Authentication and origin checks happen before the upgrade; after
//! it the hub owns the connection.

use super::*;
use crate::workspace::UiScope;

/// Explicit ceiling on one WebSocket message, both directions.
///
/// This is written down rather than inherited on purpose. Left unset, axum hands
/// tungstenite its defaults — 64 MiB per message but only **16 MiB per frame** —
/// and neither a browser nor Node's `ws` fragments an outgoing message. So an
/// oversized attachment did not fail as a request: it violated the protocol and
/// took the whole socket down, which on `/agent` means every live run and mirror
/// on that machine. A person saw their message vanish and the app reconnect.
///
/// 32 MiB clears every legitimate frame with room to spare: the largest the
/// agent sends is a `session_sync_chunk` of 100 transcript messages, and the
/// largest a browser sends is a turn carrying attachments, which
/// `MAX_ATTACH_B64_TOTAL` independently holds well below this.
const WS_MAX_MESSAGE_BYTES: usize = 32 * 1024 * 1024;

pub(crate) async fn ws_agent(
    ws: WebSocketUpgrade,
    Query(params): Query<HashMap<String, String>>,
    State(st): State<AppState>,
) -> Response {
    let credential = match agent_credential(&params, &st) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let ws = ws
        .max_message_size(WS_MAX_MESSAGE_BYTES)
        .max_frame_size(WS_MAX_MESSAGE_BYTES);
    ws.on_upgrade(move |socket| {
        handle_socket(
            socket,
            st.hub,
            true,
            credential.user_id,
            None,
            None,
            Some(credential.machine_id),
            None,
            None,
        )
    })
}

/// A `/ui` handshake carrying a service UI pass
/// (`POST /api/service/ui-tokens`), or `None` when it carries none. The pass
/// travels as `?token=` (a page cannot set headers on a WebSocket) or a
/// bearer; a cookie is never a pass, and a pass presented anywhere but here is
/// refused by `WorkspaceStore::authenticate`.
///
/// Everything a pass must satisfy is decided here, before the upgrade: the key
/// that issued it still exists and still admits UI passes, the page's `Origin`
/// is one of that key's `uiOrigins` (no `Origin`, or the hub's own origins,
/// are NOT enough), the person is still in the key's workspace and is active.
/// An administrator is no exception, and gets no extra reach: the access is
/// derived with `platform_admin=false` and the scope wins. The access it returns carries the `UiScope` the
/// hub confines the connection to.
pub(crate) fn ui_pass_access(
    params: &HashMap<String, String>,
    headers: &HeaderMap,
    st: &AppState,
) -> Result<Option<(crate::workspace::UiAccess, String)>, Response> {
    for token in [bearer_token(headers), params.get("token").cloned()]
        .into_iter()
        .flatten()
    {
        let pass = match st.workspaces.authenticate_ui_pass(&token) {
            Ok(Some(pass)) => pass,
            Ok(None) => continue,
            Err(e) => return Err(store_failure(e)),
        };
        let key = st
            .service_keys
            .as_ref()
            .and_then(|keys| {
                keys.iter()
                    .find(|k| k.name == pass.issuer && k.workspace_id == pass.workspace_id)
            })
            .filter(|k| !k.ui_origins.is_empty())
            .ok_or_else(|| api_error(StatusCode::UNAUTHORIZED, "unauthorized"))?;
        let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
        if !key.ui_origin_allowed(origin) {
            eprintln!(
                "[hub] /ui refused: Origin {} is not a UI origin of key {}",
                origin.unwrap_or("?"),
                key.name
            );
            return Err(api_error(
                StatusCode::FORBIDDEN,
                "cross-origin connection refused",
            ));
        }
        let access = st
            .workspaces
            .ui_access(&pass.user_id, Some(&pass.workspace_id), false)
            .map_err(|e| refusal(StatusCode::FORBIDDEN, e))?;
        if access.workspace_id != pass.workspace_id || !access.is_active() {
            return Err(api_error(StatusCode::FORBIDDEN, "forbidden"));
        }
        return Ok(Some((
            access.with_scope(key.ui_scope()),
            crate::workspace::hash_ui_pass(&token),
        )));
    }
    Ok(None)
}

pub(crate) async fn ws_ui(
    ws: WebSocketUpgrade,
    Query(params): Query<HashMap<String, String>>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    // A service UI pass has its own Origin rule and its own, narrower access;
    // it never reaches the ordinary path below.
    match ui_pass_access(&params, &headers, &st) {
        Ok(Some((access, session))) => {
            let ws = ws
                .max_message_size(WS_MAX_MESSAGE_BYTES)
                .max_frame_size(WS_MAX_MESSAGE_BYTES);
            return ws.on_upgrade(move |socket| {
                handle_socket(
                    socket,
                    st.hub,
                    false,
                    access.user_id,
                    Some(access.workspace_id),
                    Some(access.viewer),
                    None,
                    Some(session),
                    access.ui_scope,
                )
            });
        }
        Ok(None) => {}
        Err(e) => return e,
    }
    if !ui_origin_allowed(&headers, &st.public_url, &st.ui_origins) {
        let origin = headers
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("?");
        eprintln!("[hub] /ui refused: foreign Origin {origin}");
        return api_error(StatusCode::FORBIDDEN, "cross-origin connection refused");
    }
    let user = match ui_user(&params, &headers, &st) {
        Ok(v) => v,
        Err(e) => return e,
    };
    // Which sign-in this socket rides on: named after the device for the
    // profile's list, and remembered by the hub so ending it closes us.
    let session = presented_session(&params, &headers, &st).map(|token| {
        st.workspaces.note_session(&token, &device_label(&headers));
        crate::workspace::hash_token(&token)
    });
    let admin = st.platform_admins.contains(&user);
    let access =
        match st
            .workspaces
            .ui_landing(&user, params.get("workspaceId").map(String::as_str), admin)
        {
            Ok(v) => v,
            Err(e) => return refusal(StatusCode::FORBIDDEN, e),
        };
    let ws = ws
        .max_message_size(WS_MAX_MESSAGE_BYTES)
        .max_frame_size(WS_MAX_MESSAGE_BYTES);
    ws.on_upgrade(move |socket| {
        handle_socket(
            socket,
            st.hub,
            false,
            access.user_id,
            Some(access.workspace_id),
            Some(access.viewer),
            None,
            session,
            None,
        )
    })
}

/// The socket's write half: hub→peer text, pongs, and a server-initiated ping.
///
/// Extracted from `handle_socket` so a test can drive it without a real
/// WebSocket, because its exit conditions are load-bearing. The hub ends a
/// connection by dropping its Tx (backpressure, or an agent superseded by a
/// newer process), and this loop MUST notice: `tokio::select!` only *disables*
/// a branch whose pattern fails, so matching `Some(s) = rx.recv()` left a closed
/// channel silently disabled while the keepalive branch stayed armed — `else`
/// was then unreachable, the loop pinged on forever, and the peer sat on a
/// healthy socket the hub had already forgotten. That is how a superseded agent
/// became a ghost: never closed, never told, still watching and appending the
/// same transcripts as its replacement. Match the `None` explicitly instead.
///
/// The server-initiated ping is why the loop can never be left to idle: without
/// it an idle (or paused) connection is silent for minutes, and every middlebox
/// on the path — nginx's `proxy_read_timeout`, carrier NAT — is free to kill it.
/// The ping is traffic in the server→client direction, which keeps those timers
/// fresh even while a suspended iOS app answers nothing at the app layer (its
/// kernel still ACKs, and unanswered WS pings are legal).
/// Server-initiated ping period of a socket in use.
const KEEPALIVE_SECS: u64 = 25;
/// Ping period of a socket that sent `pause` (a backgrounded client). Must stay
/// well under every idle timer on the path: the hub's nginx holds 3600 s
/// (`deploy/nginx-code.acme.test.conf`), and the RU relay is an nginx `stream`
/// pipe whose `proxy_timeout` defaults to 600 s (its config lives on the relay
/// box, not in this repo). Carrier NAT idle timers are the tightest of all and
/// unknowable from here; a socket they kill is detected by the client on
/// resume, which is the very reconnect `pause` exists to avoid only when cheap.
const PAUSED_KEEPALIVE_SECS: u64 = 120;

/// Is a server ping owed on this keepalive tick? A socket in use: always (the
/// tick is `KEEPALIVE_SECS`). A paused one: only once `PAUSED_KEEPALIVE_SECS`
/// have passed since the last ping.
///
/// The check runs only on the 25 s tick, so "due" means "waiting for the next
/// tick would pass the period": the real gap is the last tick multiple at or
/// under `PAUSED_KEEPALIVE_SECS` (100 s), never above it (review 24.10.2026 —
/// `>= 120` on a 25 s tick pinged at 125 s).
fn ping_due(paused: bool, since_last_ping: std::time::Duration) -> bool {
    !paused
        || since_last_ping + std::time::Duration::from_secs(KEEPALIVE_SECS)
            > std::time::Duration::from_secs(PAUSED_KEEPALIVE_SECS)
}

async fn write_loop<S>(
    mut sink: S,
    mut rx: tokio::sync::mpsc::Receiver<String>,
    mut pong_rx: tokio::sync::mpsc::Receiver<axum::body::Bytes>,
    gate: Arc<hub::OutGate>,
) where
    S: futures_util::Sink<Message> + Unpin,
{
    let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(KEEPALIVE_SECS));
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    keepalive.tick().await; // consume the immediate first tick
    let mut last_ping = tokio::time::Instant::now();
    loop {
        tokio::select! {
            // Bias the control lane: a pong that waits behind a long text
            // backlog is a pong the peer has already given up on.
            biased;
            payload = pong_rx.recv() => match payload {
                Some(payload) => {
                    if sink.send(Message::Pong(payload)).await.is_err() {
                        break;
                    }
                }
                // The read loop owns the pong Tx, so this means the read half is
                // gone and the socket with it.
                None => break,
            },
            msg = rx.recv() => match msg {
                Some(s) => {
                    gate.drained(s.len());
                    // The hub gave up on this peer as too slow: what is still
                    // queued is stale state, and a snapshot follows the
                    // reconnect. Hang up instead of draining it first.
                    if gate.is_dropped() {
                        break;
                    }
                    if sink.send(Message::Text(s.into())).await.is_err() {
                        break;
                    }
                }
                // The hub dropped our Tx: it has forgotten this peer. Anything it
                // queued first — the `agent_superseded` notice, say — has already
                // been drained by the arm above, so this is the point to hang up.
                None => break,
            },
            _ = keepalive.tick() => {
                // A backgrounded (paused) peer gets a ping only every
                // PAUSED_KEEPALIVE_SECS: the ping exists for the middleboxes'
                // idle timers, not for the peer, and a suspended phone pays
                // radio time for every one.
                if !ping_due(gate.is_paused(), last_ping.elapsed()) {
                    continue;
                }
                last_ping = tokio::time::Instant::now();
                if sink.send(Message::Ping(axum::body::Bytes::new())).await.is_err() {
                    break;
                }
            }
        }
    }
    // Send a Close frame so the peer sees a clean shutdown rather than a link
    // that merely goes quiet.
    let _ = sink.close().await;
}

async fn handle_socket(
    socket: WebSocket,
    hub: HubHandle,
    is_agent: bool,
    user_id: String,
    workspace_id: Option<String>,
    viewer: Option<Value>,
    authorized_machine_id: Option<String>,
    auth_session: Option<String>,
    ui_scope: Option<UiScope>,
) {
    let conn = hub.next_conn_id();
    let (sink, mut stream) = socket.split();
    // Bounded outbound queue: if this peer can't drain (a stalled link), the hub
    // drops it rather than buffer without bound. See hub::OUT_CHANNEL_CAP.
    let (tx, rx) = channel::<String>(hub::OUT_CHANNEL_CAP);
    let gate = Arc::new(hub::OutGate::default());
    // Control-frame lane, separate from the hub's Text lane.
    //
    // Defence in depth, NOT a bug fix: tungstenite already queues an automatic
    // Pong and flushes it on the next read (see its `read` docs — "responses will
    // be written and flushed on the next call to read/write/flush"), and the read
    // loop below calls `stream.next()` continuously, so auto-pong works even
    // across `socket.split()`. Answering explicitly on its own lane just removes
    // any dependency on that timing and lets a pong overtake a long text backlog.
    // A duplicate pong is harmless — peers ignore unsolicited ones.
    let (pong_tx, pong_rx) = channel::<axum::body::Bytes>(64);
    hub.send(HubCmd::Connected {
        conn,
        tx,
        is_agent,
        user_id,
        workspace_id,
        viewer,
        authorized_machine_id,
        auth_session,
        ui_scope,
        gate: gate.clone(),
    });

    let mut write = tokio::spawn(write_loop(sink, rx, pong_rx, gate));

    loop {
        tokio::select! {
            m = stream.next() => match m {
                Some(Ok(Message::Text(t))) => {
                    let text = t.as_str().to_string();
                    if is_agent {
                        hub.send(HubCmd::AgentMsg { conn, text });
                    } else {
                        hub.send(HubCmd::UiMsg { conn, text });
                    }
                }
                Some(Ok(Message::Ping(payload))) => {
                    // Never block the read loop on a saturated control lane —
                    // if 64 pongs are already queued the link is dead anyway.
                    let _ = pong_tx.try_send(payload);
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
            // The write task exiting means the hub already forgot this peer
            // (bounded-queue drop). Without this arm the read loop kept the
            // socket open forever — a ghost the keepalive pings kept "alive".
            _ = &mut write => break,
        }
    }

    hub.send(HubCmd::Disconnected { conn });
    write.abort();
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    /// A backgrounded socket is pinged every two minutes, not every 25 s; a
    /// socket in use keeps the 25 s rhythm the proxies were tuned against.
    #[test]
    fn a_paused_socket_is_pinged_rarely() {
        assert!(super::ping_due(false, Duration::from_secs(25)));
        assert!(!super::ping_due(true, Duration::from_secs(25)));
        assert!(!super::ping_due(true, Duration::from_secs(75)));
        // Due on the tick at 100 s: the next one (125 s) would be over the period.
        assert!(super::ping_due(true, Duration::from_secs(100)));
        assert!(super::ping_due(true, Duration::from_secs(120)));
        // Comfortably inside the idle timers on the path (nginx 3600 s, the
        // relay's stream default 600 s).
        const { assert!(super::PAUSED_KEEPALIVE_SECS <= 120) };
    }

    /// The hub marks a peer it gave up on; the writer hangs up at once instead
    /// of draining the stale backlog first.
    #[tokio::test]
    async fn a_dropped_peer_is_hung_up_on_without_draining_its_backlog() {
        let (tx, rx) = super::channel::<String>(8);
        let (_pong_tx, pong_rx) = super::channel::<axum::body::Bytes>(8);
        let (seen_tx, mut seen_rx) = super::channel::<String>(8);
        let sink = Box::pin(futures_util::sink::unfold(
            seen_tx,
            |seen_tx, msg: axum::extract::ws::Message| async move {
                if let axum::extract::ws::Message::Text(t) = msg {
                    let _ = seen_tx.send(t.as_str().to_string()).await;
                }
                Ok::<_, std::convert::Infallible>(seen_tx)
            },
        ));
        let gate = std::sync::Arc::new(super::hub::OutGate::default());
        tx.send("stale".to_string()).await.unwrap();
        gate.mark_dropped();
        let loop_task = tokio::spawn(super::write_loop(sink, rx, pong_rx, gate));
        tokio::time::timeout(Duration::from_secs(2), loop_task)
            .await
            .expect("write loop kept a peer the hub gave up on")
            .expect("write loop panicked");
        assert!(seen_rx.try_recv().is_err(), "the stale backlog was sent");
        drop(tx);
    }

    /// The hub hangs up on a peer by dropping its Tx — that is how an agent
    /// superseded by a newer process is let go. The write loop has to notice.
    ///
    /// It did not: `tokio::select!` disables a branch whose pattern fails to
    /// match, so `Some(s) = rx.recv()` on a closed channel went quiet while the
    /// 25s keepalive arm stayed armed, `else` stayed unreachable, and the loop
    /// pinged a forgotten peer forever. On the wire that was a ghost agent —
    /// socket healthy, pings answered, evicted from the hub and never told,
    /// still watching and appending the same transcripts as its replacement.
    #[tokio::test]
    async fn dropping_the_hubs_tx_hangs_up_instead_of_leaving_a_ghost() {
        let (tx, rx) = super::channel::<String>(8);
        let (_pong_tx, pong_rx) = super::channel::<axum::body::Bytes>(8);

        let loop_task = tokio::spawn(super::write_loop(
            futures_util::sink::drain(),
            rx,
            pong_rx,
            Default::default(),
        ));
        drop(tx);

        // Well inside the 25s keepalive tick: if the loop only notices on the
        // next ping — or never — this is the assertion that says so.
        tokio::time::timeout(std::time::Duration::from_secs(2), loop_task)
            .await
            .expect("write loop kept a peer the hub had already forgotten")
            .expect("write loop panicked");
    }

    /// The `agent_superseded` notice is queued and THEN the Tx is dropped, in
    /// that order. A hangup that raced past the queue would evict the duplicate
    /// daemon without ever telling it why — and it would simply reconnect.
    #[tokio::test]
    async fn a_queued_notice_still_reaches_the_peer_before_the_hangup() {
        let (tx, rx) = super::channel::<String>(8);
        let (_pong_tx, pong_rx) = super::channel::<axum::body::Bytes>(8);
        let (seen_tx, mut seen_rx) = super::channel::<String>(8);

        let sink = Box::pin(futures_util::sink::unfold(
            seen_tx,
            |seen_tx, msg: axum::extract::ws::Message| async move {
                if let axum::extract::ws::Message::Text(t) = msg {
                    let _ = seen_tx.send(t.as_str().to_string()).await;
                }
                Ok::<_, std::convert::Infallible>(seen_tx)
            },
        ));
        let loop_task = tokio::spawn(super::write_loop(sink, rx, pong_rx, Default::default()));

        tx.send(r#"{"type":"agent_superseded"}"#.to_string())
            .await
            .unwrap();
        drop(tx);

        tokio::time::timeout(std::time::Duration::from_secs(2), loop_task)
            .await
            .expect("write loop kept a peer the hub had already forgotten")
            .expect("write loop panicked");
        assert_eq!(
            seen_rx.recv().await.as_deref(),
            Some(r#"{"type":"agent_superseded"}"#),
            "the notice queued before the drop must go out before the socket closes",
        );
    }
}
