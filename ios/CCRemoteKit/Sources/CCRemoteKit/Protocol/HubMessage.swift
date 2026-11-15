import Foundation

/// One «session was read» mark (see `HubMessage.sessionReads`).
public struct SessionRead: Decodable, Equatable, Sendable {
    public let machineId: String
    public let sessionId: String
    public let at: Double
    public init(machineId: String, sessionId: String, at: Double) {
        self.machineId = machineId; self.sessionId = sessionId; self.at = at
    }
}

/// One finished turn of this person's own run (see `HubMessage.sessionCompletions`).
public struct SessionCompletion: Decodable, Equatable, Sendable {
    public let machineId: String
    public let sessionId: String
    /// Hub time (ms): the run's `since` when it went idle. No answer text: the
    /// hub keeps this past transcript purges and private mode.
    public let at: Double
    public init(machineId: String, sessionId: String, at: Double) {
        self.machineId = machineId; self.sessionId = sessionId; self.at = at
    }
}

/// Central → client frames (mirror `CentralToBrowser` in web-protocol.ts).
/// Decoded from one flat keyed container per frame; unknown `type`s decode to
/// `.unknown` rather than throwing (forward compatibility).
public enum HubMessage: Decodable, Sendable {
    case snapshot(machines: [MachineSnapshot], activeRuns: [ActiveRunInfo]?, roadmap: RoadmapConfig?,
                  viewer: ViewerContext?)
    /// One machine's session list, replacing that machine's entry. The hub sends
    /// this instead of a whole-fleet snapshot when only one machine moved — and
    /// only to a client that asked for it in `hello.caps`, so an older build
    /// keeps getting snapshots rather than a message it would ignore.
    case machineSessions(machine: MachineSnapshot)
    /// Only the sessions of one machine that changed. Upsert by `sessionId`,
    /// replacing each entry WHOLE (never field by field — an optional the agent
    /// stopped reporting, such as a `livePid` that just died, must disappear),
    /// drop `removed`, then re-sort newest-first.
    case sessionUpdates(machineId: String, sessions: [SessionSummary], removed: [String])
    case activity(runs: [ActiveRunInfo])
    case usage(machineId: String, usage: UsageInfo)
    case codexUsage(machineId: String, usage: UsageInfo)
    /// The machine's runtimes changed (a login appeared, Claude switched off).
    case runtimeStatus(machineId: String, runtimes: MachineRuntimes)
    case machineStats(machineId: String, stats: MachineStats)
    /// A session's working tree went from dirty to committed — the Flow board
    /// marks it "ready to close".
    case sessionCommitted(machineId: String, sessionId: String)
    /// Kanban stage delta (drag / confirm Done). Absent stage => left the board.
    case sessionStage(machineId: String, sessionId: String, stage: String?)
    /// A machine recomputed its coding-style profile.
    case builderProfile(machineId: String, profile: BuilderProfile)
    case memoryListResult(requestId: String, ok: Bool, memories: [MemoryEntry]?, error: String?)
    case memoryReadResult(requestId: String, ok: Bool, content: String?, error: String?)
    case memoryDeleteResult(requestId: String, ok: Bool, error: String?)
    /// Answer to `enrich_request`. `ok:false` carries `error` and no enrichment;
    /// "enrichment not configured" is terminal — the client stops asking.
    case enrichResult(requestId: String, ok: Bool, enrichment: Enrichment?, error: String?)
    case opened(runId: String, machineId: String, sessionId: String)
    case sessionStarted(runId: String, sessionId: String)
    case stream(runId: String, sessionId: String, event: StreamEvent)
    case userTurn(runId: String, sessionId: String?, turnId: String, text: String,
                  truncated: Bool?, ts: Double?, images: Int?, files: [String]?)
    case toolRequest(runId: String, sessionId: String, requestId: String, tool: String, input: JSONValue, title: String?)
    case runMode(runId: String, sessionId: String, mode: PermissionMode)
    /// The run's live model / reasoning settings. The `set_` controls travel one
    /// way, so this is the only frame that says what the session is actually on;
    /// the hub replays it on subscribe. nil model/effort = the account default.
    case runSettings(runId: String, sessionId: String, model: String?, activeModel: String?,
                     effort: EffortLevel?, ultracode: Bool)
    /// Context budget for a live run, as the CLI computes it. Numbers are taken
    /// verbatim so the indicator can't disagree with the runtime.
    case contextUsage(runId: String, sessionId: String, totalTokens: Int, maxTokens: Int,
                      percentage: Double, autoCompactThreshold: Double?, autoCompactEnabled: Bool)
    case runStatus(runId: String, sessionId: String, state: RunState, error: String?)
    case error(message: String)
    case rpcResponse(requestId: String, ok: Bool, result: JSONValue?, error: String?)
    case termOpened(termId: String, machineId: String)
    case termData(termId: String, data: String)
    case termExit(termId: String, code: Int?)
    case mirrorOpened(mirrorId: String, machineId: String)
    case mirrorData(mirrorId: String, replace: Bool, messages: [HistoryMessage])
    case mirrorExit(mirrorId: String)
    /// Read marks of this person's devices (`session_reads`): the recent ones after
    /// `hello`, then one at a time. `at` is hub time in ms, comparable with `ActiveRunInfo.since`.
    case sessionReads([SessionRead])
    /// Finished turns of this person's own runs over the last days
    /// (`session_completions`), sent once after the read marks. A run does not
    /// survive an agent restart or the hub's idle reaper; this is how a phone
    /// that slept through the finish still shows its unread dot.
    case sessionCompletions([SessionCompletion])
    case unknown(String)

