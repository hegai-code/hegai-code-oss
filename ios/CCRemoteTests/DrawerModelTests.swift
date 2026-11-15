import XCTest
@testable import CCRemote
@testable import CCRemoteKit

@MainActor
final class DrawerModelTests: XCTestCase {
    private func fleet(count: Int = 1000) throws -> [MachineSnapshot] {
        let sessions = (0..<count).map { i in
            ["sessionId": "s\(i)", "title": "Session \(i)", "cwd": "/projects/demo", "project": "Demo",
             "lastModified": i, "stage": "backlog"] as [String: Any]
        }
        let data = try JSONSerialization.data(withJSONObject: [[
            "machine": ["machineId": "m", "name": "Mac", "os": "mac", "agentVersion": "1"],
            "online": true, "canControl": true, "canStart": true, "lastSeen": 1, "sessions": sessions
        ]])
        return try JSONDecoder().decode([MachineSnapshot].self, from: data)
    }

    func testHomePrioritiesRetainReadResultsAndOldUnreadWithoutDuplicates() throws {
        let model = DrawerModel()
        let now = Date(timeIntervalSince1970: 1_000_000)
        let stamp = now.timeIntervalSince1970 * 1000
        let runs = [ActiveRunInfo(runId: "r1", machineId: "m", sessionId: "s1", state: .needs_attention, since: stamp, ownerUserId: "me"),
                    ActiveRunInfo(runId: "r2", machineId: "m", sessionId: "s2", state: .working, since: stamp, ownerUserId: "me")]
        model.update(machines: try fleet(count: 5), runs: runs, favorites: [], viewerId: "me")
        let completions = ["m::s0": SessionCompletionReads.Completion(at: stamp - 1000),
                           "m::s3": SessionCompletionReads.Completion(at: stamp - 100_000_000),
                           "m::s4": SessionCompletionReads.Completion(at: stamp - 100_000_000)]
        let before = HomeSessions(corpus: model.corpus, completions: completions, unread: ["m::s0": stamp, "m::s3": 1], now: now)
        XCTAssertEqual(before.attention.map(\.id), ["m::s1"])
        XCTAssertEqual(before.working.map(\.id), ["m::s2"])
        XCTAssertEqual(before.completed.map(\.id), ["m::s0", "m::s3"])
        let after = HomeSessions(corpus: model.corpus, completions: completions, unread: ["m::s3": 1], now: now)
        XCTAssertEqual(before.completed.map(\.id), after.completed.map(\.id))
    }

    func testHomeExternalEditorWorkAndAttentionSupersedeSavedCompletions() throws {
        let model = DrawerModel()
        var machines = try fleet(count: 3)
        for (index, status) in ["busy", "waiting", "idle"].enumerated() {
            machines[0].sessions[index].livePid = index + 1
            machines[0].sessions[index].liveStatus = status
        }
        model.update(machines: machines, runs: [], favorites: [], viewerId: "me")
        let stamp = Date().timeIntervalSince1970 * 1000
        let completions = Dictionary(uniqueKeysWithValues: (0..<3).map {
            ("m::s\($0)", SessionCompletionReads.Completion(at: stamp))
        })
        let home = HomeSessions(corpus: model.corpus, completions: completions, unread: [:])
        XCTAssertEqual(home.working.map(\.id), ["m::s0"])
        XCTAssertEqual(home.attention.map(\.id), ["m::s1"])
        XCTAssertEqual(home.completed.map(\.id), ["m::s2"])
    }

