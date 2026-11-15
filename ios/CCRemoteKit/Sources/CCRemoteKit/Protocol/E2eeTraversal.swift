import Foundation

/// Private machine (docs/E2EE.md): the PURE half of the envelope — which fields
/// of which frames are content, how they are lifted into a secret and put back,
/// and what each envelope is bound to. A port of `shared/src/e2e.ts`; the table
/// and the bindings must stay byte-for-byte the same as that file, because the
/// agent compares them with what it computes (a different `bind` is a failed
/// open on the other side).
///
/// Foundation only, no crypto: the cipher is injected (`Sealer` / `Opener`), so
/// this file compiles on Linux too (`ios/scripts/check-protocol-linux.sh`).
///
/// Frames are `[String: Any]` (JSONSerialization trees), not `JSONValue`: the
/// content round-trips through here on its way to the typed decoders, and
/// `JSONValue.number` is a Double, which would turn an integer into text such as
/// `1.7e+12`.
public enum E2ee {
    public typealias Obj = [String: Any]

    /// What a client with no key reads in place of a title.
    public static let placeholderTitle = "Зашифровано"
    /// What stays in an `error` whose text is sealed.
    public static let placeholderError = "Зашифровано"

    /// The wire envelope `{e2e:1, kid, n, c}`.
    public struct Envelope: Equatable, Sendable {
        public let kid: String
        public let n: String
        public let c: String
        public init(kid: String, n: String, c: String) { self.kid = kid; self.n = n; self.c = c }

        /// Nil for anything that is not a well-formed envelope (same limits as
        /// the zod schema in shared/src/e2e.ts).
        public init?(_ any: Any?) {
            guard let d = any as? Obj,
                  (d["e2e"] as? NSNumber)?.intValue == 1,
                  let kid = d["kid"] as? String, !kid.isEmpty, kid.count <= 64,
                  let n = d["n"] as? String, !n.isEmpty, n.count <= 64,
                  let c = d["c"] as? String, !c.isEmpty
            else { return nil }
            self.init(kid: kid, n: n, c: c)
        }

        public var json: Obj { ["e2e": 1, "kid": kid, "n": n, "c": c] }
    }

    /// Seals `secret` for `bind` (`machineId|dir|kind|id`). Throws on a missing key.
    public typealias Sealer = (_ secret: Any, _ bind: String) throws -> Envelope
    /// Opens `env` made for `bind`; nil when it cannot be opened (no key, wrong
    /// key, wrong binding, damaged) - the envelope then stays where it was.
    public typealias Opener = (_ env: Envelope, _ bind: String) -> Any?

    // MARK: Bindings

    public static func bindTag(_ dir: String, _ kind: String, _ id: String) -> String { "\(dir)|\(kind)|\(id)" }
    public static func withMachine(_ machineId: String, _ bind: String) -> String { "\(machineId)|\(bind)" }
    public static func aad(kid: String, bind: String) -> String { "\(kid)|\(bind)" }

    /// The binding of `turnE2e` / `user_turn`: the echo of a turn for other screens.
    public static let turnEchoBind = bindTag("c2a", "turnecho", "")

    /// The pairing code `hcp1.<machineId>.<base64url(K)>`.
    public struct PairingCode: Equatable, Sendable {
        public let machineId: String
        /// 32 bytes, base64url, as printed.
        public let key: String
    }