    private enum K: String, CodingKey {
        case type, machines, machine, activeRuns, roadmap, runs, runId, machineId, sessionId, event
        case requestId, tool, input, title, state, mode, error, message, ok, result
        case termId, data, code, mirrorId, replace, messages
        case usage, source, body, ts, id, stats, viewer, runtimes
        case stage, profile, memories, content, enrichment, sessions, removed
        case totalTokens, maxTokens, percentage, autoCompactThreshold, autoCompactEnabled
        case model, activeModel, effort, ultracode
        case turnId, text, truncated, images, files, reads, at, completions
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        let type = (try? c.decode(String.self, forKey: .type)) ?? ""
        func s(_ k: K) -> String { (try? c.decode(String.self, forKey: k)) ?? "" }
        switch type {
        case "snapshot":
            self = .snapshot(
                machines: (try? c.decode([MachineSnapshot].self, forKey: .machines)) ?? [],
                activeRuns: try? c.decode([ActiveRunInfo].self, forKey: .activeRuns),
                roadmap: try? c.decode(RoadmapConfig.self, forKey: .roadmap),
                viewer: try? c.decode(ViewerContext.self, forKey: .viewer)
            )
        case "machine_sessions":
            self = .machineSessions(machine: try c.decode(MachineSnapshot.self, forKey: .machine))
        case "session_updates":
            self = .sessionUpdates(
                machineId: s(.machineId),
                sessions: (try? c.decode([SessionSummary].self, forKey: .sessions)) ?? [],
                removed: (try? c.decode([String].self, forKey: .removed)) ?? []
            )
        case "activity":
            self = .activity(runs: (try? c.decode([ActiveRunInfo].self, forKey: .runs)) ?? [])
        case "usage":
            self = .usage(machineId: s(.machineId), usage: try c.decode(UsageInfo.self, forKey: .usage))
        case "codex_usage":
            self = .codexUsage(machineId: s(.machineId), usage: try c.decode(UsageInfo.self, forKey: .usage))
        case "runtime_status":
            self = .runtimeStatus(machineId: s(.machineId), runtimes: try c.decode(MachineRuntimes.self, forKey: .runtimes))
        case "machine_stats":
            self = .machineStats(machineId: s(.machineId), stats: try c.decode(MachineStats.self, forKey: .stats))
        case "session_committed":
            self = .sessionCommitted(machineId: s(.machineId), sessionId: s(.sessionId))
        case "session_stage":
            self = .sessionStage(machineId: s(.machineId), sessionId: s(.sessionId),
                                 stage: try? c.decode(String.self, forKey: .stage))
        case "builder_profile":
            self = .builderProfile(machineId: s(.machineId),
                                   profile: try c.decode(BuilderProfile.self, forKey: .profile))
        case "memory_list_result":
            self = .memoryListResult(
                requestId: s(.requestId),
                ok: (try? c.decode(Bool.self, forKey: .ok)) ?? false,
                memories: try? c.decode([MemoryEntry].self, forKey: .memories),
                error: try? c.decode(String.self, forKey: .error)
            )
        case "memory_read_result":
            self = .memoryReadResult(
                requestId: s(.requestId),
                ok: (try? c.decode(Bool.self, forKey: .ok)) ?? false,
                content: try? c.decode(String.self, forKey: .content),
                error: try? c.decode(String.self, forKey: .error)
            )
        case "memory_delete_result":
            self = .memoryDeleteResult(
                requestId: s(.requestId),
                ok: (try? c.decode(Bool.self, forKey: .ok)) ?? false,
                error: try? c.decode(String.self, forKey: .error)
            )
        case "enrich_result":
            self = .enrichResult(
                requestId: s(.requestId),
                ok: (try? c.decode(Bool.self, forKey: .ok)) ?? false,
                enrichment: try? c.decode(Enrichment.self, forKey: .enrichment),
                error: try? c.decode(String.self, forKey: .error)
            )
        case "opened":
            self = .opened(runId: s(.runId), machineId: s(.machineId), sessionId: s(.sessionId))
        case "session_started":
            self = .sessionStarted(runId: s(.runId), sessionId: s(.sessionId))
        case "stream":
            let ev = (try? c.decode(StreamEvent.self, forKey: .event)) ?? StreamEvent(kind: .unknown, text: nil)
            self = .stream(runId: s(.runId), sessionId: s(.sessionId), event: ev)
        case "user_turn":
            self = .userTurn(runId: try c.decode(String.self, forKey: .runId),
                             sessionId: try c.decodeIfPresent(String.self, forKey: .sessionId),
                             turnId: try c.decode(String.self, forKey: .turnId),
                             text: try c.decode(String.self, forKey: .text),
                             truncated: try c.decodeIfPresent(Bool.self, forKey: .truncated),
                             ts: try c.decodeIfPresent(Double.self, forKey: .ts),
                             images: try c.decodeIfPresent(Int.self, forKey: .images),
                             files: try c.decodeIfPresent([String].self, forKey: .files))
        case "tool_request":
            self = .toolRequest(
                runId: s(.runId), sessionId: s(.sessionId), requestId: s(.requestId),
                tool: s(.tool),
                input: (try? c.decode(JSONValue.self, forKey: .input)) ?? .null,
                title: try? c.decode(String.self, forKey: .title)
            )
        case "context_usage":
            self = .contextUsage(
                runId: (try? c.decode(String.self, forKey: .runId)) ?? "",
                sessionId: (try? c.decode(String.self, forKey: .sessionId)) ?? "",
                totalTokens: (try? c.decode(Int.self, forKey: .totalTokens)) ?? 0,
                maxTokens: (try? c.decode(Int.self, forKey: .maxTokens)) ?? 0,
                percentage: (try? c.decode(Double.self, forKey: .percentage)) ?? 0,
                autoCompactThreshold: try? c.decode(Double.self, forKey: .autoCompactThreshold),
                autoCompactEnabled: (try? c.decode(Bool.self, forKey: .autoCompactEnabled)) ?? false
            )
        case "run_mode":
            self = .runMode(
                runId: s(.runId), sessionId: s(.sessionId),
                mode: (try? c.decode(PermissionMode.self, forKey: .mode)) ?? .unknown
            )
        case "run_settings":
            self = .runSettings(
                runId: s(.runId), sessionId: s(.sessionId),
                model: try? c.decode(String.self, forKey: .model),
                activeModel: try? c.decode(String.self, forKey: .activeModel),
                effort: try? c.decode(EffortLevel.self, forKey: .effort),
                ultracode: (try? c.decode(Bool.self, forKey: .ultracode)) ?? false
            )
        case "run_status":
            self = .runStatus(
                runId: s(.runId), sessionId: s(.sessionId),
                state: (try? c.decode(RunState.self, forKey: .state)) ?? .unknown,
                error: try? c.decode(String.self, forKey: .error)
            )
        case "error":
            self = .error(message: s(.message))
        case "rpc_response":
            self = .rpcResponse(
                requestId: s(.requestId),
                ok: (try? c.decode(Bool.self, forKey: .ok)) ?? false,
                result: try? c.decode(JSONValue.self, forKey: .result),
                error: try? c.decode(String.self, forKey: .error)
            )
        case "term_opened":
            self = .termOpened(termId: s(.termId), machineId: s(.machineId))
        case "term_data":
            self = .termData(termId: s(.termId), data: s(.data))
        case "term_exit":
            self = .termExit(termId: s(.termId), code: try? c.decode(Int.self, forKey: .code))
        case "mirror_opened":
            self = .mirrorOpened(mirrorId: s(.mirrorId), machineId: s(.machineId))
        case "mirror_data":
            self = .mirrorData(
                mirrorId: s(.mirrorId),
                replace: (try? c.decode(Bool.self, forKey: .replace)) ?? false,
                messages: (try? c.decode([HistoryMessage].self, forKey: .messages)) ?? []
            )
        case "mirror_exit":
            self = .mirrorExit(mirrorId: s(.mirrorId))
        case "session_reads":
            self = .sessionReads((try? c.decode([SessionRead].self, forKey: .reads)) ?? [])
        case "session_completions":
            self = .sessionCompletions((try? c.decode([SessionCompletion].self, forKey: .completions)) ?? [])
        default:
            self = .unknown(type)
        }
    }
}
