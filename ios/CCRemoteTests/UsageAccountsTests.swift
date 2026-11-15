import XCTest
@testable import CCRemoteKit

final class UsageAccountsTests: XCTestCase {
    func testGatewayKeepsActualPeriodsAndUniqueWindowIdentities() throws {
        let quota = try JSONDecoder().decode(GatewayQuota.self, from: Data(#"{"ok":true,"primary_used_percent":10,"primary_window_minutes":60,"secondary_used_percent":35,"secondary_window_minutes":300,"updated_at":100}"#.utf8))
        let usage = try XCTUnwrap(quota.asUsage)
        XCTAssertEqual(usage.normalizedLimits.map(\.label), ["1 ч", "5 часов"])
        XCTAssertEqual(Set(usage.normalizedLimits.map(\.id)).count, 2)
        XCTAssertEqual(usage.updatedAt, 100_000)
        XCTAssertEqual(GatewayQuota.windowLabel(20_160), "14 д")
        XCTAssertNil(try JSONDecoder().decode(GatewayQuota.self, from: Data(#"{"ok":true,"primary_window_minutes":300}"#.utf8)).asUsage)
    }

    func testAccountsDeduplicateNewestWithoutMixingProviders() throws {
        let json = #"{"type":"snapshot","machines":[{"machine":{"machineId":"a","name":"A","os":"mac","agentVersion":"1"},"online":true,"lastSeen":1,"sessions":[],"usage":{"account":"same","fiveHour":{"utilization":10},"updatedAt":1}},{"machine":{"machineId":"b","name":"B","os":"mac","agentVersion":"1"},"online":true,"lastSeen":1,"sessions":[],"usage":{"account":"same","limits":[{"key":"weekly","label":"Неделя","percent":92}],"updatedAt":2},"codexUsage":{"account":"same","fiveHour":{"utilization":35},"updatedAt":2}}]}"#
        guard case let .snapshot(machines, _, _, _) = try JSONDecoder().decode(HubMessage.self, from: Data(json.utf8)) else { return XCTFail() }
        let accounts = UsageAccount.collect(machines: machines, gateway: nil, budget: nil)
        XCTAssertEqual(accounts.count, 2)
        XCTAssertEqual(accounts[0].provider, "Claude")
        XCTAssertEqual(accounts[0].machines, ["A", "B"])
        XCTAssertEqual(accounts[0].peak, 92)
        XCTAssertEqual(accounts[1].peak, 35)
    }
    func testBudgetOnlyShowsKnownPersonalUsageAndConvertsReset() throws {
        func read(_ json: String) throws -> UsageInfo? {
            try JSONDecoder().decode(BudgetInfo.self, from: Data(json.utf8)).asUsage
        }
        XCTAssertNil(try read(#"{"plan":"community","limits":{}}"#))
        XCTAssertNil(try read(#"{"plan":"community","limits":{"tokens":100}}"#))
        XCTAssertNil(try read(#"{"plan":"employee","limits":{"tokens":100,"tokensUsed":20}}"#))
        let usage = try XCTUnwrap(read(#"{"plan":"community","limits":{"tokens":100,"tokensUsed":20,"tokensWindow":"1d","resetAt":1800000000,"requests":10,"requestsUsed":0,"requestsWindow":3600}}"#))
        XCTAssertEqual(usage.normalizedLimits.map(\.percent), [20, 0])
        XCTAssertEqual(usage.normalizedLimits.first?.resetsAt, 1800000000000)
        XCTAssertNil(usage.normalizedLimits.last?.resetsAt)
    }
}
