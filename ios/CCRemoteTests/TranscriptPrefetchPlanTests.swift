import XCTest
@testable import CCRemoteKit

final class TranscriptPrefetchPlanTests: XCTestCase {
    func testAutomaticCacheDoesNotSpendItsSlotsOnTeamSessions() throws {
        let data = Data(#"{"machine":{"machineId":"m","name":"Shared","os":"linux","agentVersion":"1"},"online":true,"lastSeen":1,"shared":true,"owner":{"userId":"me"},"sessions":[{"sessionId":"mine","title":"Mine","cwd":"/work/mine","lastModified":1,"owner":{"userId":"me"}},{"sessionId":"team","title":"Other","cwd":"/work/circle","lastModified":3,"owner":{"userId":"other"}},{"sessionId":"unknown","title":"Unknown","cwd":"/work/unknown","lastModified":2}]}"#.utf8)
        let machine = try JSONDecoder().decode(MachineSnapshot.self, from: data)
        XCTAssertEqual(TranscriptPrefetchPlan.candidates([machine], all: false, viewerId: "me").map(\.sessionId), ["mine"])
        XCTAssertEqual(TranscriptPrefetchPlan.candidates([machine], all: true, viewerId: "me").map(\.sessionId), ["mine"])
        XCTAssertEqual(ProjectGrouping.myItems(from: [machine], viewerId: "me", runs: []).map(\.id), ["m::mine"])
    }
    func testAutomaticWorkingSetIsBoundedNewestFirstAndManualCanFetchAll() throws {
        let sessions = (0..<1000).map { i in
            ["sessionId": "s\(i)", "title": "Chat", "cwd": "/projects/demo", "lastModified": i] as [String: Any]
        }
        let payload: [[String: Any]] = [[
            "machine": ["machineId": "m", "name": "Mac", "os": "mac", "agentVersion": "1"],
            "online": true, "lastSeen": 1, "sessions": sessions
        ]]
        var machines = try JSONDecoder().decode([MachineSnapshot].self, from: JSONSerialization.data(withJSONObject: payload))
        let automatic = TranscriptPrefetchPlan.candidates(machines, all: false)
        XCTAssertEqual(automatic.count, 24)
        XCTAssertEqual(automatic.first?.sessionId, "s999")
        XCTAssertEqual(automatic.last?.sessionId, "s976")
        XCTAssertEqual(TranscriptPrefetchPlan.candidates(machines, all: true).count, 1000)
        machines[0].online = false
        XCTAssertTrue(TranscriptPrefetchPlan.candidates(machines, all: true).isEmpty)
    }
    func testAutomaticSetSkipsSessionsMidTurnButManualKeepsThem() throws {
        let sessions = (0..<30).map { i in
            ["sessionId": "s\(i)", "title": "Chat", "cwd": "/projects/demo", "lastModified": i] as [String: Any]
        }
        let payload: [[String: Any]] = [[
            "machine": ["machineId": "m", "name": "Mac", "os": "mac", "agentVersion": "1"],
            "online": true, "lastSeen": 1, "sessions": sessions
        ]]
        let machines = try JSONDecoder().decode([MachineSnapshot].self, from: JSONSerialization.data(withJSONObject: payload))
        func run(_ id: String, _ state: String) throws -> ActiveRunInfo {
            let json = #"{"runId":"r-\#(id)","machineId":"m","sessionId":"\#(id)","state":"\#(state)","since":1}"#
            return try JSONDecoder().decode(ActiveRunInfo.self, from: Data(json.utf8))
        }
        let runs = [try run("s29", "working"), try run("s28", "needs_attention"), try run("s27", "idle")]
        let automatic = TranscriptPrefetchPlan.candidates(machines, all: false, runs: runs).map(\.sessionId)
        XCTAssertFalse(automatic.contains("s29"))
        XCTAssertFalse(automatic.contains("s28"))
        XCTAssertEqual(automatic.first, "s27", "an idle run does not move, so it still warms")
        XCTAssertEqual(automatic.count, 24, "skipped sessions free their slots instead of shrinking the set")
        let manual = TranscriptPrefetchPlan.candidates(machines, all: true, runs: runs).map(\.sessionId)
        XCTAssertEqual(manual.count, 30)
        XCTAssertTrue(manual.contains("s29"))
    }

    /// Ошибка чтения и stale-страница не кладут копию в кэш, поэтому не должны
    /// запускать 10 минут «качали только что» — иначе одна неудача гасит повтор.
    func testOnlyACurrentPageCountsAsFetched() {
        XCTAssertFalse(TranscriptPrefetchPlan.fetchedForReal(nil), "a failed read is not a fetch")
        XCTAssertFalse(TranscriptPrefetchPlan.fetchedForReal(HistoryPage(messages: [], stale: true)),
                       "a stale page was not cached")
        XCTAssertTrue(TranscriptPrefetchPlan.fetchedForReal(HistoryPage(messages: [], stale: false)))
    }
}
