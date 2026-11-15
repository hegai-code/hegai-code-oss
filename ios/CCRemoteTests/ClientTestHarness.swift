import XCTest
@testable import CCRemoteKit

@MainActor
final class TestSocket: WebSocketConnection {
    var sent: [String] = []
    var completions: [(@MainActor (Error?) -> Void)] = []
    var pongs: [(@MainActor (Error?) -> Void)] = []
    var cancelled = false
    var autoComplete = true
    private var frames: [String] = []
    private var receiver: CheckedContinuation<String, Error>?
    let didOpen: @MainActor () -> Void

    init(didOpen: @escaping @MainActor () -> Void = {}) { self.didOpen = didOpen }
    func resume() { didOpen() }
    func receive() async throws -> String {
        if !frames.isEmpty { return frames.removeFirst() }
        if cancelled { throw ClientError.connectionClosed }
        return try await withCheckedThrowingContinuation { receiver = $0 }
    }
    func feed(_ frame: String) {
        if let receiver { self.receiver = nil; receiver.resume(returning: frame) }
        else { frames.append(frame) }
    }
    func send(_ text: String, completion: @escaping @MainActor (Error?) -> Void) {
        sent.append(text)
        if autoComplete { Task { completion(nil) } }
        else { completions.append(completion) }
    }
    func ping(completion: @escaping @MainActor (Error?) -> Void) { pongs.append(completion) }
    func cancel() {
        cancelled = true
        receiver?.resume(throwing: ClientError.connectionClosed)
        receiver = nil
    }
    func frames(of type: String) -> [[String: Any]] {
        sent.compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
            .filter { $0["type"] as? String == type }
    }
}

@MainActor
final class ClientHarness {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    var sockets: [TestSocket] = []
    lazy var client = makeClient()
    let endpoint = "ws://test.invalid/ui"

    /// Never the real Keychain: a test must not read or leave this phone's keys.
    let keyRing = E2eeKeyRing(storage: InMemoryE2eeStorage())

    func makeClient(role: CentralClient.ClientRole = .primary,
                    decode: @escaping (String) async -> HubMessage? = CentralClient.decode) -> CentralClient {
        CentralClient(role: role, storageRoot: root, keyRing: keyRing, socketFactory: { [unowned self] _, opened, _ in
            let socket = TestSocket(didOpen: opened)
            self.sockets.append(socket)
            return socket
        }, decodeFrame: decode)
    }
    func connect(token: String = "alice", workspace: String? = nil) async {
        client.connect(endpoint: endpoint, token: token, workspaceId: workspace)
        sockets.last!.feed(#"{"type":"snapshot","machines":[],"activeRuns":[]}"#)
        await settle()
    }
    func clean() {
        client.disconnect()
        try? FileManager.default.removeItem(at: root)
    }
    func settle() async { for _ in 0..<20 { await Task.yield() } }
}
