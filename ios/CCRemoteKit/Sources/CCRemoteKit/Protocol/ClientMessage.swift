import Foundation

/// Client → central frames (mirror `BrowserToCentral` in web-protocol.ts).
/// Optionals are omitted when nil (`encodeIfPresent`) to match the hub's
/// strip-null convention.
public enum ClientMessage: Encodable, Sendable {
    case open(machineId: String, sessionId: String, message: String?, images: [ImageAttachment]?)
    /// `source` picks the agent (`"claude"` / `"codex"`); absent lets the hub
    /// decide — which also covers `member`-role viewers, whom the hub routes to
    /// Codex regardless of what they ask for.
    ///
    /// `model` / `effort` / `permissionMode` are the same three settings
    /// `set_model` / `set_effort` / `set_permission_mode` change mid-run, chosen
    /// BEFORE the first turn instead of after it — which is when
    /// `permissionMode` is actually load-bearing (asking for `plan` once the
    /// model has started editing is not planning). All three are ADVISORY: a
    /// machine that does not offer a mode or a model starts under its own
    /// default rather than refusing, so an absent field is always safe and a
    /// stale pick never costs a session.
    case newSession(machineId: String, cwd: String, message: String?, images: [ImageAttachment]?,
                    category: SessionCategory?, source: String?,
                    model: String? = nil, effort: EffortLevel? = nil,
                    permissionMode: PermissionMode? = nil)
    case takeover(machineId: String, sessionId: String, message: String?)
    case input(runId: String, text: String, images: [ImageAttachment]?)
    case interrupt(runId: String)
    /// Run the CLI's own `/compact` on a live run — the escape hatch before a
    /// session grows past the size where it stops resuming at all.
    case compact(runId: String)
    case close(runId: String)
    case toolDecision(runId: String, requestId: String, allow: Bool, updatedInput: JSONValue?, permissionMode: PermissionMode?, message: String?)
    case rescan(machineId: String)
    /// End a session outright: the hub closes an active cc-remote run if there is
    /// one, else asks the agent to terminate the external editor writer. This is
    /// the app's only way out of a run that still holds the single-writer lock
    /// (e.g. one left in `error`) — `close` needs a runId we may not have.
    case endSession(machineId: String, sessionId: String)
    case setStage(machineId: String, sessionId: String, stage: String?)
    /// «I have seen this session» — the hub stamps it and tells the person's other devices.
    case sessionRead(machineId: String, sessionId: String)
    case subscribe(runId: String)
    case unsubscribe(runId: String)
    case rpcRequest(requestId: String, machineId: String, method: String, params: JSONValue)
    case mirrorOpen(mirrorId: String, machineId: String, sessionId: String, cwd: String)
    case mirrorClose(mirrorId: String)
    case termOpen(termId: String, machineId: String, cwd: String?)
    case termInput(termId: String, data: String)
    case termResize(termId: String, cols: Int, rows: Int)
    case termClose(termId: String)
    case setModel(runId: String, model: String?)
    case setPermissionMode(runId: String, mode: PermissionMode)
    /// `ultracode` = xhigh + workflow orchestration; it replaces the plain effort
    /// level rather than accompanying it.
    case setEffort(runId: String, effort: EffortLevel?, ultracode: Bool)
    case memoryList(requestId: String)
    case memoryRead(requestId: String, scope: MemoryScope, scopeKey: String, path: String)
    /// Tombstone a memory — hub-side, fleet-wide (agents learn via the catalog).
    case memoryDelete(requestId: String, scope: MemoryScope, scopeKey: String, path: String)
    /// Enrich one assistant turn (web `enrich_request`). The CLIENT carries the
    /// text: when the run just went idle the hub's replica lags the screen, and
    /// the client is the one place the rendered text reliably exists for
    /// history, live and mirror alike. `text` is client-truncated (keep the end
    /// — the question lives there); `userText` is context only; `digest` is what
    /// the turn DID (`EnrichDigest`), absent when there is nothing beyond `text`.
    case enrichRequest(requestId: String, machineId: String, sessionId: String, source: String?,
                       uuid: String, text: String, userText: String?, purpose: String? = nil,
                       digest: String? = nil)
    case registerPush(deviceToken: String, platform: String)
    case unregisterPush(deviceToken: String)
    /// `caps` names optional things this build understands. Only `sessionDelta`
    /// so far — "send me one machine's list instead of the whole fleet". Opt-in,
    /// because a build that does not know `machine_sessions` would ignore it and
    /// sit on a session list that never updates again.
    case hello(client: String, caps: [String] = [])
    case ping
    /// Backgrounded hush / foreground re-sync — see CentralClient scenePhase
    /// hooks. `pause` stops all hub->socket traffic; `resume` answers with one
    /// fresh snapshot. Old hubs ignore both (unknown types are dropped).
    case pause
    case resume
    /// `statsOnDemand` capability (announced in `hello.caps`): «I am looking at
    /// the hardware screen» (`on: true`) / «I am not» (`on: false`). A hub that
    /// saw the capability sends `machine_stats` to this socket only while the
    /// interest is on, and answers `on: true` with the latest samples at once.
    /// Per socket — it must be repeated after every reconnect. Old hubs drop it
    /// (unknown type) and keep streaming stats as before.
    case statsInterest(on: Bool)