    func testBurgerPrioritizesUnseenDecisionAndIgnoresHiddenSessions() throws {
        let model = DrawerModel()
        let run = ActiveRunInfo(runId: "r", machineId: "m", sessionId: "s1",
                                state: .needs_attention, since: 20, ownerUserId: "me")
        var machines = try fleet(count: 3)
        machines[0].sessions[2].owner = try JSONDecoder().decode(MachineOwner.self, from: Data(#"{"userId":"colleague"}"#.utf8))
        model.update(machines: machines, runs: [run], favorites: [], viewerId: "me",
                     unreadCompletions: ["m::s0": 10])
        let corpus = model.corpus
        XCTAssertEqual(corpus.indicator(unreadDecisions: ["m::s1"], unreadCompletions: ["m::s0": 10]), .attention)
        XCTAssertEqual(corpus.indicator(unreadDecisions: [], unreadCompletions: ["m::s0": 10]), .completed)
        XCTAssertNil(corpus.indicator(unreadDecisions: ["m::s2", "hidden::s"],
                                     unreadCompletions: ["m::s2": 10, "hidden::s": 10]))
        XCTAssertNil(corpus.indicator(unreadDecisions: [], unreadCompletions: [:]))
    }

    func testRepeatedReadsAndIdenticalSnapshotReusePreparedInventory() throws {
        let model = DrawerModel()
        let machines = try fleet()
        model.update(machines: machines, runs: [], favorites: [], viewerId: "me")
        for _ in 0..<120 {
            XCTAssertEqual(model.corpus.items.count, 1000)
            XCTAssertEqual(model.corpus.projects.first?.preview.count, 2)
        }
        model.update(machines: machines, runs: [], favorites: [], viewerId: "me")
        XCTAssertEqual(model.rebuilds, 1)
        XCTAssertEqual(model.corpus.projects.first?.items.first?.session.sessionId, "s999")
        XCTAssertEqual(model.corpus.projects.map(\.title), ["Demo"])
    }

    func testFullListSearchAndAccountReset() throws {
        let model = DrawerModel()
        model.update(machines: try fleet(), runs: [], favorites: [], viewerId: "me")
        XCTAssertEqual(model.sessions(projectId: "m::/projects/demo", query: "").count, 1000)
        XCTAssertEqual(model.sessions(projectId: "m::/projects/demo", query: "Session").count, 1000)
        XCTAssertEqual(model.sessions(query: "Session 999").map(\.id), ["m::s999"])
        XCTAssertTrue(model.sessions(projectId: "missing", query: "").isEmpty)
        model.update(machines: [], runs: [], favorites: [], viewerId: "me")
        XCTAssertTrue(model.corpus.projects.isEmpty)
        XCTAssertTrue(model.sessions(query: "").isEmpty)
    }

    // 11.11.2026: projects with active work lead; quiet ones sink, by creation.
    func testActiveProjectsLeadQuietOnesSink() throws {
        let model = DrawerModel()
        var machines = try fleet(count: 4)
        machines[0].sessions[0].project = "Older active"
        machines[0].sessions[0].cwd = "/projects/older"
        let working = try JSONDecoder().decode(ActiveRunInfo.self, from: Data(#"{"runId":"r","machineId":"m","sessionId":"s0","state":"working","since":1}"#.utf8))
        model.update(machines: machines, runs: [], favorites: [], viewerId: "me", now: 10)
        XCTAssertEqual(model.corpus.projects.map(\.title), ["Demo", "Older active"])
        model.update(machines: machines, runs: [working], favorites: [], viewerId: "me", now: 10)
        XCTAssertEqual(model.corpus.projects.map(\.title), ["Older active", "Demo"])
        XCTAssertEqual(model.corpus.projects.first?.activeCount, 1)
        XCTAssertEqual(model.corpus.shelves.recent.map(\.title), ["Older active", "Demo"])

        let waiting = try JSONDecoder().decode(ActiveRunInfo.self, from: Data(#"{"runId":"r","machineId":"m","sessionId":"s0","state":"needs_attention","since":1}"#.utf8))
        model.update(machines: machines, runs: [waiting], favorites: [], viewerId: "me")
        XCTAssertEqual(model.corpus.projects.map(\.title), ["Older active", "Demo"])
    }

    // 11.11.2026: working first, then by creation time; a fresh write does not move a row.
    func testSessionsOrderByCreationNotLastChange() throws {
        let model = DrawerModel()
        var machines = try fleet(count: 3)
        // s0 was started last but s2 was written to most recently.
        machines[0].sessions[0].createdAt = 300
        machines[0].sessions[1].createdAt = 200
        machines[0].sessions[2].createdAt = 100
        let working = try JSONDecoder().decode(ActiveRunInfo.self, from: Data(#"{"runId":"r","machineId":"m","sessionId":"s2","state":"working","since":1}"#.utf8))
        model.update(machines: machines, runs: [working], favorites: [], viewerId: "me", now: 1_000)
        let demo = try XCTUnwrap(model.corpus.projects.first)
        XCTAssertEqual(demo.items.map(\.id), ["m::s2", "m::s0", "m::s1"])
        XCTAssertEqual(demo.preview.map(\.id), ["m::s2", "m::s0", "m::s1"])
        model.update(machines: machines, runs: [], favorites: [], viewerId: "me", now: 1_000)
        XCTAssertEqual(try XCTUnwrap(model.corpus.projects.first).items.map(\.id), ["m::s0", "m::s1", "m::s2"],
                       "lastModified (s2 newest) does not order rows; creation does")
    }

    func testSearchMatchesDisplayedTitleAndOriginalPrompt() throws {
        let model = DrawerModel()
        model.update(machines: try fleet(count: 2), runs: [], favorites: [], viewerId: "me")
        let renamed: (SessionItem) -> String = { $0.session.sessionId == "s0" ? "Модалка и клавиатура" : $0.session.title }
        let matches = model.sessions(query: "клавиатура", title: renamed)
        XCTAssertEqual(matches.map(\.id), ["m::s0"])
        XCTAssertEqual(model.sessions(query: "Session 0", title: renamed).count, 1)
    }

    func testIdentityUsesMachineAndDirectoryNotLabel() throws {
        let model = DrawerModel()
        var machines = try fleet(count: 3)
        machines[0].sessions[1].cwd = "/other/demo"
        machines[0].sessions[2].project = " "
        machines[0].sessions[2].cwd = nil
        let other = try JSONDecoder().decode(MachineSnapshot.self, from: Data(#"{"machine":{"machineId":"other","name":"Server","os":"linux","agentVersion":"1"},"online":true,"canStart":true,"lastSeen":1,"sessions":[{"sessionId":"x","title":"Other","cwd":"/projects/demo","project":"Demo","lastModified":4}]}"#.utf8))
        machines.append(other)
        model.update(machines: machines, runs: [], favorites: [], viewerId: "me")
        XCTAssertEqual(model.corpus.projects.count, 4)
        XCTAssertEqual(model.corpus.projects.filter { $0.title == "Demo" }.count, 3)
        let local = try XCTUnwrap(model.corpus.projects.first { $0.id == "m::/projects/demo" })
        XCTAssertEqual(local.target?.machineId, "m")
        XCTAssertEqual(local.target?.cwd, "/projects/demo")
        let unknown = try XCTUnwrap(model.corpus.projects.first { $0.title == "Без проекта" })
        XCTAssertNil(unknown.target)
        XCTAssertNotNil(unknown.unavailableReason)
        machines[0].online = false
        model.update(machines: machines, runs: [], favorites: [], viewerId: "me")
        XCTAssertNil(model.corpus.projects.first { $0.id == local.id }?.target)
    }

    func testNewRunIsVisibleBeforeInventoryAndDoesNotDuplicateAfterward() throws {
        let model = DrawerModel()
        let run = try JSONDecoder().decode(ActiveRunInfo.self, from: Data(#"{"runId":"r","machineId":"m","sessionId":"s2","project":"Demo","title":"New session","state":"working","since":10}"#.utf8))
        model.update(machines: try fleet(count: 2), runs: [run], favorites: [], viewerId: "me")
        XCTAssertEqual(model.corpus.items.count, 3)
        XCTAssertEqual(model.corpus.projects.first?.items.first?.id, "m::s2")
        model.update(machines: try fleet(count: 3), runs: [run], favorites: [], viewerId: "me")
        XCTAssertEqual(model.corpus.items.count, 3)
    }

    func testSharedMachineDoesNotMixTeamSessionsIntoMyDrawerOrSearch() throws {
        let model = DrawerModel()
        var machines = try fleet(count: 3)
        machines[0].owner = MachineOwner(userId: "me")
        machines[0].shared = true
        machines[0].sessions[0].owner = MachineOwner(userId: "me")
        machines[0].sessions[1].owner = MachineOwner(userId: "colleague")
        machines[0].sessions[1].project = "circle"
        machines[0].sessions[1].title = "Разверни"
        model.update(machines: machines, runs: [], favorites: ["m::s1"], viewerId: "me")
        XCTAssertEqual(model.corpus.items.map(\.id), ["m::s0"])
        XCTAssertEqual(model.corpus.projects.map(\.title), ["Demo"])
        XCTAssertTrue(model.sessions(query: "Разверни").isEmpty)
        XCTAssertTrue(model.sessions(query: "circle").isEmpty)
        // Ownership changes must invalidate the cache even with identical data.
        model.update(machines: machines, runs: [], favorites: ["m::s1"], viewerId: "colleague")
        XCTAssertEqual(model.corpus.items.map(\.id), ["m::s1"])
        XCTAssertEqual(model.rebuilds, 2)
        model.update(machines: machines, runs: [], favorites: [], viewerId: nil)
        XCTAssertTrue(model.corpus.items.isEmpty)
    }

    func testPersonalMachineKeepsUnattributedLocalWorkButNotExplicitTeamWork() throws {
        let model = DrawerModel()
        var machines = try fleet(count: 2)
        machines[0].owner = MachineOwner(userId: "me")
        machines[0].sessions[1].owner = MachineOwner(userId: "colleague")
        model.update(machines: machines, runs: [], favorites: [], viewerId: "me")
        XCTAssertEqual(model.corpus.items.map(\.id), ["m::s0"])
        machines[0].owner = MachineOwner(userId: "colleague")
        model.update(machines: machines, runs: [], favorites: [], viewerId: "me")
        XCTAssertTrue(model.corpus.items.isEmpty)
    }

    func testRunOwnershipBridgesInventoryDelayWithoutAttributingTeamWorkToMe() throws {
        let model = DrawerModel()
        var machines = try fleet(count: 3)
        machines[0].owner = MachineOwner(userId: "me")
        machines[0].shared = true
        machines[0].sessions[2].owner = MachineOwner(userId: "colleague")
        let runs = try JSONDecoder().decode([ActiveRunInfo].self, from: Data(#"""
        [
            {"runId":"r0","machineId":"m","sessionId":"s0","ownerUserId":"me","state":"working","since":1},
            {"runId":"r1","machineId":"m","sessionId":"s1","ownerUserId":"colleague","state":"working","since":2},
            {"runId":"r2","machineId":"m","sessionId":"s2","ownerUserId":"me","state":"working","since":3},
            {"runId":"r3","machineId":"m","sessionId":"new-mine","ownerUserId":"me","state":"working","since":4},
            {"runId":"r4","machineId":"m","sessionId":"new-team","ownerUserId":"colleague","project":"circle","state":"working","since":5},
            {"runId":"r5","machineId":"m","sessionId":"unattributed","state":"working","since":6}
        ]
        """#.utf8))
        model.update(machines: machines, runs: runs, favorites: [], viewerId: "me")
        XCTAssertEqual(Set(model.corpus.items.map(\.id)), ["m::s0", "m::new-mine"])
        XCTAssertFalse(model.corpus.projects.contains { $0.title == "circle" })
        XCTAssertEqual(model.corpus.projects.reduce(0) { $0 + $1.activeCount }, 2)
        // A missing session owner on a personal machine must still respect
        // an explicitly attributed run by someone else.
        machines[0].shared = false
        model.update(machines: machines, runs: runs, favorites: [], viewerId: "me")
        XCTAssertFalse(model.corpus.items.contains { $0.id == "m::s1" || $0.id == "m::new-team" })
    }
    func testUnreadCompletionStaysInPreviewBeyondFourActiveRowsAndClears() throws {
        let model = DrawerModel()
        let machines = try fleet(count: 10)
        let runs = try JSONDecoder().decode([ActiveRunInfo].self, from: JSONSerialization.data(withJSONObject:
            (5..<10).map { ["runId": "r\($0)", "machineId": "m", "sessionId": "s\($0)",
                           "state": "working", "since": 10] as [String: Any] }))
        model.update(machines: machines, runs: runs, favorites: [], viewerId: "me", unreadCompletions: ["m::s0": 50])
        XCTAssertTrue(try XCTUnwrap(model.corpus.projects.first).preview.contains { $0.id == "m::s0" })
        model.update(machines: machines, runs: runs, favorites: [], viewerId: "me")
        XCTAssertFalse(try XCTUnwrap(model.corpus.projects.first).preview.contains { $0.id == "m::s0" })
    }

    func testUnreadAnswerKeepsMarkerWithoutOverridingRecency() throws {
        let model = DrawerModel()
        var machines = try fleet(count: 10)
        machines[0].sessions[0].cwd = "/projects/older"   // "/older" would be rootish
        model.update(machines: machines, runs: [], favorites: [], viewerId: "me", unreadCompletions: ["m::s0": 50])
        XCTAssertEqual(model.corpus.projects.first?.id, "m::/projects/demo")
        XCTAssertEqual(model.corpus.projects.last?.unreadCompletions, ["m::s0"])
        model.update(machines: try fleet(count: 10), runs: [], favorites: [], viewerId: "me",
                     unreadCompletions: ["m::s0": 50])
        XCTAssertEqual(model.corpus.projects.first?.items.first?.id, "m::s9")
        XCTAssertTrue(try XCTUnwrap(model.corpus.projects.first).preview.contains { $0.id == "m::s0" })
    }

    func testUnchangedInventoryAgesWithoutRebuildingGroups() throws {
        let model = DrawerModel()
        let machines = try fleet(count: 2)
        model.update(machines: machines, runs: [], favorites: [], viewerId: "me", now: 10)
        XCTAssertEqual(model.corpus.shelves.recent.count, 1)
        model.update(machines: machines, runs: [], favorites: [], viewerId: "me",
                     now: DrawerModel.recentWindow + 10)
        XCTAssertTrue(model.corpus.shelves.recent.isEmpty)
        XCTAssertEqual(model.corpus.shelves.older.count, 1)
        XCTAssertEqual(model.rebuilds, 1)
    }

    func testFilteredActiveSessionsDoNotReturnAsProvisionalRows() async {
        let h = ClientHarness()
        let previous = h.client.showAutomated
        defer { h.client.showAutomated = previous; h.clean() }
        h.client.showAutomated = false
        await h.connect()
        h.sockets.last!.feed(#"{"type":"snapshot","machines":[{"machine":{"machineId":"m","name":"Mac","os":"mac","agentVersion":"1"},"online":true,"canControl":true,"canStart":true,"lastSeen":1,"sessions":[{"sessionId":"cron","title":"Automation","project":"Cron","cwd":"/projects/cron","entrypoint":"sdk-cli","lastModified":1}]}],"activeRuns":[{"runId":"r-cron","machineId":"m","sessionId":"cron","state":"working","since":1},{"runId":"r-new","machineId":"m","sessionId":"new","title":"New chat","state":"working","since":2}]}"#)
        for _ in 0..<100 where h.client.activeRuns.count != 2 { await h.settle() }
        XCTAssertEqual(h.client.hiddenAutomatedSessionKeys, ["m::cron"])
        XCTAssertEqual(h.client.automatedHidden, 1)
        let model = DrawerModel()
        func refresh() {
            model.update(machines: h.client.machines, runs: h.client.activeRuns, favorites: [], viewerId: nil,
                         excludedSessions: h.client.hiddenAutomatedSessionKeys)
        }
        refresh()
        XCTAssertEqual(model.corpus.items.map(\.id), ["m::new"])
        XCTAssertEqual(h.client.activeRuns.count, 2, "Visibility never changes run lifecycle")
        h.client.showAutomated = true
        refresh()
        XCTAssertEqual(Set(model.corpus.items.map(\.id)), ["m::new", "m::cron"])
        XCTAssertTrue(h.client.hiddenAutomatedSessionKeys.isEmpty)
    }


    // 30.09.2026: an open editor (livePid) no longer leads; the newest change does.
    func testOpenEditorDoesNotOutrankFreshWork() throws {
        let model = DrawerModel()
        var machines = try fleet(count: 2)
        machines[0].sessions[0].project = "Old editor"
        machines[0].sessions[0].cwd = "/projects/old"
        machines[0].sessions[0].livePid = 42
        model.update(machines: machines, runs: [], favorites: [], viewerId: "me")
        XCTAssertEqual(model.corpus.projects.map(\.title), ["Demo", "Old editor"])
    }

    func testRootishFoldersAreOneNoProjectAndFoldIntoOlder() throws {
        let model = DrawerModel()
        var machines = try fleet(count: 3)
        machines[0].sessions[1].cwd = "/root"; machines[0].sessions[1].project = "root"
        machines[0].sessions[2].cwd = "/"; machines[0].sessions[2].project = nil
        model.update(machines: machines, runs: [], favorites: [], viewerId: "me", now: 10)
        let none = try XCTUnwrap(model.corpus.projects.first { $0.title == "Без проекта" })
        XCTAssertEqual(none.items.count, 2)
        XCTAssertNil(none.target)
        XCTAssertEqual(model.corpus.shelves.recent.map(\.title), ["Demo"])
        XCTAssertEqual(model.corpus.shelves.older.map(\.title), ["Без проекта"])
    }

    func testShelvesCapRecentFoldStaleAndHonourHidden() throws {
        let day = 86_400_000.0
        let now = 100 * day
        let sessions = (0..<12).map { i in
            ["sessionId": "s\(i)", "title": "T\(i)", "cwd": "/p/\(i)", "project": "p\(i)",
             "lastModified": now - Double(i) * day / 2] as [String: Any]
        } + [["sessionId": "stale", "title": "S", "cwd": "/p/stale", "project": "stale", "lastModified": now - 30 * day]]
        let data = try JSONSerialization.data(withJSONObject: [[
            "machine": ["machineId": "m", "name": "Mac", "os": "mac", "agentVersion": "1"],
            "online": true, "canControl": true, "canStart": true, "lastSeen": 1, "sessions": sessions]])
        let machines = try JSONDecoder().decode([MachineSnapshot].self, from: data)
        let waits = ActiveRunInfo(runId: "r", machineId: "m", sessionId: "stale", state: .needs_attention, since: 1, ownerUserId: "me")
        let model = DrawerModel()
        model.update(machines: machines, runs: [waits], favorites: [], viewerId: "me",
                     hiddenProjects: ["m::/p/0", "m::/p/stale"], now: now)
        let shelves = model.corpus.shelves
        // Hidden but waiting for you: still a card, and first.
        XCTAssertEqual(shelves.recent.first?.title, "stale")
        XCTAssertEqual(shelves.recent.filter { $0.urgency == 0 }.count, DrawerModel.recentMax)
        XCTAssertEqual(shelves.hidden.map(\.title), ["p0"])
        XCTAssertTrue(shelves.older.contains { $0.title == "p11" })
    }
}
