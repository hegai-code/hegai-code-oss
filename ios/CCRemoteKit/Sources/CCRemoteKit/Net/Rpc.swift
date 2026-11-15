import Foundation

// Typed RPC result shapes (mirror shared/src/rpc.ts) + convenience wrappers over
// CentralClient.rpc. Params are built as JSONValue; results decode via decode(as:).

public struct FsEntry: Decodable, Identifiable, Hashable, Sendable {
    public let name: String
    public let kind: String   // "dir" | "file"
    public var size: Int?
    public var id: String { name }
    public var isDir: Bool { kind == "dir" }
}
public struct FsListResult: Decodable, Sendable {
    public let path: String
    public let entries: [FsEntry]
}
public struct FsReadResult: Decodable, Sendable {
    public let path: String
    public let content: String
    public let truncated: Bool
}
/// One window of `fs.peek` — same shape as `fs.download`, `data` is base64.
public struct FsPeekResult: Decodable, Sendable {
    public let path: String
    public let offset: Int
    public let data: String
    public let bytes: Int
    public let size: Int
    public let mtime: Double
    public let eof: Bool
}
/// `fs.mkdir`: `created == false` — такая папка уже была (свежей она не считается).
public struct FsMkdirResult: Decodable, Sendable {
    public let path: String
    public let created: Bool?
}
public struct FsWriteResult: Decodable, Sendable {
    public let path: String
    public let bytes: Int
}

public struct GitFileStatus: Decodable, Identifiable, Hashable, Sendable {
    public let path: String
    public let code: String
    public let staged: Bool
    public var id: String { path + code + (staged ? "s" : "u") }
}
public struct GitStatusResult: Decodable, Sendable {
    public let isRepo: Bool
    public var branch: String?
    public var ahead: Int?
    public var behind: Int?
    public let files: [GitFileStatus]
}
public struct GitBranchesResult: Decodable, Sendable {
    public let current: String
    public let all: [String]
}
public struct GitCommitResult: Decodable, Sendable {
    public let ok: Bool
    public let output: String
}
public struct SessionMessagesResult: Decodable, Sendable {
    public let messages: [HistoryMessage]
    /// Set when the hub answered from its own OLD copy because the machine did
    /// not reply in time. Such a page may miss hours of the session.
    public let stale: Bool?
}

public struct SessionImageResult: Decodable, Sendable {
    public let mediaType: String
    public let dataB64: String
}

/// One `session.messages` reply, with whether it is the hub's old copy.
public struct HistoryPage: Sendable {
    public let messages: [HistoryMessage]
    public let stale: Bool
    public init(messages: [HistoryMessage], stale: Bool = false) {
        self.messages = messages
        self.stale = stale
    }
}
public struct SessionForkResult: Decodable, Sendable {
    public let sessionId: String
}
public struct ModelsResult: Decodable, Sendable {
    public let models: [ModelInfoLite]
}
public struct ProjectInfo: Decodable, Identifiable, Hashable, Sendable {
    public let cwd: String
    public let label: String
    public let lastModified: Double
    public let count: Int
    /// `root` — найден сканированием корня проектов (репозиторий, в котором ещё
    /// не начинали сессий, например только что созданный); `adopted` — каталог,
    /// который назвали проектом руками; `sessions` или отсутствует — выведен из
    /// сессий. Единственное, чем ответ агента отличается от того, что можно
    /// вывести из описи, — поэтому поле несётся, а не отбрасывается.
    public var origin: ProjectOrigin?
    public var id: String { cwd }
}
public struct ProjectsResult: Decodable, Sendable {
    public let projects: [ProjectInfo]
}

public extension CentralClient {
    private func obj(_ pairs: [String: JSONValue]) -> JSONValue { .object(pairs) }

    private func call<T: Decodable & Sendable>(_ machineId: String, _ method: String, _ params: [String: JSONValue]) async throws -> T {
        let result = try await rpc(machineId: machineId, method: method, params: .object(params))
        // Typed conversion off the main actor (the reply can be megabytes).
        return try await result.decodeOffMain(as: T.self)
    }

