import XCTest
@testable import CCRemoteKit
@testable import CCRemote

/// Golden-frame decode tests: exact JSON shapes the Rust hub emits
/// (`CentralToBrowser` in shared/src/web-protocol.ts). The hub strips null
/// fields, so optionals must decode from *absent* keys, and unknown enum values
/// / message types must degrade to `.unknown` rather than throw.
final class ProtocolDecodingTests: XCTestCase {
    private func decode(_ json: String) throws -> HubMessage {
        try JSONDecoder().decode(HubMessage.self, from: Data(json.utf8))
    }

    func testSnapshotWithMachinesAndRuns() throws {
        let json = """
        {"type":"snapshot","machines":[{"machine":{"machineId":"m-abc","name":"Mac Mini","os":"mac","agentVersion":"0.0.0"},"online":true,"lastSeen":1699999999999,"sessions":[{"sessionId":"s-1","title":"Fix login","cwd":"/Users/x/proj","project":"proj","gitBranch":"main","lastModified":1699999999000,"livePid":1234}]}],"activeRuns":[{"runId":"r-1","machineId":"m-abc","machineName":"Mac Mini","sessionId":"s-1","title":"Fix login","state":"needs_attention","since":1699999999999}]}
        """
        guard case let .snapshot(machines, runs, roadmap, _) = try decode(json) else { return XCTFail("wrong case") }
        XCTAssertEqual(machines.count, 1)
        XCTAssertEqual(machines[0].machine.os, .mac)
        XCTAssertTrue(machines[0].sessions[0].isLive)
        XCTAssertNil(machines[0].machine.hostname)          // absent → nil
        XCTAssertEqual(runs?.first?.state, .needs_attention)
        XCTAssertNil(roadmap)
    }

    func testSnapshotWithoutActiveRuns() throws {
        let json = #"{"type":"snapshot","machines":[]}"#
        guard case let .snapshot(_, runs, _, _) = try decode(json) else { return XCTFail() }
        XCTAssertNil(runs)                                   // absent optional array → nil
    }

    func testOfflineSnapshotRetainsReplicatedCodexSession() throws {
        let json = """
        {"type":"snapshot","machines":[{"machine":{"machineId":"m-off","name":"Sleeping Mac","os":"mac","agentVersion":"0.0.0"},"online":false,"lastSeen":1699999999999,"sessions":[{"sessionId":"s-codex","title":"Replicated work","cwd":"/Users/x/proj","lastModified":1699999999000,"source":"codex"}]}]}
        """
        guard case let .snapshot(machines, _, _, _) = try decode(json) else { return XCTFail("wrong case") }
        XCTAssertFalse(machines[0].online)
        XCTAssertEqual(machines[0].sessions[0].source, "codex")
        XCTAssertTrue(machines[0].sessions[0].isCodex)
    }

    func testSessionProviderOpenCode() throws {
        let json = """
        {"type":"snapshot","machines":[{"machine":{"machineId":"m","name":"M","os":"mac","agentVersion":"0.0.0"},"online":true,"lastSeen":1699999999999,"sessions":[{"sessionId":"s-go","title":"Go work","lastModified":1699999999000,"source":"codex","provider":"opencode"},{"sessionId":"s-cx","title":"Plain","lastModified":1699999999000,"source":"codex"}]}]}
        """
        guard case let .snapshot(machines, _, _, _) = try decode(json) else { return XCTFail("wrong case") }
        XCTAssertEqual(machines[0].sessions[0].provider, "opencode")
        XCTAssertTrue(machines[0].sessions[0].isOpenCode)
        XCTAssertNil(machines[0].sessions[1].provider)
        XCTAssertFalse(machines[0].sessions[1].isOpenCode)
    }

    /// The two session deltas. `machine_sessions` replaces one machine's entry;
    /// `session_updates` carries only the entries that changed plus the ids that
    /// went away. Both are gated on a `hello.caps` entry, so a decode failure
    /// here would show up as a session list that silently stops updating.
    func testMachineSessionsDelta() throws {
        let json = #"{"type":"machine_sessions","machine":{"machine":{"machineId":"m-abc","name":"Mac Mini","os":"mac","agentVersion":"0.0.0"},"online":true,"lastSeen":1699999999999,"sessions":[{"sessionId":"s-1","title":"Fix login","cwd":"/p","lastModified":1699999999000}]}}"#
        guard case let .machineSessions(machine) = try decode(json) else { return XCTFail("wrong case") }
        XCTAssertEqual(machine.machine.machineId, "m-abc")
        XCTAssertEqual(machine.sessions.count, 1)
        XCTAssertEqual(machine.sessions[0].sessionId, "s-1")
    }

    func testSessionUpdatesPatch() throws {
        let json = #"{"type":"session_updates","machineId":"m-abc","sessions":[{"sessionId":"s-1","title":"Fix login","cwd":"/p","lastModified":1699999999000}],"removed":["s-9"]}"#
        guard case let .sessionUpdates(machineId, sessions, removed) = try decode(json) else {
            return XCTFail("wrong case")
        }
        XCTAssertEqual(machineId, "m-abc")
        XCTAssertEqual(sessions.count, 1)
        // The entry replaces its predecessor WHOLE — an optional the agent
        // stopped reporting has to come back nil, not survive from the old copy.
        XCTAssertNil(sessions[0].livePid)
        XCTAssertEqual(removed, ["s-9"])
    }

    /// The hub omits `removed` when nothing went away (zod optional = absent,
    /// never null), so it must decode to an empty list rather than throw.
    func testSessionUpdatesWithoutRemovals() throws {
        let json = #"{"type":"session_updates","machineId":"m","sessions":[]}"#
        guard case let .sessionUpdates(_, sessions, removed) = try decode(json) else {
            return XCTFail("wrong case")
        }
        XCTAssertTrue(sessions.isEmpty)
        XCTAssertTrue(removed.isEmpty)
    }

    func testActivity() throws {
        let json = #"{"type":"activity","runs":[{"runId":"r-1","machineId":"m","sessionId":"s","state":"working","since":1}]}"#
        guard case let .activity(runs) = try decode(json) else { return XCTFail() }
        XCTAssertEqual(runs.first?.state, .working)
    }

