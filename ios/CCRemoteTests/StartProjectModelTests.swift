import XCTest
@testable import CCRemote
@testable import CCRemoteKit

@MainActor
final class StartProjectModelTests: XCTestCase {
    private func fleet() throws -> [MachineSnapshot] {
        try JSONDecoder().decode([MachineSnapshot].self, from: Data(#"[{"machine":{"machineId":"m","name":"Mac","os":"mac","agentVersion":"1"},"canStart":true,"online":true,"lastSeen":1,"sessions":[{"sessionId":"s","title":"Chat","cwd":"/projects/demo","project":"Demo","lastModified":1}]}]"#.utf8))
    }

    func testReadsReuseShelfAndInputChangesInvalidateIt() throws {
        let model = StartProjectModel()
        var machines = try fleet()
        model.update(machines: machines, viewerId: "u", runs: [], extra: [])
        for _ in 0..<100 { XCTAssertEqual(model.projects.first?.label, "Demo") }
        model.update(machines: machines, viewerId: "u", runs: [], extra: [])
        XCTAssertEqual(model.rebuilds, 1)

        let extra = [ExtraTarget(machineId: "m", cwd: "/projects/new", label: "New")]
        model.update(machines: machines, viewerId: "u", runs: [], extra: extra)
        XCTAssertEqual(Set(model.projects.map(\.label)), ["Demo", "New"])
        let run = try JSONDecoder().decode(ActiveRunInfo.self, from: Data(#"{"runId":"r","machineId":"m","sessionId":"s","state":"working","since":1}"#.utf8))
        model.update(machines: machines, viewerId: "u", runs: [run], extra: extra)
        XCTAssertEqual(model.projects.first { $0.label == "Demo" }?.live, 1)
        machines[0].canStart = false
        model.update(machines: machines, viewerId: "u", runs: [run], extra: extra)
        XCTAssertTrue(model.projects.isEmpty)
        model.update(machines: [], viewerId: "another", runs: [], extra: [])
        XCTAssertTrue(model.projects.isEmpty)
        XCTAssertEqual(model.rebuilds, 5)
    }
}