    // Files
    public func listFiles(machineId: String, cwd: String, path: String?) async throws -> FsListResult {
        var p: [String: JSONValue] = ["cwd": .string(cwd)]
        if let path { p["path"] = .string(path) }
        return try await call(machineId, "fs.list", p)
    }
    public func readFile(machineId: String, cwd: String, path: String) async throws -> FsReadResult {
        try await call(machineId, "fs.read", ["cwd": .string(cwd), "path": .string(path)])
    }
    @discardableResult
    public func writeFile(machineId: String, cwd: String, path: String, content: String) async throws -> FsWriteResult {
        try await call(machineId, "fs.write", ["cwd": .string(cwd), "path": .string(path), "content": .string(content)])
    }
    /// One new folder `name` directly in `cwd`. For a workspace member the hub
    /// allows only this, only at a shared root, and forces `recursive: false`.
    public func makeFolder(machineId: String, cwd: String, name: String) async throws -> FsMkdirResult {
        try await call(machineId, "fs.mkdir", ["cwd": .string(cwd), "path": .string(name)])
    }

    /// The whole file an answer named, for the chat preview: `fs.peek` windows
    /// stitched together. `path` is absolute or relative to `cwd`; the agent
    /// serves only previewable types inside the project or its Claude scratch
    /// directory and answers anything else with an RPC error.
    ///
    /// Stops with an error — never a truncated copy — when the file is bigger
    /// than `maxBytes` or changes (mtime/size) between windows: half of one
    /// picture and half of the next is worse than «недоступен».
    /// `clip`: a text preview shows the first `maxBytes` of a longer file instead
    /// of refusing it (a 600 KB report is still worth reading the start of).
    public func peekFile(machineId: String, cwd: String, path: String, maxBytes: Int, clip: Bool = false) async throws -> Data {
        let scope = storageScope
        let window = 512 * 1024
        var out = Data()
        var first: (mtime: Double, size: Int)?
        while true {
            try Task.checkCancellation()
            let raw = try await rpc(machineId: machineId, method: "fs.peek", params: .object([
                "cwd": .string(cwd), "path": .string(path),
                "offset": .number(Double(out.count)), "length": .number(Double(clip ? min(window, max(1, maxBytes - out.count)) : window)),
            ]))
            let part = try await raw.decodeOffMain(as: FsPeekResult.self)
            try Task.checkCancellation()
            guard scope == storageScope else { throw ClientError.connectionClosed }
            if let first {
                guard first.mtime == part.mtime, first.size == part.size else { throw ClientError.rpc("file changed while reading") }
            } else {
                guard clip || part.size <= maxBytes else { throw ClientError.rpc("file too large") }
                first = (part.mtime, part.size)
            }
            guard part.offset == out.count, let bytes = Data(base64Encoded: part.data), bytes.count == part.bytes else {
                throw ClientError.rpc("bad window")
            }
            out.append(bytes)
            if part.eof { return out }
            if clip && out.count >= maxBytes { return out.prefix(maxBytes) }
            // A window that moves nothing would loop forever.
            guard part.bytes > 0, out.count <= maxBytes else { throw ClientError.rpc("bad window") }
        }
    }

    // Git
    public func gitStatus(machineId: String, cwd: String) async throws -> GitStatusResult {
        try await call(machineId, "git.status", ["cwd": .string(cwd)])
    }
    public func gitBranches(machineId: String, cwd: String) async throws -> GitBranchesResult {
        try await call(machineId, "git.branches", ["cwd": .string(cwd)])
    }
    public func gitStage(machineId: String, cwd: String, paths: [String]) async throws {
        _ = try await rpc(machineId: machineId, method: "git.stage",
                          params: .object(["cwd": .string(cwd), "paths": .array(paths.map(JSONValue.string))]))
    }
    public func gitUnstage(machineId: String, cwd: String, paths: [String]) async throws {
        _ = try await rpc(machineId: machineId, method: "git.unstage",
                          params: .object(["cwd": .string(cwd), "paths": .array(paths.map(JSONValue.string))]))
    }
    public func gitCommit(machineId: String, cwd: String, message: String) async throws -> GitCommitResult {
        try await call(machineId, "git.commit", ["cwd": .string(cwd), "message": .string(message)])
    }
    public func gitCheckout(machineId: String, cwd: String, branch: String) async throws {
        _ = try await rpc(machineId: machineId, method: "git.checkout",
                          params: .object(["cwd": .string(cwd), "branch": .string(branch)]))
    }

    // Session
    public func sessionImage(machineId: String, sessionId: String, ref: String, source: String?) async throws -> SessionImageResult {
        let scope = storageScope
        var params: [String: JSONValue] = ["sessionId": .string(sessionId), "ref": .string(ref)]
        if let source { params["source"] = .string(source) }
        // The reply carries 3-5 MB of base64: decode it off the main actor.
        let raw = try await rpc(machineId: machineId, method: "session.image", params: .object(params))
        let result = try await raw.decodeOffMain(as: SessionImageResult.self)
        try Task.checkCancellation()
        guard scope == storageScope else { throw ClientError.connectionClosed }
        return result
    }

