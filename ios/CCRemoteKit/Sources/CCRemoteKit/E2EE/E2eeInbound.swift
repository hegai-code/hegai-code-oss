import Foundation

/// Opens what the hub sends, once, before the typed decoder sees it, so
/// everything downstream reads the frames it always read (web: `openFrame` in
/// `ws.onmessage`). A value type with no references to the client: the client
/// takes a reading of its bookkeeping and hands it here, and the work (a history
/// page is megabytes of JSON) runs off the main actor.
///
/// Envelopes are bound to a machine id and open only under the machine THIS
/// phone attributes the frame to - from its own record of what it asked for
/// (`runMachine`, `rpc`, `term`, `mirror`), never from a field the hub chose.
public struct E2eeInbound: Sendable {
    public var keys: E2eeKeys
    /// run -> machine, learned only from what this phone itself opened.
    public var runMachine: [String: String] = [:]
    /// run -> machine from the hub's active-run list: a fallback, as on the web.
    public var runIndex: [String: String] = [:]
    public var rpc: [String: String] = [:]
    public var term: [String: String] = [:]
    public var mirror: [String: String] = [:]
    /// requestId -> method of an rpc this phone sent, to tell a content result from a clear one.
    public var rpcMethod: [String: String] = [:]

    /// Set by an opener when an envelope names a key this phone does not hold
    /// (after `--pair --rotate`): the machine's session is locked until re-paired.
    private final class Stale: @unchecked Sendable { var machine: String?; var healed: String? }

    public init(keys: E2eeKeys) { self.keys = keys }

    /// The frame to decode, or nil when it must be dropped: clear assistant text,
    /// a tool prompt or a user turn for a run of a machine whose key this phone
    /// holds is the hub's own invention (it cannot read the real ones).
    /// The frame types that are looked at even with no envelope in them, for a phone that
    /// holds keys. ONE list, used by the client's prefilter and by `processDetailed`.
    public static let inspectedTypes = ["stream", "tool_request", "user_turn", "term_data", "mirror_data", "rpc_response"]

    public static func needsInspection(_ text: String, hasKeys: Bool) -> Bool {
        hasKeys && inspectedTypes.contains { text.contains("\"\($0)\"") }
    }

    public func process(_ text: String) -> String? { processDetailed(text).text }

    /// `staleKeyMachine`: an envelope named a key id this phone does not hold, for a
    /// machine it does hold keys of.
    public func processDetailed(_ text: String) -> (text: String?, staleKeyMachine: String?, healedMachine: String?) {
        let r = processInner(text)
        return (r.text, r.stale, r.healed)
    }

    private func processInner(_ text: String) -> (text: String?, stale: String?, healed: String?) {
        let carries = E2ee.mayCarryE2e(text)
        let runFrame = Self.needsInspection(text, hasKeys: !keys.isEmpty)
        guard carries || runFrame else { return (text, nil, nil) }
        guard let data = text.data(using: .utf8),
              let frame = (try? JSONSerialization.jsonObject(with: data)) as? E2ee.Obj else { return (text, nil, nil) }
        if runFrame, clearContentForKeyedRun(frame) { return (nil, nil, nil) }
        // A clear rpc result for a keyed machine: the request fails, it is not believed.
        if runFrame, let refused = refuseClearRpc(frame) { return (refused, nil, nil) }
        guard carries else {
            // A tool prompt of a keyed run with no envelope at all is the hub's: never a card.
            return (isKeyedToolRequest(frame) ? nil : text, nil, nil)
        }
        let stale = Stale()
        let opened = open(frame, stale: stale)
        // ...and one whose envelope did not open is never an approval card either.
        if isKeyedToolRequest(frame), opened["e2e"] != nil { return (nil, verdict(frame, stale).0, verdict(frame, stale).1) }
        guard let out = try? JSONSerialization.data(withJSONObject: opened, options: [.withoutEscapingSlashes]),
              let s = String(data: out, encoding: .utf8) else { return (text, verdict(frame, stale).0, verdict(frame, stale).1) }
        return (s, verdict(frame, stale).0, verdict(frame, stale).1)
    }