    func testSnapshotAndDeltaDecodeCodexLimits() throws {
        let snapshot = #"{"type":"snapshot","machines":[{"machine":{"machineId":"m","name":"Mac","os":"mac","agentVersion":"1"},"online":true,"lastSeen":1,"sessions":[],"codexUsage":{"limits":[{"key":"session","label":"Session (5hr)","group":"session","percent":42,"resetsAt":2000000000000}],"subscription":"pro","updatedAt":10}}]}"#
        guard case let .snapshot(machines, _, _, _) = try decode(snapshot) else { return XCTFail() }
        XCTAssertEqual(machines.first?.codexUsage?.normalizedLimits.first?.percent, 42)
        XCTAssertEqual(machines.first?.codexUsage?.subscription, "pro")

        let delta = #"{"type":"codex_usage","machineId":"m","usage":{"limits":[{"key":"weekly_all","label":"Weekly (7 day)","group":"weekly","percent":63}],"updatedAt":11}}"#
        guard case let .codexUsage(machineId, usage) = try decode(delta) else { return XCTFail() }
        XCTAssertEqual(machineId, "m")
        XCTAssertEqual(usage.normalizedLimits.first?.percent, 63)
    }

    func testSnapshotDecodesServerRoadmapConfig() throws {
        let json = #"{"type":"snapshot","machines":[],"roadmap":{"groups":[{"id":"media","name":"Media","blurb":"News","projects":["hegaismi"]}],"unassigned":{"name":"Other","blurb":"No cwd"}}}"#
        guard case let .snapshot(_, _, roadmap, _) = try decode(json) else { return XCTFail() }
        XCTAssertEqual(roadmap?.groups.first?.id, "media")
        XCTAssertEqual(roadmap?.groups.first?.projects, ["hegaismi"])
        XCTAssertEqual(roadmap?.unassigned.name, "Other")
    }

    func testOpened() throws {
        let json = #"{"type":"opened","runId":"r","machineId":"m","sessionId":"s"}"#
        guard case let .opened(runId, _, _) = try decode(json) else { return XCTFail() }
        XCTAssertEqual(runId, "r")
    }

    func testStreamPartial() throws {
        let json = #"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"partial","text":"Sure, I'll "}}"#
        guard case let .stream(_, _, event) = try decode(json) else { return XCTFail() }
        XCTAssertEqual(event.kind, .partial)
        XCTAssertEqual(event.text, "Sure, I'll ")
    }