    /// Reads a transcript AND keeps the copy on disk. `lastModified` is the session
    /// mtime this reply corresponds to; without it the cache cannot tell a current
    /// copy from a stale one, so callers that have it should pass it.
    ///
    /// `limit` asks for only the newest N turns — the hub answers that from its own
    /// replica with an indexed tail read and never wakes the machine, which is what
    /// makes a per-row message preview affordable. A limited reply is a FRAGMENT, so
    /// it is never written to the cache even if a caller passes `lastModified`: the
    /// cache is what the whole session is later read from, and a truncated copy
    /// stored under the current mtime would look current forever.
    @discardableResult
    public func sessionMessages(machineId: String, cwd: String, sessionId: String, source: String?,
                         lastModified: Double? = nil,
                         limit: Int? = nil,
                         toolChars: Int = 1000) async throws -> [HistoryMessage] {
        try await sessionMessagesPage(machineId: machineId, cwd: cwd, sessionId: sessionId, source: source,
                                      lastModified: lastModified, limit: limit, toolChars: toolChars).messages
    }

    /// `sessionMessages` plus the hub's `stale` flag. A stale page is never
    /// written to the cache: stored under the session's CURRENT mtime it would
    /// read as fresh forever, and the open would show an hours-old transcript
    /// without ever asking again (26.09.2026).
    @discardableResult
    public func sessionMessagesPage(machineId: String, cwd: String, sessionId: String, source: String?,
                         lastModified: Double? = nil,
                         limit: Int? = nil,
                         toolChars: Int = 1000) async throws -> HistoryPage {
        var p: [String: JSONValue] = [
            "cwd": .string(cwd),
            "sessionId": .string(sessionId),
            // Tool payloads capped for rendering. On this fleet `tool_use`
            // inputs and `tool_result` bodies are 95-99% of a transcript's
            // bytes — file dumps and diffs this app folds behind a disclosure —
            // and their sizes are long-tailed enough (median ~130 characters,
            // p90 ~1.2k) that this leaves nine blocks in ten whole while an
            // open costs a phone a fraction of what it did. Anything cut says
            // so, in place. See `trim_tool_payloads` in the hub.
            "toolChars": .number(Double(toolChars)),
        ]
        if let source { p["source"] = .string(source) }
        if let limit { p["limit"] = .number(Double(limit)) }
        let cache = transcripts
        let scope = storageScope
        let raw = try await rpc(machineId: machineId, method: "session.messages", params: .object(p))
        try Task.checkCancellation()
        guard scope == storageScope else { throw ClientError.connectionClosed }
        // Off the main actor: this is the 1-2 MB reply.
        let result = try await raw.decodeOffMain(as: SessionMessagesResult.self)
        try Task.checkCancellation()
        let stale = result.stale == true
        // A private machine's transcript was just decrypted: it stays on the screen
        // only, never on this phone's disk (web does the same).
        if let lastModified, limit == nil, !stale, !isPrivateMachine(machineId) {
            let key = TranscriptCache.key(machineId: machineId, sessionId: sessionId)
            await cache.write(key, payload: raw, lastModified: lastModified)
        }
        guard scope == storageScope else { throw ClientError.connectionClosed }
        return HistoryPage(messages: result.messages, stale: stale)
    }

    /// The stored copy, if any — a disk read, no network.
    public func cachedMessages(machineId: String, sessionId: String) async -> [HistoryMessage]? {
        guard !isPrivateMachine(machineId) else { return nil }
        let scope = storageScope
        let messages = await transcripts.read(TranscriptCache.key(machineId: machineId, sessionId: sessionId))
        guard scope == storageScope, !Task.isCancelled else { return nil }
        return messages
    }