    /// Nil for anything that is not a well-formed code. The machine id may itself
    /// contain dots, so the key is the LAST segment.
    public static func parsePairingCode(_ code: String) -> PairingCode? {
        let s = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard s.hasPrefix("hcp1.") else { return nil }
        let rest = String(s.dropFirst("hcp1.".count))
        guard let dot = rest.lastIndex(of: "."), dot != rest.startIndex else { return nil }
        let machineId = String(rest[..<dot])
        let key = String(rest[rest.index(after: dot)...])
        guard key.utf8.count == 43,
              key.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5a) || ($0 >= 0x61 && $0 <= 0x7a) || $0 == 0x2d || $0 == 0x5f })
        else { return nil }
        return PairingCode(machineId: machineId, key: key)
    }

    // MARK: Table (shared/src/e2e.ts FRAME_SPECS)

    struct Spec {
        var at: String?
        var take: [String]
        var blank: Obj = [:]
        var routing: [String] = []
    }

    static let frameSpecs: [String: Spec] = [
        "stream": Spec(at: "event", take: ["text", "raw", "data"]),
        "tool_request": Spec(take: ["input", "title"], blank: ["input": Obj()]),
        "tool_decision": Spec(take: ["allow", "permissionMode", "updatedInput", "message"], routing: ["allow"]),
        "input": Spec(take: ["text", "images", "files"], blank: ["text": ""]),
        "open": Spec(take: ["message", "images", "files"]),
        "new_session": Spec(take: ["message", "images", "files", "cwd", "model", "effort", "permissionMode"],
                            routing: ["cwd", "model", "effort", "permissionMode"]),
        "set_permission_mode": Spec(take: ["mode"], routing: ["mode"]),
        "takeover": Spec(take: ["message", "images", "files"]),
        "resume": Spec(take: ["message", "images", "files"]),
        "user_turn": Spec(take: ["text", "images", "files"], blank: ["text": ""]),
        "run_status": Spec(take: ["error"]),
        "term_data": Spec(take: ["data"], blank: ["data": ""]),
        "term_input": Spec(take: ["data"], blank: ["data": ""]),
    ]

    static let messageSpec = Spec(take: ["blocks", "ts", "model"], blank: ["blocks": [Any]()])

    /// RPC results that stay in the clear.
    static let rpcClearResult: Set<String> = ["models.list"]
    /// Params that are content, per method.
    public static let rpcSealedParams: [String: [String]] = [
        "fs.write": ["content"],
        "fs.upload.chunk": ["data"],
        "git.commit": ["message"],
        "git.pr.create": ["title", "body"],
        "session.rename": ["title"],
        "runtime.login.input": ["code"],
    ]
    /// Clear params repeated inside the secret so the agent can catch a hub that rewrites them.
    static let rpcBoundParams = ["cwd", "path", "dir", "name", "uploadId", "from", "to", "sessionId"]

    static let turnTypes: Set<String> = ["input", "open", "new_session", "takeover", "resume"]
    static let metaTypes: Set<String> = turnTypes.union(["tool_decision", "set_permission_mode"])

    static func str(_ v: Any?) -> String { v as? String ?? "" }

    /// `dir|kind|id` of a frame's envelope (`frameBind` in shared/src/e2e.ts).
    /// `dir` is `a2c` / `c2a`; a client-to-agent frame also carries the agent's `epoch`.
    public static func frameBind(dir: String, frame: Obj, epoch: String? = nil) -> String {
        let type = str(frame["type"])
        if type == "user_turn" { return turnEchoBind }
        let d = (dir == "c2a" && epoch != nil && epoch != "") ? "c2a:\(epoch!)" : dir
        if turnTypes.contains(type) { return bindTag(d, "turn", "") }
        switch type {
        case "stream", "run_status", "set_permission_mode":
            return bindTag(d, type, str(frame["runId"]))
        case "tool_request", "tool_decision":
            return bindTag(d, type, str(frame["requestId"]))
        case "term_data", "term_input":
            return bindTag(d, type, str(frame["termId"]))
        case "rpc_request", "rpc_response":
            return bindTag(d, "rpc", str(frame["requestId"]))
        default:
            return bindTag(d, type, "")
        }
    }

    static func messageBind(_ m: Obj) -> String { bindTag("a2c", "msg", str(m["uuid"])) }

    // MARK: Lift / put back

    /// Lift `spec.take` out of `holder` into a secret; leave `spec.blank` behind.
    static func takeFrom(_ holder: Obj, _ spec: Spec) -> (secret: Obj, holder: Obj)? {
        var secret = Obj()
        for k in spec.take where holder[k] != nil { secret[k] = holder[k] }
        if secret.isEmpty { return nil }
        var next = holder
        for k in spec.take where !spec.routing.contains(k) { next.removeValue(forKey: k) }
        for (k, v) in spec.blank where secret[k] != nil { next[k] = v }
        return (secret, next)
    }

    /// Put an opened secret back. EVERY content field is first dropped from the
    /// holder: whatever a hub left in the clear next to an envelope must not
    /// survive into the opened frame.
    static func putInto(_ holder: Obj, _ secret: Any, _ spec: Spec) -> Obj {
        var next = holder
        next.removeValue(forKey: "e2e")
        for k in spec.take { next.removeValue(forKey: k) }
        let s = secret as? Obj ?? [:]
        for k in spec.take { if let v = s[k] { next[k] = v } }
        for (k, v) in spec.blank where s[k] == nil { next[k] = v }
        return next
    }

    // MARK: Sealing (client to agent)

    /// Seal the content of an outgoing frame. The result is the frame with content
    /// replaced by its clear-side blanks and the envelope in `e2e` (`rpc_request`:
    /// in `params.e2e`). A frame with nothing to seal comes back unchanged.
    public static func sealFrame(_ frame: Obj, epoch: String?, seal: Sealer) throws -> Obj {
        var out = frame
        let type = str(frame["type"])
        let bind = frameBind(dir: "c2a", frame: frame, epoch: epoch)

        if type == "rpc_request" {
            let method = str(frame["method"])
            guard let fields = rpcSealedParams[method], let params = frame["params"] as? Obj,
                  var taken = takeFrom(params, Spec(take: fields)) else { return out }
            taken.secret["_m"] = method
            var bound = Obj()
            for k in rpcBoundParams where params[k] != nil { bound[k] = params[k] }
            taken.secret["_p"] = bound
            taken.holder["e2e"] = try seal(taken.secret, bind).json
            out["params"] = taken.holder
            return out
        }

        guard let spec = frameSpecs[type] else { return out }
        func sealHolder(_ holder: Obj) throws -> Obj? {
            guard var taken = takeFrom(holder, spec) else { return nil }
            if metaTypes.contains(type) {
                taken.secret["_k"] = type
                if let r = frame["runId"] as? String { taken.secret["_r"] = r }
                if let s = frame["sessionId"] as? String { taken.secret["_s"] = s }
            }
            taken.holder["e2e"] = try seal(taken.secret, bind).json
            return taken.holder
        }
        if let at = spec.at {
            if let inner = frame[at] as? Obj, let next = try sealHolder(inner) { out[at] = next }
        } else if let next = try sealHolder(frame) {
            out = next
        }
        return out
    }

    /// The light echo of a turn for the person's other screens (`turnE2e`): text,
    /// how many images, the file names. Nil when the frame carries none of them.
    public static func turnSecret(_ frame: Obj) -> Obj? {
        let text = (frame["text"] as? String) ?? (frame["message"] as? String) ?? ""
        let images = (frame["images"] as? [Any])?.count ?? 0
        let files = ((frame["files"] as? [Any]) ?? []).compactMap { ($0 as? Obj)?["name"] as? String }.filter { !$0.isEmpty }
        if text.isEmpty && images == 0 && files.isEmpty { return nil }
        var s: Obj = ["text": text]
        if images > 0 { s["images"] = images }
        if !files.isEmpty { s["files"] = files }
        return s
    }

    /// The secrets `sealFrame` would seal in this frame (for the decisions below).
    static func secrets(in frame: Obj) -> [Any] {
        var found: [Any] = []
        _ = try? sealFrame(frame, epoch: nil) { secret, _ in
            found.append(secret)
            return Envelope(kid: "-", n: "-", c: "-")
        }
        return found
    }

    public static func isContentFrame(_ type: Any?) -> Bool {
        switch type as? String {
        case "input", "open", "new_session", "takeover", "tool_decision", "set_permission_mode", "term_input", "rpc_request":
            return true
        default:
            return false
        }
    }

    /// Whether this outgoing frame carries something to seal. A bare `open`,
    /// `projects.list` or a history page has nothing secret: it goes as is, so a
    /// device without the key still subscribes and shows placeholders.
    public static func needsSeal(_ frame: Obj) -> Bool {
        guard isContentFrame(frame["type"]) else { return false }
        let type = str(frame["type"])
        if type == "term_input" { return true }
        if ["input", "open", "new_session", "takeover"].contains(type), turnSecret(frame) != nil { return true }
        return !secrets(in: frame).isEmpty
    }

    static let routingOnly: Set<String> = ["cwd", "model", "effort", "permissionMode", "allow", "mode", "_k", "_r", "_s", "_m", "_p"]

    /// Whether sealing hides something the person wrote or chose to keep, as
    /// opposed to a frame only sealed because it is addressed to a keyed machine.
    public static func hasRealContent(_ frame: Obj) -> Bool {
        guard isContentFrame(frame["type"]) else { return false }
        if str(frame["type"]) == "term_input" { return true }
        return secrets(in: frame).contains { secret in
            guard let o = secret as? Obj else { return false }
            return o.keys.contains { !routingOnly.contains($0) }
        }
    }

    // MARK: Opening (agent to client)

    /// Open every envelope of a frame from the hub that `open` can open; one it
    /// cannot stays where it was. Not for session summaries (`openSummary`).
    public static func openFrame(_ frame: Obj, open: Opener) -> Obj {
        var out = frame
        let type = str(frame["type"])
        let bind = frameBind(dir: "a2c", frame: frame)

        if type == "rpc_response" {
            if var result = frame["result"] as? Obj {
                if let env = Envelope(result["e2e"]) {
                    if let secret = open(env, bind) { out["result"] = secret }
                } else if let messages = result["messages"] as? [Any] {
                    result["messages"] = openMessages(messages, open)
                    out["result"] = result
                }
            }
            if let env = Envelope(frame["e2e"]), let secret = open(env, bind) {
                if let o = secret as? Obj, let e = o["error"] as? String { out["error"] = e }
                out.removeValue(forKey: "e2e")
            }
            return out
        }

        if type == "session_sync_chunk" || type == "mirror_data" {
            if let messages = frame["messages"] as? [Any] { out["messages"] = openMessages(messages, open) }
            return out
        }

        guard let spec = frameSpecs[type] else { return out }
        func openHolder(_ holder: Obj) -> Obj? {
            guard let env = Envelope(holder["e2e"]), let secret = open(env, bind) else { return nil }
            return putInto(holder, secret, spec)
        }
        if let at = spec.at {
            if let inner = frame[at] as? Obj, let next = openHolder(inner) { out[at] = next }
        } else if let next = openHolder(frame) {
            out = next
        }
        return out
    }

    static func openMessages(_ messages: [Any], _ open: Opener) -> [Any] {
        messages.map { item in
            guard let m = item as? Obj, let env = Envelope(m["e2e"]),
                  let secret = open(env, messageBind(m)) else { return item }
            return putInto(m, secret, messageSpec)
        }
    }

    /// A summary's `titleE2e` / `cwdE2e` opened in place.
    public static func openSummary(_ s: Obj, open: Opener) -> Obj {
        var out = s
        if let env = Envelope(s["titleE2e"]), let secret = open(env, bindTag("a2c", "title", str(s["sessionId"]))) {
            if let t = secret as? String { out["title"] = t }
            out.removeValue(forKey: "titleE2e")
        }
        if let env = Envelope(s["cwdE2e"]), let secret = open(env, bindTag("a2c", "cwd", str(s["sessionId"]))) {
            if let o = secret as? Obj {
                for k in ["cwd", "project", "gitBranch"] { if let v = o[k] as? String { out[k] = v } }
            }
            out.removeValue(forKey: "cwdE2e")
        }
        return out
    }

    /// A cheap pre-check so the common frame skips the traversal.
    public static func mayCarryE2e(_ raw: String) -> Bool {
        raw.contains("\"e2e\"") || raw.contains("\"titleE2e\"") || raw.contains("\"cwdE2e\"")
    }
}