    private enum K: String, CodingKey {
        case type, machineId, sessionId, message, runId, text, requestId, allow
        case method, params, mirrorId, cwd, termId, data, cols, rows, model, mode
        case deviceToken, platform, images, updatedInput, permissionMode, effort, client
        case stage, ultracode, category, source, scope, scopeKey, path
        case uuid, userText, caps, purpose, digest, on
    }

    /// Wire shape of an attached image (mirrors `ImageInput` in protocol.ts:
    /// snake-case `media_type` + `data`, which the hub's sanitize_images and the
    /// agent's SDK mapping both require). `ImageAttachment` holds raw `Data`;
    /// only these two fields cross the wire.
    struct WireImage: Encodable {
        let mediaType: String
        let dataBase64: String
        enum CodingKeys: String, CodingKey {
            case mediaType = "media_type"
            case dataBase64 = "data"
        }
    }
    static func wire(_ images: [ImageAttachment]?) -> [WireImage]? {
        guard let images, !images.isEmpty else { return nil }
        return images.map { WireImage(mediaType: $0.mediaType, dataBase64: $0.dataBase64) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        switch self {
        case let .open(machineId, sessionId, message, images):
            try c.encode("open", forKey: .type)
            try c.encode(machineId, forKey: .machineId)
            try c.encode(sessionId, forKey: .sessionId)
            try c.encodeIfPresent(message, forKey: .message)
            try c.encodeIfPresent(Self.wire(images), forKey: .images)
        case let .newSession(machineId, cwd, message, images, category, source,
                             model, effort, permissionMode):
            try c.encode("new_session", forKey: .type)
            try c.encode(machineId, forKey: .machineId)
            try c.encode(cwd, forKey: .cwd)
            try c.encodeIfPresent(message, forKey: .message)
            try c.encodeIfPresent(Self.wire(images), forKey: .images)
            try c.encodeIfPresent(category?.rawValue, forKey: .category)
            try c.encodeIfPresent(source, forKey: .source)
            // Absent, never null: the hub reads these through zod `optional`,
            // which is `T | undefined` — an explicit null fails the whole
            // `new_session`, so "no pick" has to be an omitted key. An empty
            // model string is the same thing and is dropped here rather than
            // pinning the session to a model id nobody named.
            if let model, !model.isEmpty { try c.encode(model, forKey: .model) }
            try c.encodeIfPresent(effort?.rawValue, forKey: .effort)
            // `.default` is the ABSENCE of a choice, not a choice: sending it
            // would pin every session to a mode the machine may not even call
            // default. `.unknown` is a mode this build has no word for and must
            // never be echoed back as one.
            if let permissionMode, permissionMode != .default, permissionMode != .unknown {
                try c.encode(permissionMode.rawValue, forKey: .permissionMode)
            }
        case let .takeover(machineId, sessionId, message):
            try c.encode("takeover", forKey: .type)
            try c.encode(machineId, forKey: .machineId)
            try c.encode(sessionId, forKey: .sessionId)
            try c.encodeIfPresent(message, forKey: .message)
        case let .input(runId, text, images):
            try c.encode("input", forKey: .type)
            try c.encode(runId, forKey: .runId)
            try c.encode(text, forKey: .text)
            try c.encodeIfPresent(Self.wire(images), forKey: .images)
        case let .interrupt(runId):
            try c.encode("interrupt", forKey: .type)
            try c.encode(runId, forKey: .runId)
        case let .compact(runId):
            try c.encode("compact", forKey: .type)
            try c.encode(runId, forKey: .runId)
        case let .close(runId):
            try c.encode("close", forKey: .type)
            try c.encode(runId, forKey: .runId)
        case let .toolDecision(runId, requestId, allow, updatedInput, permissionMode, message):
            try c.encode("tool_decision", forKey: .type)
            try c.encode(runId, forKey: .runId)
            try c.encode(requestId, forKey: .requestId)
            try c.encode(allow, forKey: .allow)
            try c.encodeIfPresent(updatedInput, forKey: .updatedInput)
            try c.encodeIfPresent(permissionMode, forKey: .permissionMode)
            try c.encodeIfPresent(message, forKey: .message)
        case let .rescan(machineId):
            try c.encode("rescan", forKey: .type)
            try c.encode(machineId, forKey: .machineId)
        case let .endSession(machineId, sessionId):
            try c.encode("end_session", forKey: .type)
            try c.encode(machineId, forKey: .machineId)
            try c.encode(sessionId, forKey: .sessionId)
        case let .setStage(machineId, sessionId, stage):
            try c.encode("set_stage", forKey: .type)
            try c.encode(machineId, forKey: .machineId)
            try c.encode(sessionId, forKey: .sessionId)
            try c.encodeIfPresent(stage, forKey: .stage)
        case let .sessionRead(machineId, sessionId):
            try c.encode("session_read", forKey: .type)
            try c.encode(machineId, forKey: .machineId)
            try c.encode(sessionId, forKey: .sessionId)
        case let .subscribe(runId):
            try c.encode("subscribe", forKey: .type)
            try c.encode(runId, forKey: .runId)
        case let .unsubscribe(runId):
            try c.encode("unsubscribe", forKey: .type)
            try c.encode(runId, forKey: .runId)
        case let .rpcRequest(requestId, machineId, method, params):
            try c.encode("rpc_request", forKey: .type)
            try c.encode(requestId, forKey: .requestId)
            try c.encode(machineId, forKey: .machineId)
            try c.encode(method, forKey: .method)
            try c.encode(params, forKey: .params)
        case let .mirrorOpen(mirrorId, machineId, sessionId, cwd):
            try c.encode("mirror_open", forKey: .type)
            try c.encode(mirrorId, forKey: .mirrorId)
            try c.encode(machineId, forKey: .machineId)
            try c.encode(sessionId, forKey: .sessionId)
            try c.encode(cwd, forKey: .cwd)
        case let .mirrorClose(mirrorId):
            try c.encode("mirror_close", forKey: .type)
            try c.encode(mirrorId, forKey: .mirrorId)
        case let .termOpen(termId, machineId, cwd):
            try c.encode("term_open", forKey: .type)
            try c.encode(termId, forKey: .termId)
            try c.encode(machineId, forKey: .machineId)
            try c.encodeIfPresent(cwd, forKey: .cwd)
        case let .termInput(termId, data):
            try c.encode("term_input", forKey: .type)
            try c.encode(termId, forKey: .termId)
            try c.encode(data, forKey: .data)
        case let .termResize(termId, cols, rows):
            try c.encode("term_resize", forKey: .type)
            try c.encode(termId, forKey: .termId)
            try c.encode(cols, forKey: .cols)
            try c.encode(rows, forKey: .rows)
        case let .termClose(termId):
            try c.encode("term_close", forKey: .type)
            try c.encode(termId, forKey: .termId)
        case let .setModel(runId, model):
            try c.encode("set_model", forKey: .type)
            try c.encode(runId, forKey: .runId)
            try c.encodeIfPresent(model, forKey: .model)
        case let .setPermissionMode(runId, mode):
            try c.encode("set_permission_mode", forKey: .type)
            try c.encode(runId, forKey: .runId)
            try c.encode(mode.rawValue, forKey: .mode)
        case let .setEffort(runId, effort, ultracode):
            try c.encode("set_effort", forKey: .type)
            try c.encode(runId, forKey: .runId)
            try c.encodeIfPresent(effort?.rawValue, forKey: .effort)
            if ultracode { try c.encode(true, forKey: .ultracode) }
        case let .memoryList(requestId):
            try c.encode("memory_list", forKey: .type)
            try c.encode(requestId, forKey: .requestId)
        case let .memoryRead(requestId, scope, scopeKey, path):
            try c.encode("memory_read", forKey: .type)
            try c.encode(requestId, forKey: .requestId)
            try c.encode(scope.rawValue, forKey: .scope)
            try c.encode(scopeKey, forKey: .scopeKey)
            try c.encode(path, forKey: .path)
        case let .memoryDelete(requestId, scope, scopeKey, path):
            try c.encode("memory_delete", forKey: .type)
            try c.encode(requestId, forKey: .requestId)
            try c.encode(scope.rawValue, forKey: .scope)
            try c.encode(scopeKey, forKey: .scopeKey)
            try c.encode(path, forKey: .path)
        case let .enrichRequest(requestId, machineId, sessionId, source, uuid, text, userText, purpose, digest):
            try c.encode("enrich_request", forKey: .type)
            try c.encodeIfPresent(purpose, forKey: .purpose)
            try c.encode(requestId, forKey: .requestId)
            try c.encode(machineId, forKey: .machineId)
            try c.encode(sessionId, forKey: .sessionId)
            try c.encodeIfPresent(source, forKey: .source)
            try c.encode(uuid, forKey: .uuid)
            try c.encode(text, forKey: .text)
            try c.encodeIfPresent(userText, forKey: .userText)
            try c.encodeIfPresent(digest, forKey: .digest)
        case let .registerPush(deviceToken, platform):
            try c.encode("register_push", forKey: .type)
            try c.encode(deviceToken, forKey: .deviceToken)
            try c.encode(platform, forKey: .platform)
        case let .unregisterPush(deviceToken):
            try c.encode("unregister_push", forKey: .type)
            try c.encode(deviceToken, forKey: .deviceToken)
        case let .hello(client, caps):
            try c.encode("hello", forKey: .type)
            try c.encode(client, forKey: .client)
            if !caps.isEmpty { try c.encode(caps, forKey: .caps) }
        case .ping:
            try c.encode("ping", forKey: .type)
        case .pause:
            try c.encode("pause", forKey: .type)
        case .resume:
            try c.encode("resume", forKey: .type)
        case let .statsInterest(on):
            try c.encode("stats_interest", forKey: .type)
            try c.encode(on, forKey: .on)
        }
    }
}