    /// True when our copy already matches the session's current mtime.
    public func hasFreshCache(machineId: String, sessionId: String, lastModified: Double) async -> Bool {
        guard !isPrivateMachine(machineId) else { return false }
        return await transcripts.cachedAt(TranscriptCache.key(machineId: machineId, sessionId: sessionId)) == lastModified
    }
    /// `source` routes the rename: a Claude title is written into the
    /// transcript, a Codex one into the agent's own store (a rollout has no
    /// writable title). Omitting it makes the agent detect the runtime itself.
    public func renameSession(machineId: String, cwd: String, sessionId: String, title: String,
                              source: String? = nil) async throws {
        var params: [String: JSONValue] = ["cwd": .string(cwd), "sessionId": .string(sessionId), "title": .string(title)]
        if let source { params["source"] = .string(source) }
        let scope = storageScope
        _ = try await rpc(machineId: machineId, method: "session.rename", params: .object(params))
        guard storageScope == scope else { throw ClientError.connectionClosed }
        if !isPrivateMachine(machineId) {
            navigationTitles.renamed(machineId: machineId, sessionId: sessionId, source: source, title: title)
        }
    }
    public func deleteSession(machineId: String, cwd: String, sessionId: String,
                              source: String? = nil) async throws {
        var params: [String: JSONValue] = ["cwd": .string(cwd), "sessionId": .string(sessionId)]
        if let source { params["source"] = .string(source) }
        _ = try await rpc(machineId: machineId, method: "session.delete", params: .object(params))
    }
    public func forkSession(machineId: String, cwd: String, sessionId: String) async throws -> String {
        let r: SessionForkResult = try await call(machineId, "session.fork",
                                                  ["cwd": .string(cwd), "sessionId": .string(sessionId)])
        return r.sessionId
    }

    // Sub-agents (shared/src/subagents.ts)
    /// A sub-agent's own transcript, read-only — by the parent's call id
    /// (`toolUseId`), by its runtime id (`id`), or both. Never cached: it grows
    /// while the agent works and the sheet re-reads it.
    public func subagentMessages(machineId: String, cwd: String, sessionId: String, source: String?,
                                 toolUseId: String?, id: String?, toolChars: Int = 1000) async throws -> [HistoryMessage] {
        var p: [String: JSONValue] = [
            "cwd": .string(cwd),
            "sessionId": .string(sessionId),
            "toolChars": .number(Double(toolChars)),
        ]
        if let source { p["source"] = .string(source) }
        if let toolUseId, !toolUseId.isEmpty { p["toolUseId"] = .string(toolUseId) }
        if let id, !id.isEmpty { p["id"] = .string(id) }
        let scope = storageScope
        let r: SessionMessagesResult = try await call(machineId, "session.subagent", p)
        guard scope == storageScope else { throw ClientError.connectionClosed }
        return r.messages
    }

    /// Stop one sub-agent (or background task) of the session's live run; the
    /// run and the others go on. The agent refuses an id its run does not know.
    public func stopSubagent(machineId: String, sessionId: String, id: String) async throws {
        _ = try await rpc(machineId: machineId, method: "run.stopSubagent",
                          params: .object(["sessionId": .string(sessionId), "id": .string(id)]))
    }

    // Models
    /// What `machine` can run. `source` names the RUNTIME to ask about: Codex's
    /// model ids are not Claude's, and the built-in fallback is a Claude list —
    /// handing it to a Codex session would offer ids the app-server has never
    /// heard of, so an empty Codex answer falls back to nothing and the control
    /// names only what the run itself reports (web `useModelList` parity).
    public func listModels(machineId: String, source: String? = nil) async throws -> [ModelInfoLite] {
        let isCodex = source == "codex"
        let params: [String: JSONValue] = isCodex ? ["source": .string("codex")] : [:]
        let r: ModelsResult = try await call(machineId, "models.list", params)
        if !r.models.isEmpty { return r.models }
        return isCodex ? [] : DEFAULT_MODELS
    }

    // Projects (new-session picker)
    public func listProjects(machineId: String) async throws -> [ProjectInfo] {
        let r: ProjectsResult = try await call(machineId, "projects.list", [:])
        return r.projects
    }

    // Hardware
    public func listProcesses(machineId: String) async throws -> [ProcessSample] {
        let r: ProcListResult = try await call(machineId, "proc.list", [:])
        return r.processes
    }
    /// TERM asks politely; KILL is the one that always lands. Both are gated on
    /// machine control by the hub.
    public func killProcess(machineId: String, pid: Int, signal: String) async throws -> ProcKillResult {
        try await call(machineId, "proc.kill", ["pid": .number(Double(pid)), "signal": .string(signal)])
    }
}

public struct ProcListResult: Decodable, Sendable { let processes: [ProcessSample] }
public struct ProcKillResult: Decodable, Sendable {
    public let ok: Bool
    public var error: String?
}