    func testUserTurnFullAndMinimal() throws {
        let full = #"{"type":"user_turn","ref":"pane","runId":"r","sessionId":"s","turnId":"u","text":"1-4 гоу","truncated":true,"ts":1790582272038,"images":2,"files":["plan.md"]}"#
        guard case let .userTurn(run, session, turn, text, truncated, ts, images, files) = try decode(full) else { return XCTFail() }
        XCTAssertEqual(run, "r"); XCTAssertEqual(session, "s"); XCTAssertEqual(turn, "u")
        XCTAssertEqual(text, "1-4 гоу"); XCTAssertEqual(truncated, true)
        XCTAssertEqual(ts, 1790582272038); XCTAssertEqual(images, 2); XCTAssertEqual(files, ["plan.md"])
        guard case let .userTurn(_, session, _, _, truncated, ts, images, files) = try decode(#"{"type":"user_turn","runId":"r","turnId":"u","text":""}"#) else { return XCTFail() }
        XCTAssertNil(session); XCTAssertNil(truncated); XCTAssertNil(ts); XCTAssertNil(images); XCTAssertNil(files)
        XCTAssertThrowsError(try decode(#"{"type":"user_turn","runId":"r","text":"missing identity"}"#))
    }

    func testStreamResultNoText() throws {
        let json = #"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"result"}}"#
        guard case let .stream(_, _, event) = try decode(json) else { return XCTFail() }
        XCTAssertEqual(event.kind, .result)
        XCTAssertNil(event.text)
    }

    func testToolRequest() throws {
        let json = #"{"type":"tool_request","runId":"r","sessionId":"s","requestId":"req-9","tool":"Bash","input":{"command":"npm test"},"title":"Run tests"}"#
        guard case let .toolRequest(_, _, requestId, tool, input, title) = try decode(json) else { return XCTFail() }
        XCTAssertEqual(requestId, "req-9")
        XCTAssertEqual(tool, "Bash")
        XCTAssertEqual(input["command"]?.stringValue, "npm test")
        XCTAssertEqual(title, "Run tests")
    }

    func testRunStatus() throws {
        let json = #"{"type":"run_status","runId":"r","sessionId":"s","state":"yielded","error":"editor took it"}"#
        guard case let .runStatus(_, _, state, error) = try decode(json) else { return XCTFail() }
        XCTAssertEqual(state, .yielded)
        XCTAssertEqual(error, "editor took it")
    }

    func testRunMode() throws {
        let json = #"{"type":"run_mode","runId":"r","sessionId":"s","mode":"plan"}"#
        guard case let .runMode(runId, sessionId, mode) = try decode(json) else { return XCTFail() }
        XCTAssertEqual(runId, "r")
        XCTAssertEqual(sessionId, "s")
        XCTAssertEqual(mode, .plan)
    }

    func testRpcResponseOk() throws {
        let json = #"{"type":"rpc_response","requestId":"r-1","ok":true,"result":{"messages":[]}}"#
        guard case let .rpcResponse(_, ok, result, _) = try decode(json) else { return XCTFail() }
        XCTAssertTrue(ok)
        XCTAssertNotNil(result?["messages"])
    }

    func testTermData() throws {
        // ANSI ESC written as the JSON \u001b escape — no raw control bytes in source.
        let json = #"{"type":"term_data","termId":"t","data":"\u001b[32mok\u001b[0m"}"#
        guard case let .termData(termId, data) = try decode(json) else { return XCTFail() }
        XCTAssertEqual(termId, "t")
        XCTAssertTrue(data.contains("ok"))
        XCTAssertTrue(data.contains("\u{1b}"))
    }

    func testMirrorDataDecodesHistoryMessages() throws {
        let json = """
        {"type":"mirror_data","mirrorId":"mir-1","replace":true,"messages":[{"type":"assistant","uuid":"u1","ts":1700000000000,"blocks":[{"kind":"text","text":"hi"},{"kind":"tool_use","id":"tu1","name":"Edit","input":{"file_path":"a.txt"}}]}]}
        """
        guard case let .mirrorData(_, replace, messages) = try decode(json) else { return XCTFail() }
        XCTAssertTrue(replace)
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages[0].role, .assistant)
        XCTAssertEqual(messages[0].ts, 1_700_000_000_000)   // mirror frames are HistoryMessage[] — ts rides along
        XCTAssertEqual(messages[0].blocks.count, 2)
        if case let .text(t) = messages[0].blocks[0] { XCTAssertEqual(t, "hi") } else { XCTFail("block 0") }
        if case let .toolUse(id, name, _) = messages[0].blocks[1] {
            XCTAssertEqual(id, "tu1"); XCTAssertEqual(name, "Edit")
        } else { XCTFail("block 1") }
    }

    /// `HistoryMessageSchema.ts` (shared/src/rpc.ts) is optional and, when the
    /// agent is too old to send it, ABSENT — the reader must not invent a time.
    // linux-skip: reaches outside Protocol/ — see ios/scripts/check-protocol-linux.sh,
    // which compiles the Foundation-only half of the kit on a box with no Xcode.
    func testHistoryMessageDecodesOptionalTs() throws {
        let timed = try JSONDecoder().decode(
            HistoryMessage.self,
            from: Data(#"{"type":"user","uuid":"u","blocks":[{"kind":"text","text":"hi"}],"ts":1700000000000}"#.utf8))
        XCTAssertEqual(timed.ts, 1_700_000_000_000)
        XCTAssertEqual(timed.date, Date(timeIntervalSince1970: 1_700_000_000))

        let untimed = try JSONDecoder().decode(
            HistoryMessage.self,
            from: Data(#"{"type":"user","uuid":"u","blocks":[{"kind":"text","text":"hi"}]}"#.utf8))
        XCTAssertNil(untimed.ts)
        XCTAssertNil(untimed.date)

        // A whole session.messages reply, the shape the transcript cache stores.
        let result = try JSONDecoder().decode(
            SessionMessagesResult.self,
            from: Data(#"{"messages":[{"type":"assistant","uuid":"a","blocks":[],"ts":1700000000000},{"type":"user","uuid":"b","blocks":[]}]}"#.utf8))
        XCTAssertEqual(result.messages.map(\.ts), [1_700_000_000_000, nil])
    }

    // MARK: Forward-compatibility

    func testUnknownMessageType() throws {
        let json = #"{"type":"future_thing","foo":1}"#
        guard case let .unknown(t) = try decode(json) else { return XCTFail() }
        XCTAssertEqual(t, "future_thing")
    }

    func testUnknownStreamKindDoesNotThrow() throws {
        let json = #"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"brand_new_kind","text":"x"}}"#
        guard case let .stream(_, _, event) = try decode(json) else { return XCTFail() }
        XCTAssertEqual(event.kind, .unknown)
    }

    func testUnknownAttentionStateDoesNotThrow() throws {
        let json = #"{"type":"activity","runs":[{"runId":"r","machineId":"m","sessionId":"s","state":"wild","since":1}]}"#
        guard case let .activity(runs) = try decode(json) else { return XCTFail() }
        XCTAssertEqual(runs.first?.state, .unknown)
    }

    // MARK: Outbound encoding (strip-null parity)

    func testOpenOmitsNilMessage() throws {
        let data = try JSONEncoder().encode(
            ClientMessage.open(machineId: "m", sessionId: "s", message: nil, images: nil)
        )
        let str = String(data: data, encoding: .utf8)!
        XCTAssertTrue(str.contains("\"type\":\"open\""))
        XCTAssertFalse(str.contains("message"))             // nil omitted, not null
    }

    /// The agent picker: `source` crosses the wire when chosen, and is ABSENT —
    /// not null — when the hub should decide (member-role viewers, old defaults).
    func testNewSessionEncodesSourceOnlyWhenChosen() throws {
        let chosen = ClientMessage.newSession(machineId: "m", cwd: "/x", message: "go",
                                              images: nil, category: nil, source: "codex")
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(chosen)) as? [String: Any]
        XCTAssertEqual(object?["type"] as? String, "new_session")
        XCTAssertEqual(object?["source"] as? String, "codex")

        let unset = ClientMessage.newSession(machineId: "m", cwd: "/x", message: "go",
                                             images: nil, category: nil, source: nil)
        let str = String(data: try JSONEncoder().encode(unset), encoding: .utf8)!
        XCTAssertFalse(str.contains("source"))
    }

    /// The start-screen run settings. The hub reads all three through zod
    /// `optional` — `T | undefined`, never `T | null` — so an unpicked field has
    /// to be ABSENT. A `null` fails validation and takes the whole start with it.
    func testNewSessionEncodesStartRunSettings() throws {
        let picked = ClientMessage.newSession(machineId: "m", cwd: "/x", message: "go",
                                              images: nil, category: nil, source: "claude",
                                              model: "claude-opus-5", effort: .xhigh,
                                              permissionMode: .plan)
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(picked)) as? [String: Any]
        XCTAssertEqual(object?["model"] as? String, "claude-opus-5")
        XCTAssertEqual(object?["effort"] as? String, "xhigh")
        XCTAssertEqual(object?["permissionMode"] as? String, "plan")

        let unset = ClientMessage.newSession(machineId: "m", cwd: "/x", message: "go",
                                             images: nil, category: nil, source: nil)
        let str = String(data: try JSONEncoder().encode(unset), encoding: .utf8)!
        XCTAssertFalse(str.contains("model"))
        XCTAssertFalse(str.contains("effort"))
        XCTAssertFalse(str.contains("permissionMode"))
        XCTAssertFalse(str.contains("null"))
    }

    /// `default` is the ABSENCE of a mode, not a mode: sending it would pin the
    /// session to something the machine may not even call default. Same for an
    /// empty model string, which is how a cleared picker spells "no pick".
    func testNewSessionOmitsDefaultModeAndEmptyModel() throws {
        let neutral = ClientMessage.newSession(machineId: "m", cwd: "/x", message: nil,
                                               images: nil, category: nil, source: nil,
                                               model: "", effort: nil, permissionMode: .default)
        let str = String(data: try JSONEncoder().encode(neutral), encoding: .utf8)!
        XCTAssertFalse(str.contains("permissionMode"))
        XCTAssertFalse(str.contains("model"))
    }

    /// `bypassPermissions` is the one mode a machine may withhold, and the field
    /// is optional — its ABSENCE must read as "no answer" (the base trio), never
    /// as consent.
    func testMachinePermissionModes() throws {
        let json = """
        {"type":"snapshot","machines":[{"machine":{"machineId":"m-1","name":"Box","os":"linux","agentVersion":"1","permissionModes":["default","plan","acceptEdits","bypassPermissions"]},"online":true,"lastSeen":1,"sessions":[]},{"machine":{"machineId":"m-2","name":"Old","os":"linux","agentVersion":"1"},"online":true,"lastSeen":1,"sessions":[]}]}
        """
        guard case let .snapshot(machines, _, _, _) = try decode(json) else { return XCTFail() }
        XCTAssertTrue(machines[0].machine.offeredPermissionModes.contains(.bypassPermissions))
        XCTAssertEqual(machines[0].machine.offeredPermissionModes(isCodex: true), [.default, .plan])
        XCTAssertEqual(machines[1].machine.offeredPermissionModes, PermissionMode.exposed)
    }

    func testCodexPermissionModesDecodeIndependentlyAndRoundTrip() throws {
        let json = #"{"machineId":"m","name":"Box","os":"mac","agentVersion":"1","permissionModes":["default","plan"],"codexPermissionModes":["default","plan","acceptEdits","bypassPermissions","future-mode"]}"#
        let machine = try JSONDecoder().decode(MachineInfo.self, from: Data(json.utf8))
        XCTAssertEqual(machine.offeredPermissionModes(isCodex: true), [.default, .plan, .acceptEdits, .bypassPermissions])
        XCTAssertEqual(machine.offeredPermissionModes, [.default, .plan])
        let cached = try JSONDecoder().decode(MachineInfo.self, from: JSONEncoder().encode(machine))
        XCTAssertEqual(cached.offeredPermissionModes(isCodex: true), machine.offeredPermissionModes(isCodex: true))
        for modes in [[], [.unknown], [.default, .plan]] as [[PermissionMode]] {
            var restricted = machine
            restricted.codexPermissionModes = modes
            XCTAssertEqual(restricted.offeredPermissionModes(isCodex: true), [.default, .plan])
        }
    }

    /// Workspace views attribute sessions to people, not just machines.
    func testSessionOwnerDecodes() throws {
        let json = """
        {"type":"snapshot","machines":[{"machine":{"machineId":"m-1","name":"Box","os":"linux","agentVersion":"1"},"online":true,"lastSeen":1,"sessions":[{"sessionId":"s-1","title":"T","lastModified":1,"owner":{"userId":"u-9","fullName":"Member"}}]}]}
        """
        guard case let .snapshot(machines, _, _, _) = try decode(json) else { return XCTFail() }
        XCTAssertEqual(machines[0].sessions[0].owner?.userId, "u-9")
        XCTAssertEqual(machines[0].sessions[0].owner?.fullName, "Member")
    }

    // MARK: Stage / profile / memory frames (web-parity import)

    func testSessionStageDecodesWithAndWithoutStage() throws {
        guard case let .sessionStage(m1, s1, stage1) =
            try decode(#"{"type":"session_stage","machineId":"m","sessionId":"s","stage":"testing"}"#)
        else { return XCTFail("wrong case") }
        XCTAssertEqual([m1, s1, stage1], ["m", "s", "testing"])

        guard case let .sessionStage(_, _, stage2) =
            try decode(#"{"type":"session_stage","machineId":"m","sessionId":"s"}"#)
        else { return XCTFail("wrong case") }
        XCTAssertNil(stage2)                                 // absent = left the board
    }

    func testBuilderProfileDecodes() throws {
        let json = """
        {"type":"builder_profile","machineId":"m-1","profile":{"machine":"Mini","generatedAt":1699999999000,"transcriptsScanned":120,"sessions":80,"messages":{"user":400,"assistant":900},"span":{"firstTs":1690000000000,"lastTs":1699999999000,"activeDays":42,"longestStreakDays":9},"cadence":{"hourHistogram":[0,0,0,0,0,0,0,1,2,3,4,5,6,5,4,3,2,1,2,3,4,3,2,1],"weekdayHistogram":[1,5,6,7,6,5,2],"nightOwlShare":0.31,"avgSessionMessages":16.2,"avgSessionMinutes":48.7},"tools":{"counts":{"Bash":320,"Read":410},"buildVsExplore":0.44,"testRunShare":0.12,"gitOpShare":0.2,"toolCallsPerSession":21.5},"steering":{"avgPromptChars":210.3,"shortPromptShare":0.5,"longPromptShare":0.1,"followUpsPerSession":3.4},"engineering":{"filesTouched":900,"topLanguages":[{"name":"ts","count":500}],"repos":12,"branches":34},"planning":{"planModeShare":0.25,"todoShare":0.4,"topSkills":[{"name":"investigate","count":9}]},"models":{"histogram":{"claude-opus-5":700},"avgModelsPerSession":1.1},"scores":{"steering":7.2,"execution":8.1,"engineering":6.9,"planning":5.5,"product":3.2},"archetype":{"primary":"Architect","badges":["Night Owl"]}}}
        """
        guard case let .builderProfile(machineId, profile) = try decode(json) else {
            return XCTFail("wrong case")
        }
        XCTAssertEqual(machineId, "m-1")
        XCTAssertEqual(profile.archetype.primary, "Architect")
        XCTAssertEqual(profile.cadence.hourHistogram.count, 24)
        XCTAssertEqual(profile.scores.execution, 8.1, accuracy: 0.001)
        XCTAssertNil(profile.machineId)                      // optional absent
    }

    func testSnapshotSeedsProfileAndStats() throws {
        let json = """
        {"type":"snapshot","machines":[{"machine":{"machineId":"m-1","name":"Box","os":"linux","agentVersion":"1"},"online":true,"lastSeen":1,"sessions":[],"stats":{"ts":1,"platform":"linux","cpuCount":8,"load1":0.5,"cpuPercent":12.5,"memTotal":16000,"memUsed":800,"swapTotal":0,"swapUsed":0,"diskTotal":100,"diskUsed":50,"uptimeSec":100,"agentRss":100,"agentCpuPercent":1},"profile":{"machine":"Box","generatedAt":1,"transcriptsScanned":1,"sessions":1,"messages":{"user":1,"assistant":1},"span":{"firstTs":1,"lastTs":2,"activeDays":1,"longestStreakDays":1},"cadence":{"hourHistogram":[],"weekdayHistogram":[],"nightOwlShare":0,"avgSessionMessages":0,"avgSessionMinutes":0},"tools":{"counts":{},"buildVsExplore":0,"testRunShare":0,"gitOpShare":0,"toolCallsPerSession":0},"steering":{"avgPromptChars":0,"shortPromptShare":0,"longPromptShare":0,"followUpsPerSession":0},"engineering":{"filesTouched":0,"topLanguages":[],"repos":0,"branches":0},"planning":{"planModeShare":0,"todoShare":0,"topSkills":[]},"models":{"histogram":{},"avgModelsPerSession":0},"scores":{"steering":0,"execution":0,"engineering":0,"planning":0,"product":0},"archetype":{"primary":"Builder","badges":[]}}}]}
        """
        guard case let .snapshot(machines, _, _, _) = try decode(json) else { return XCTFail() }
        XCTAssertEqual(machines[0].profile?.archetype.primary, "Builder")
        XCTAssertNotNil(machines[0].stats)
    }

    func testActiveRunOwnerAndCategoryDecode() throws {
        let json = """
        {"type":"activity","runs":[{"runId":"r-1","machineId":"m","sessionId":"s","state":"working","since":1,"ownerUserId":"u-7","ownerName":"Оля","category":"bugs"}]}
        """
        guard case let .activity(runs) = try decode(json) else { return XCTFail() }
        XCTAssertEqual(runs[0].ownerName, "Оля")
        XCTAssertEqual(runs[0].categoryInfo, .bugs)
    }

    func testMemoryListResultDecodes() throws {
        let ok = """
        {"type":"memory_list_result","requestId":"q1","ok":true,"memories":[{"scope":"fleet","scopeKey":"","path":"MEMORY.md","sha256":"abc","revision":3,"updatedAt":1699999999000,"bytes":9000},{"scope":"machine","scopeKey":"m-1","path":"note.md","sha256":"def","revision":1,"updatedAt":1699999999000}]}
        """
        guard case let .memoryListResult(_, okFlag, memories, _) = try decode(ok) else { return XCTFail() }
        XCTAssertTrue(okFlag)
        XCTAssertEqual(memories?.count, 2)
        XCTAssertEqual(memories?[0].bytes, 9000)
        XCTAssertEqual(memories?[1].bytes, 0)                // zod .default(0), key absent
        XCTAssertEqual(memories?[1].deleted, false)          // zod .default(false)

        let fail = #"{"type":"memory_list_result","requestId":"q2","ok":false,"error":"nope"}"#
        guard case let .memoryListResult(_, okFlag2, memories2, error2) = try decode(fail) else { return XCTFail() }
        XCTAssertFalse(okFlag2)
        XCTAssertNil(memories2)
        XCTAssertEqual(error2, "nope")
    }

    /// Web `isAutomatedSession` parity: the scripted half is narrow on purpose
    /// (sdk-cli, not sdk-*) and an owner always makes it a person's work; the
    /// scratch-cwd half ignores the owner, because the smoke harnesses start
    /// their throwaways through cc-remote and look like real work otherwise.
    func testIsAutomatedSession() throws {
        func summary(entrypoint: String?, owned: Bool, cwd: String? = nil) -> SessionSummary {
            var json = #"{"sessionId":"s","title":"t","lastModified":1"#
            if let entrypoint { json += #","entrypoint":"\#(entrypoint)""# }
            if let cwd { json += #","cwd":"\#(cwd.replacingOccurrences(of: "\\", with: "\\\\"))""# }
            if owned { json += #","owner":{"userId":"u-1"}"# }
            json += "}"
            return try! JSONDecoder().decode(SessionSummary.self, from: Data(json.utf8))
        }
        XCTAssertTrue(summary(entrypoint: "sdk-cli", owned: false).isAutomated)
        // A cron started THROUGH cc-remote has an owner and is still a cron (web parity).
        XCTAssertTrue(summary(entrypoint: "sdk-cli", owned: true).isAutomated)
        XCTAssertFalse(summary(entrypoint: "sdk-ts", owned: false).isAutomated)   // old app resumes
        XCTAssertFalse(summary(entrypoint: "cli", owned: false).isAutomated)
        XCTAssertFalse(summary(entrypoint: nil, owned: false).isAutomated)

        // A smoke run: cc-remote started it, the hub owns it, only the cwd tells.
        XCTAssertTrue(summary(entrypoint: "cc-remote", owned: true,
                              cwd: #"C:\Users\buildbox\AppData\Local\Temp\cc-ui-check-LPlvcx"#).isAutomated)
        for scratch in ["/tmp/cc-ui-check-3Y05jF", "/var/tmp/scratch",
                        "/var/folders/9m/xk1t/T/probe", "/private/var/folders/9m/xk1t/T/probe"] {
            XCTAssertTrue(SessionSummary.isScratchCwd(scratch), "\(scratch) is a throwaway")
        }
        for real in ["/home/devbox/work/circle", "/home/owner/work/tmp/app",
                     #"D:\Hegai_VScode\claudehegai"#, "/tmpfiles-archive/notes"] {
            XCTAssertFalse(SessionSummary.isScratchCwd(real), "\(real) is real work")
        }
        XCTAssertFalse(SessionSummary.isScratchCwd(nil))
        // 30.09.2026: the directory itself, harness scratchpads, the agent's own dir.
        for scratch in ["/tmp", "/tmp/", "/var/tmp", "/tmp/agents-0/-srv-x/abc/scratchpad/wt",
                        "/root/.cc-remote/teo"] {
            XCTAssertTrue(SessionSummary.isScratchCwd(scratch), "\(scratch) is a throwaway")
        }
        for real in ["/home/owner/code/scratchpad", "/srv/main-source/.cc-remote"] {
            XCTAssertFalse(SessionSummary.isScratchCwd(real), "\(real) is real work")
        }
        XCTAssertTrue(SessionSummary.isWorktreeCwd("/srv/main-source/.claude/worktrees/x"))
        XCTAssertTrue(SessionSummary.isProbeTitle("reply with the single word ok"))
        XCTAssertFalse(SessionSummary.isProbeTitle("Ты — интернет-маркетолог, помоги"))
    }

    func testMemoryReadEncodes() throws {
        let msg = ClientMessage.memoryRead(requestId: "q", scope: .project,
                                           scopeKey: "/opt/x", path: "a.md")
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(msg)) as? [String: Any]
        XCTAssertEqual(object?["type"] as? String, "memory_read")
        XCTAssertEqual(object?["scope"] as? String, "project")
        XCTAssertEqual(object?["scopeKey"] as? String, "/opt/x")
        XCTAssertEqual(object?["path"] as? String, "a.md")
    }

    func testRpcRequestEncodesParams() throws {
        let msg = ClientMessage.rpcRequest(requestId: "r-1", machineId: "m", method: "fs.list",
                                           params: .object(["cwd": .string("/x")]))
        let str = String(data: try JSONEncoder().encode(msg), encoding: .utf8)!
        XCTAssertTrue(str.contains("\"method\":\"fs.list\""))
        XCTAssertTrue(str.contains("cwd"))
    }

    func testPlanDecisionEncodesPermissionMode() throws {
        let msg = ClientMessage.toolDecision(
            runId: "r", requestId: "q", allow: true,
            updatedInput: .object([:]), permissionMode: .acceptEdits, message: nil
        )
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(msg)) as? [String: Any]
        XCTAssertEqual(object?["type"] as? String, "tool_decision")
        XCTAssertEqual(object?["permissionMode"] as? String, "acceptEdits")
    }

    /// Identity + per-machine access: the app is a real workspace user, so a
    /// snapshot carries who we are and what each machine allows.
    func testSnapshotCarriesViewerAndMachineAccess() throws {
        let json = """
        {"type":"snapshot","viewer":{"userId":"u-1","email":"a@a.test","fullName":"Owner","platformAdmin":false,"workspace":{"workspaceId":"w-1","name":"Team","kind":"organization","role":"member"},"workspaces":[{"workspaceId":"w-1","name":"Team","kind":"organization","role":"member"},{"workspaceId":"w-0","name":"Personal","kind":"personal","role":"owner"}]},"machines":[{"machine":{"machineId":"m-1","name":"Box","os":"linux","agentVersion":"1"},"online":true,"lastSeen":1,"sessions":[],"canControl":false,"canStart":true,"owner":{"userId":"u-2","email":"b@a.test"}}]}
        """
        guard case let .snapshot(machines, _, _, viewer) = try decode(json) else { return XCTFail() }
        XCTAssertEqual(viewer?.userId, "u-1")
        XCTAssertEqual(viewer?.workspaces.count, 2)
        XCTAssertEqual(viewer?.workspace.role, "member")
        XCTAssertFalse(machines[0].hasControl)
        XCTAssertTrue(machines[0].canDrive)          // control-share: may drive, not control
        XCTAssertEqual(machines[0].owner?.userId, "u-2")
        // A pre-rollout hub omits `access` — the app treats that as fully open.
        XCTAssertNil(viewer?.access)
        XCTAssertTrue(viewer?.isAccessActive ?? false)
    }

    /// The community rollout adds `viewer.access`; a waitlisted viewer decodes
    /// and reports itself as not active, and a sandbox machine keeps decoding
    /// with its `kind` marker ignored by older app code.
    func testSnapshotCarriesViewerAccess() throws {
        let json = """
        {"type":"snapshot","viewer":{"userId":"u-3","email":"c@a.test","platformAdmin":false,"workspace":{"workspaceId":"personal:u-3","name":"Моя работа","kind":"personal","role":"owner"},"workspaces":[],"access":{"state":"waitlist","plan":"community","requestedAt":1,"sandbox":{"status":"queued"},"deviceCap":2}},"machines":[{"machine":{"machineId":"m-9","name":"sb-c","os":"linux","agentVersion":"1"},"kind":"sandbox","online":true,"lastSeen":1,"sessions":[]}]}
        """
        guard case let .snapshot(machines, _, _, viewer) = try decode(json) else { return XCTFail() }
        XCTAssertEqual(viewer?.access?.state, "waitlist")
        XCTAssertEqual(viewer?.access?.sandbox?.status, "queued")
        XCTAssertEqual(viewer?.access?.deviceCap, 2)
        XCTAssertFalse(viewer?.isAccessActive ?? true)
        XCTAssertEqual(machines.count, 1)
    }

    /// A Telegram-only account has no address: the hub omits `email`. The
    /// viewer must still decode (it used to be dropped, unbinding account
    /// storage), and so must a members envelope carrying such a person.
    func testViewerAndMemberWithoutEmailDecode() throws {
        let json = """
        {"type":"snapshot","viewer":{"userId":"tg-1","fullName":"Данис Латыпов","platformAdmin":false,"workspace":{"workspaceId":"personal:tg-1","name":"Моя работа","kind":"personal","role":"owner"},"workspaces":[],"access":{"state":"waitlist","plan":"community","requestedAt":1}},"machines":[]}
        """
        guard case let .snapshot(_, _, _, viewer) = try decode(json) else { return XCTFail() }
        XCTAssertEqual(viewer?.userId, "tg-1")
        XCTAssertNil(viewer?.email)
        XCTAssertEqual(viewer?.displayName, "Данис Латыпов")

        let member = try JSONDecoder().decode(
            MemberSummary.self,
            from: Data(#"{"userId":"tg-1","role":"member","joinedAt":1}"#.utf8))
        XCTAssertNil(member.email)
        XCTAssertEqual(member.displayName, "Без имени")
    }

    /// «Войти через Telegram»: what `start` gives the app (the number it must
    /// show) and every way a poll can answer — a native approval carries the
    /// session in the body, an unknown status must not break the loop.
    func testTelegramLoginStartAndPollDecode() throws {
        let start = try JSONDecoder().decode(TelegramLoginStart.self, from: Data(#"""
        {"code":"0123456789abcdef0123456789abcdef","url":"https://t.me/Hegaicodebot?start=login_0123456789abcdef0123456789abcdef","bot":"Hegaicodebot","pollToken":"p","match":"47","expiresAt":1790000000000,"interval":2}
        """#.utf8))
        XCTAssertEqual(start.match, "47")
        XCTAssertEqual(start.link?.host, "t.me")
        // Whatever a hub sends, only a Telegram https link is ever opened.
        func link(_ url: String) throws -> URL? {
            try JSONDecoder().decode(TelegramLoginStart.self, from: Data(#"{"code":"c","url":"\#(url)","bot":"b","pollToken":"p","match":"47","expiresAt":1,"interval":2}"#.utf8)).link
        }
        XCTAssertNil(try link("ccremote://share"))
        XCTAssertNil(try link("tel:+123"))
        XCTAssertNil(try link("http://t.me/x"))
        XCTAssertNil(try link("https://t.me.evil.test/x"))
        XCTAssertNotNil(try link("https://telegram.me/Hegaicodebot?start=login_x"))

        func poll(_ json: String) throws -> TelegramLoginPoll {
            try JSONDecoder().decode(TelegramLoginPoll.self, from: Data(json.utf8))
        }
        XCTAssertEqual(try poll(#"{"status":"pending"}"#), .pending)
        XCTAssertEqual(try poll(#"{"status":"denied"}"#), .denied)
        XCTAssertTrue(try poll(#"{"status":"expired"}"#).isDeadEnd)
        XCTAssertEqual(try poll(#"{"status":"something-new"}"#), .other("something-new"))
        XCTAssertTrue(try poll(#"{"status":"something-new"}"#).isDeadEnd)
        XCTAssertFalse(try poll(#"{"status":"pending"}"#).isDeadEnd)
        let approved = try poll(#"{"status":"approved","userId":"tg-1","created":true,"telegram":"@danis","session":"s3cr3t","account":{"userId":"tg-1","displayName":"Данис","state":"waitlist"}}"#)
        guard case let .approved(session, userId, telegram, account) = approved else { return XCTFail("\(approved)") }
        XCTAssertEqual(session, "s3cr3t")
        XCTAssertEqual(userId, "tg-1")
        XCTAssertEqual(telegram, "@danis")
        XCTAssertEqual(account.displayName, "Данис")
        // An approval without a session is a contract break, not a silent sign-in.
        XCTAssertThrowsError(try poll(#"{"status":"approved","userId":"tg-1","telegram":"@x","account":{"userId":"tg-1","displayName":"x"}}"#))
        XCTAssertTrue(TelegramLoginWords.end(.denied).contains("не то число"))
        XCTAssertTrue(TelegramLoginWords.refusal(status: 404, error: "telegram sign-in is not configured on this hub").contains("выключен"))
        XCTAssertTrue(TelegramLoginWords.refusal(status: 429, error: nil).contains("Слишком много"))
    }

    /// «Способы входа»: `label` and `lastUsedAt` are absent when the hub has
    /// nothing to say, and every refusal of a link has words.
    func testIdentitiesDecodeWithAbsentFieldsAndRefusalsHaveWords() throws {
        let json = #"{"identities":[{"provider":"hegai","subject":"u1","linkedAt":1},{"provider":"telegram","subject":"42","label":"@x","linkedAt":2,"lastUsedAt":3}],"available":{"google":true,"apple":false,"telegram":true}}"#
        let decoded = try JSONDecoder().decode(IdentitiesResponse.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.identities.count, 2)
        XCTAssertNil(decoded.identities[0].label)
        XCTAssertEqual(decoded.identities[0].providerName, "HegAI")
        XCTAssertEqual(decoded.identities[1].id, "telegram:42")
        XCTAssertEqual(decoded.identities[1].lastUsedAt, 3)
        XCTAssertFalse(decoded.available.apple)
        XCTAssertTrue(IdentityWords.error("identity_owner_has_data").contains("перенести его сюда нельзя"))
        XCTAssertTrue(IdentityWords.error("last_identity").contains("последний"))
        XCTAssertFalse(IdentityWords.error("something_new").contains("something_new"))
        XCTAssertTrue(TelegramLoginWords.refusal(status: 409, error: "identity_owner_has_data").contains("перенести"))
    }

    /// The viewer names the linked Telegram account when there is one.
    func testViewerCarriesTheLinkedTelegram() throws {
        let json = """
        {"type":"snapshot","viewer":{"userId":"u-1","email":"a@x","telegram":"@owner","platformAdmin":false,"workspace":{"workspaceId":"personal:u-1","name":"Моя работа","kind":"personal","role":"owner"},"workspaces":[]},"machines":[]}
        """
        guard case let .snapshot(_, _, _, viewer) = try decode(json) else { return XCTFail() }
        XCTAssertEqual(viewer?.telegram, "@owner")
    }

    /// Absent access flags mean an older hub with no restrictions — never a lockout.
    func testMachineWithoutAccessFlagsIsFullyControllable() throws {
        let json = #"{"type":"snapshot","machines":[{"machine":{"machineId":"m","name":"n","os":"mac","agentVersion":"1"},"online":true,"lastSeen":1,"sessions":[]}]}"#
        guard case let .snapshot(machines, _, _, _) = try decode(json) else { return XCTFail() }
        XCTAssertTrue(machines[0].hasControl)
        XCTAssertTrue(machines[0].canDrive)
    }

    func testMachineStatsAndCommittedDecode() throws {
        let stats = """
        {"type":"machine_stats","machineId":"m-1","stats":{"ts":1,"platform":"linux","cpuCount":8,"load1":0.5,"load5":0.4,"load15":0.3,"cpuPercent":42,"memTotal":100,"memUsed":50,"swapTotal":0,"swapUsed":0,"diskTotal":200,"diskUsed":100,"uptimeSec":3600,"agentRss":1000,"agentCpuPercent":1.5}}
        """
        guard case let .machineStats(machineId, sample) = try decode(stats) else { return XCTFail() }
        XCTAssertEqual(machineId, "m-1")
        XCTAssertEqual(sample.cpuCount, 8)
        XCTAssertEqual(sample.cpuPercent, 42)

        let committed = #"{"type":"session_committed","machineId":"m-1","sessionId":"s-1"}"#
        guard case let .sessionCommitted(m, s) = try decode(committed) else { return XCTFail() }
        XCTAssertEqual([m, s], ["m-1", "s-1"])
    }

    /// Session titles are the first transcript line — often injected markdown.
    func testCleanTitleFlattensInjectedContext() {
        XCTAssertEqual(cleanTitle("# Files mentioned by the user: ## src/app.ts"),
                       "Files mentioned by the user: src/app.ts")
        XCTAssertEqual(cleanTitle("<image name=[shot.png] path=/tmp/a> исправь верстку"),
                       "исправь верстку")
        XCTAssertEqual(cleanTitle("**bold** `code`"), "bold code")
        XCTAssertEqual(cleanTitle("snake_case survives"), "snake_case survives")
    }

    /// Ultracode is its own flag, not an effort value the agent would reject.
    func testUltracodeEncodesAsAFlag() throws {
        let msg = ClientMessage.setEffort(runId: "r", effort: nil, ultracode: true)
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(msg)) as? [String: Any]
        XCTAssertEqual(object?["type"] as? String, "set_effort")
        XCTAssertEqual(object?["ultracode"] as? Bool, true)
        XCTAssertNil(object?["effort"])

        let plain = ClientMessage.setEffort(runId: "r", effort: .xhigh, ultracode: false)
        let plainObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(plain)) as? [String: Any]
        XCTAssertEqual(plainObject?["effort"] as? String, "xhigh")
        XCTAssertNil(plainObject?["ultracode"])
    }

    /// The native SSO handshake: hub URL in, https SSO entry point out, and the
    /// session lifted from the custom-scheme callback.
    // linux-skip: reaches outside Protocol/ — see ios/scripts/check-protocol-linux.sh,
    // which compiles the Foundation-only half of the kit on a box with no Xcode.
    func testNativeSSOURLsAndCallbackParsing() {
        let start = HegaiAuth.ssoStartURL(hubURL: "wss://code.acme.test/mobile/ui")
        XCTAssertEqual(start?.absoluteString, "https://code.acme.test/api/auth/google/start?native=1")
        XCTAssertEqual(HegaiAuth.apiBase(hubURL: "ws://127.0.0.1:4319/ui")?.absoluteString,
                       "http://127.0.0.1:4319")
        XCTAssertEqual(HegaiAuth.sessionToken(from: URL(string: "ccremote://auth?session=abc123")!),
                       "abc123")
        XCTAssertNil(HegaiAuth.sessionToken(from: URL(string: "ccremote://auth")!))
    }

    // MARK: - Removed frames

    /// The personal tape is gone from the app (1.0.29). A hub that still sends
    /// `tape_update` must land on `.unknown`, never fail the frame.
    func testTapeUpdateIsNowUnknown() throws {
        guard case let .unknown(type) = try decode(#"{"type":"tape_update","turnId":"s-1:u-9"}"#) else { return XCTFail() }
        XCTAssertEqual(type, "tape_update")
    }

    func testSessionReadsDecodeAndEncode() throws {
        guard case let .sessionReads(reads) = try decode(
            #"{"type":"session_reads","reads":[{"machineId":"m-1","sessionId":"s-1","at":1760000000123},{"machineId":"m-2","sessionId":"s-2","at":5}]}"#
        ) else { return XCTFail() }
        XCTAssertEqual(reads, [SessionRead(machineId: "m-1", sessionId: "s-1", at: 1_760_000_000_123),
                               SessionRead(machineId: "m-2", sessionId: "s-2", at: 5)])
        guard case let .sessionReads(none) = try decode(#"{"type":"session_reads","reads":[]}"#) else { return XCTFail() }
        XCTAssertTrue(none.isEmpty)
        guard case let .sessionCompletions(done) = try decode(
            #"{"type":"session_completions","completions":[{"machineId":"m-1","sessionId":"s-1","at":1760000000123},{"machineId":"m-2","sessionId":"s-2","at":5}]}"#
        ) else { return XCTFail() }
        XCTAssertEqual(done, [SessionCompletion(machineId: "m-1", sessionId: "s-1", at: 1_760_000_000_123),
                              SessionCompletion(machineId: "m-2", sessionId: "s-2", at: 5)])
        let object = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(ClientMessage.sessionRead(machineId: "m", sessionId: "s"))) as? [String: String]
        XCTAssertEqual(object, ["type": "session_read", "machineId": "m", "sessionId": "s"])
    }
    /// `statsOnDemand` contract (hub: `machine_stats` only while a screen asks).
    func testStatsInterestAndHelloCapsWire() throws {
        let on = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(ClientMessage.statsInterest(on: true))) as? [String: Any]
        XCTAssertEqual(on?["type"] as? String, "stats_interest")
        XCTAssertEqual(on?["on"] as? Bool, true)
        XCTAssertEqual(on?.count, 2)
        let off = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(ClientMessage.statsInterest(on: false))) as? [String: Any]
        XCTAssertEqual(off?["on"] as? Bool, false)
        let hello = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(ClientMessage.hello(client: "app", caps: ["sessionDelta", "sessionPatch", "statsOnDemand"]))) as? [String: Any]
        XCTAssertEqual(hello?["caps"] as? [String], ["sessionDelta", "sessionPatch", "statsOnDemand"])
    }
}
