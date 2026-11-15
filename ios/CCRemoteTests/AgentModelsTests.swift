import XCTest
@testable import CCRemoteKit

final class AgentModelsTests: XCTestCase {
    private let native = [ModelInfoLite(id: "default"), ModelInfoLite(id: "sol"), ModelInfoLite(id: "astra")]
    private let go = [ModelInfoLite(id: "pool-go/kimi-k3", name: "kimi-k3 · Go"),
                      ModelInfoLite(id: "pool-go/glm-5.3", name: "glm-5.3 · Go")]
    private var all: [ModelInfoLite] { native + go }

    func testIsGoModel() {
        XCTAssertTrue(AgentModels.isGoModel("pool-go/glm-5.3"))
        XCTAssertFalse(AgentModels.isGoModel("sol"))
        XCTAssertFalse(AgentModels.isGoModel("default"))
        XCTAssertFalse(AgentModels.isGoModel(nil))
    }

    func testHasGoRows() {
        XCTAssertTrue(AgentModels.hasGoRows(all))
        XCTAssertFalse(AgentModels.hasGoRows(native))
        XCTAssertFalse(AgentModels.hasGoRows([]))
    }

    func testRowsSplitByAgent() {
        XCTAssertEqual(AgentModels.rows(all, for: "codex").map(\.id), ["default", "sol", "astra"])
        XCTAssertEqual(AgentModels.rows(all, for: "opencode").map(\.id), ["pool-go/kimi-k3", "pool-go/glm-5.3"])
        XCTAssertEqual(AgentModels.rows(native, for: "opencode").count, 0)
    }

    func testDefaultGoModelKeepsListedPick() {
        XCTAssertEqual(AgentModels.defaultGoModel(models: all, remembered: "pool-go/kimi-k3"), "pool-go/kimi-k3")
    }

    func testDefaultGoModelFallsBackToGlmThenFirst() {
        XCTAssertEqual(AgentModels.defaultGoModel(models: all, remembered: nil), "pool-go/glm-5.3")
        XCTAssertEqual(AgentModels.defaultGoModel(models: all, remembered: "sol"), "pool-go/glm-5.3")
        XCTAssertEqual(AgentModels.defaultGoModel(models: all, remembered: "pool-go/gone"), "pool-go/glm-5.3")
        let noGlm = [ModelInfoLite(id: "pool-go/kimi-k3"), ModelInfoLite(id: "pool-go/qwen")]
        XCTAssertEqual(AgentModels.defaultGoModel(models: native + noGlm, remembered: nil), "pool-go/kimi-k3")
        XCTAssertNil(AgentModels.defaultGoModel(models: native, remembered: nil))
    }
}