    /// Only LIVE run frames may set or clear the stale-key lock: history pages and session
    /// lists legitimately mix envelopes of an old and a new key. Within a frame an unknown
    /// key wins: a frame that reported one never heals.
    static let liveTypes: Set<String> = ["stream", "tool_request", "user_turn", "term_data", "mirror_data"]

    private func verdict(_ frame: E2ee.Obj, _ s: Stale) -> (String?, String?) {
        guard Self.liveTypes.contains((frame["type"] as? String) ?? "") else { return (nil, nil) }
        return (s.machine, s.machine == nil ? s.healed : nil)
    }

    /// Methods whose result is `{messages}` sealed message by message.
    static let messageResultMethods: Set<String> = ["session.messages", "session.subagent"]

    /// Mirror of `clearRpcContent` in shared/src/e2e.ts: for a keyed machine, an ok result
    /// that carries content in the clear is the hub's own invention. It becomes a failure of
    /// that request (so the caller does not wait out a timeout).
    func refuseClearRpc(_ f: E2ee.Obj) -> String? {
        guard f["type"] as? String == "rpc_response", let id = f["requestId"] as? String,
              let machine = rpc[id], keys.hasKey(for: machine) else { return nil }
        guard Self.clearRpcContent(method: rpcMethod[id] ?? "", frame: f) else { return nil }
        let reject: E2ee.Obj = ["type": "rpc_response", "requestId": id, "ok": false,
                                "error": "Ответ машины не подтверждён ключом — он отброшен."]
        return (try? JSONSerialization.data(withJSONObject: reject)).flatMap { String(data: $0, encoding: .utf8) }
    }

    static func clearRpcContent(method: String, frame: E2ee.Obj) -> Bool {
        guard frame["ok"] as? Bool == true, let result = frame["result"] else { return false }
        if E2ee.rpcClearResult.contains(method) { return false }
        let obj = result as? E2ee.Obj
        if let o = obj, o.count == 1, o["ok"] as? Bool == true { return false }
        if messageResultMethods.contains(method), let o = obj, let messages = o["messages"] as? [Any] {
            // A sealed message keeps only its routing next to the envelope (`blocks` blanked to []);
            // an unsealed one carries none of the sealed fields. Anything else beside an envelope is
            // clear text the hub added, which would survive an envelope that does not open.
            return messages.contains { item in
                guard let m = item as? E2ee.Obj else { return false }
                if E2ee.Envelope(m["e2e"]) == nil { return E2ee.messageSpec.take.contains { m[$0] != nil } }
                let blocks = m["blocks"]
                return m["ts"] != nil || m["model"] != nil
                    || (blocks != nil && !((blocks as? [Any])?.isEmpty ?? false))
            }
        }
        if let o = obj, o.count == 1, E2ee.Envelope(o["e2e"]) != nil { return false }
        return true
    }

    private func machineOfRun(_ runId: String) -> String? { runMachine[runId] ?? runIndex[runId] }

    func machineOf(_ f: E2ee.Obj) -> String? {
        let id = { (k: String) -> String in (f[k] as? String) ?? "" }
        switch f["type"] as? String {
        case "rpc_response": return rpc[id("requestId")]
        case "mirror_data": return mirror[id("mirrorId")]
        case "term_data": return term[id("termId")]
        default:
            let run = id("runId")
            return run.isEmpty ? nil : machineOfRun(run)
        }
    }

    func isKeyedToolRequest(_ f: E2ee.Obj) -> Bool {
        guard f["type"] as? String == "tool_request", let runId = f["runId"] as? String,
              let machine = machineOfRun(runId) else { return false }
        return keys.hasKey(for: machine)
    }

