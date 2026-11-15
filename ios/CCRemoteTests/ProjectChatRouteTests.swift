import XCTest
@testable import CCRemote
import CCRemoteKit

@MainActor
final class ProjectChatRouteTests: XCTestCase {
    func testTargetedNewChatKeepsExactServerAndDirectoryAndClearsStack() {
        let router = Router()
        router.openSession(machineId: "first", sessionId: "old")
        router.openDrawer()
        let target = ProjectTarget(machineId: "second", machineName: "Server", cwd: "/other/demo",
                                   label: "Demo", lastModified: 0)
        router.newChat(in: target)
        XCTAssertEqual(router.newChatTarget, target)
        XCTAssertTrue(router.path.isEmpty)
        XCTAssertFalse(router.isDrawerOpen)
        router.newChat()
        XCTAssertNil(router.newChatTarget)
    }

    func testLogoHomePreservesProjectAndShareWithoutRequestingKeyboard() {
        let router = Router()
        let target = ProjectTarget(machineId: "m", machineName: "Mac", cwd: "/demo", label: "Demo", lastModified: 0)
        router.newChat(in: target)
        router.openSession(machineId: "m", sessionId: "s")
        router.openDrawer()
        router.home()
        XCTAssertEqual(router.newChatTarget, target)
        XCTAssertTrue(router.path.isEmpty)
        XCTAssertFalse(router.isDrawerOpen)
        XCTAssertFalse(router.focusesNewChat)
        router.newChat()
        XCTAssertTrue(router.focusesNewChat)
    }

    func testNewRunCarriesProjectBeforeSessionIDExists() {
        let router = Router()
        router.openNewRun(label: "First prompt", machineName: "Server", source: "codex", projectName: "Demo")
        guard case let .newRun(route) = router.path.last else { return XCTFail("Missing new run") }
        XCTAssertEqual(route.projectName, "Demo")
        XCTAssertEqual(route.machineName, "Server")
    }
}
