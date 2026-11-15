import XCTest
@testable import CCRemoteKit

@MainActor
final class PersistentOutboxTests: XCTestCase {
    func testVerificationTransfersQueueAndLateRecoveryToVerifiedOwner() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let source = PersistentOutbox(directory: dir.appendingPathComponent("credential"))
        let owner = PersistentOutbox(directory: dir.appendingPathComponent("account"))
        let message = PendingMessage(machineId: "m", sessionId: "s", text: "queued")
        try source.append(message)
        try owner.append(message) // recovery after an interrupted transfer
        try source.transfer(to: owner)
        try source.append(PendingMessage(machineId: "m", sessionId: "s", text: "late failure"))
        XCTAssertEqual(owner.messages.map(\.text), ["queued", "late failure"])
        XCTAssertTrue(try OfflineOutboxStore(directory: dir.appendingPathComponent("credential")).load().isEmpty)
    }

    func testRemovalSurvivesImmediateReload() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let queue = PersistentOutbox(directory: dir)
        let a = PendingMessage(machineId: "m", sessionId: "s", text: String(repeating: "a", count: 100_000))
        let b = PendingMessage(machineId: "m", sessionId: "s", text: "b")
        try queue.append(a)
        try queue.append(b)
        try queue.remove(a.id)
        XCTAssertEqual(try OfflineOutboxStore(directory: dir).load().map(\.id), [b.id])
        try queue.remove(b.id)
        XCTAssertTrue(try OfflineOutboxStore(directory: dir).load().isEmpty)
    }

    func testLateOpenAckCannotDeleteTheNextMessage() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let queue = PersistentOutbox(directory: dir)
        let a = PendingMessage(machineId: "m", sessionId: "s", text: "first")
        let b = PendingMessage(machineId: "m", sessionId: "s", text: "second")
        try queue.append(a); try queue.append(b)
        XCTAssertTrue(queue.beginOpen(a))
        try queue.remove(a.id)
        XCTAssertFalse(queue.beginOpen(b))
        try queue.confirmOpen(machine: "m", session: "s")
        XCTAssertEqual(queue.messages.map(\.id), [b.id])
    }

    func testInputStaysDurableUntilCompletionAndRetriesOnDisconnect() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let queue = PersistentOutbox(directory: dir)
        let message = PendingMessage(machineId: "m", sessionId: "s", text: "first")
        try queue.append(message)
        XCTAssertTrue(queue.beginInput(message.id))
        XCTAssertFalse(queue.beginInput(message.id))
        XCTAssertEqual(try OfflineOutboxStore(directory: dir).load().count, 1)
        queue.connectionClosed()
        XCTAssertTrue(queue.beginInput(message.id))
        try queue.finishInput(message.id, delivered: false)
        XCTAssertEqual(queue.messages.count, 1)
        XCTAssertTrue(queue.beginInput(message.id))
        try queue.finishInput(message.id, delivered: true)
        XCTAssertTrue(try OfflineOutboxStore(directory: dir).load().isEmpty)
    }

    func testWriteFailureDoesNotAcceptMessage() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data("file, not a directory".utf8).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let queue = PersistentOutbox(directory: file)
        XCTAssertThrowsError(try queue.append(PendingMessage(machineId: "m", sessionId: "s", text: "keep draft")))
        XCTAssertTrue(queue.messages.isEmpty)
    }

    func testCorruptQueueIsPreservedForRecovery() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("PendingMessages.json")
        let bytes = Data("broken data".utf8)
        try bytes.write(to: file)
        let queue = PersistentOutbox(directory: dir)
        XCTAssertNotNil(queue.loadError)
        XCTAssertThrowsError(try queue.append(PendingMessage(machineId: "m", sessionId: "s", text: "new")))
        XCTAssertEqual(try Data(contentsOf: file), bytes)
    }
}