    func clearContentForKeyedRun(_ f: E2ee.Obj) -> Bool {
        func nonEmpty(_ v: Any?) -> Bool { !((v as? String) ?? "").isEmpty }
        // A terminal or a mirror of a keyed machine speaks sealed only.
        switch f["type"] as? String {
        case "term_data":
            guard let machine = term[(f["termId"] as? String) ?? ""], keys.hasKey(for: machine) else { return false }
            return f["e2e"] == nil && nonEmpty(f["data"])
        case "mirror_data":
            guard let machine = mirror[(f["mirrorId"] as? String) ?? ""], keys.hasKey(for: machine) else { return false }
            return (f["messages"] as? [Any] ?? []).contains { item in
                guard let m = item as? E2ee.Obj else { return false }
                return m["e2e"] == nil && !((m["blocks"] as? [Any]) ?? []).isEmpty
            }
        default:
            break
        }
        guard let runId = f["runId"] as? String, !runId.isEmpty,
              let machine = machineOfRun(runId), keys.hasKey(for: machine) else { return false }
        switch f["type"] as? String {
        case "stream":
            let ev = f["event"] as? E2ee.Obj ?? [:]
            return ev["e2e"] == nil && (nonEmpty(ev["text"]) || ev["raw"] != nil || ev["data"] != nil)
        case "tool_request":
            let input = f["input"] as? E2ee.Obj ?? [:]
            return f["e2e"] == nil && (nonEmpty(f["title"]) || !input.isEmpty)
        case "user_turn":
            let files = f["files"] as? [Any] ?? []
            return f["e2e"] == nil && (nonEmpty(f["text"]) || f["images"] != nil || !files.isEmpty)
        default:
            return false
        }
    }

    private func opener(for machineId: String, stale: Stale) -> E2ee.Opener {
        { env, bind in
            guard let k = keys.forKid(env.kid) else {
                if keys.hasKey(for: machineId) { stale.machine = machineId }
                return nil
            }
            let opened = try? E2eeCipher.open(env, key: k.key, bind: E2ee.withMachine(machineId, bind))
            // An envelope that opens with the machine's CURRENT key says the key is good.
            if opened != nil, keys.latest(for: machineId)?.kid == k.kid { stale.healed = machineId }
            return opened
        }
    }

    func open(_ f: E2ee.Obj) -> E2ee.Obj { open(f, stale: Stale()) }

    private func open(_ f: E2ee.Obj, stale: Stale) -> E2ee.Obj {
        if let opened = openSummaries(f, stale: stale) { return opened }
        guard let machine = machineOf(f) else { return f }
        return E2ee.openFrame(f, open: opener(for: machine, stale: stale))
    }

    private func openList(_ sessions: [Any], machineId: String?, stale: Stale) -> [Any] {
        guard let machineId else { return sessions }
        let op = opener(for: machineId, stale: stale)
        return sessions.map { item in
            guard let s = item as? E2ee.Obj, s["titleE2e"] != nil || s["cwdE2e"] != nil else { return item }
            return E2ee.openSummary(s, open: op)
        }
    }

    /// Session lists (`snapshot`, `machine_sessions`, `session_updates`): each
    /// summary opens under the machine whose list it is in. Nil for any other frame.
    private func openSummaries(_ f: E2ee.Obj, stale: Stale) -> E2ee.Obj? {
        var out = f
        switch f["type"] as? String {
        case "snapshot":
            guard let machines = f["machines"] as? [Any] else { return nil }
            out["machines"] = machines.map { item -> Any in
                guard var m = item as? E2ee.Obj else { return item }
                let id = (m["machine"] as? E2ee.Obj)?["machineId"] as? String
                if let sessions = m["sessions"] as? [Any] { m["sessions"] = openList(sessions, machineId: id, stale: stale) }
                return m
            }
            return out
        case "machine_sessions":
            guard var m = f["machine"] as? E2ee.Obj else { return nil }
            let id = (m["machine"] as? E2ee.Obj)?["machineId"] as? String
            if let sessions = m["sessions"] as? [Any] { m["sessions"] = openList(sessions, machineId: id, stale: stale) }
            out["machine"] = m
            return out
        case "session_updates":
            if let sessions = f["sessions"] as? [Any] { out["sessions"] = openList(sessions, machineId: f["machineId"] as? String, stale: stale) }
            return out
        default:
            return nil
        }
    }
}
