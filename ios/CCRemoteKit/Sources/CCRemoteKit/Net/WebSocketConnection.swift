import Foundation

/// One replaceable connection. Callbacks belong to this instance, never to a
/// mutable "current socket" delegate. Tests can drive the same lifecycle without
/// opening a port or borrowing a production workspace.
@MainActor
protocol WebSocketConnection: AnyObject {
    func resume()
    func receive() async throws -> String
    func send(_ text: String, completion: @escaping @MainActor (Error?) -> Void)
    func ping(completion: @escaping @MainActor (Error?) -> Void)
    func cancel()
}

typealias SocketFactory = @MainActor (
    URL, @escaping @MainActor @Sendable () -> Void, @escaping @MainActor @Sendable (Int, String?) -> Void
) -> any WebSocketConnection

@MainActor
final class URLSessionSocket: WebSocketConnection {
    private let session: URLSession
    private let task: URLSessionWebSocketTask

    init(url: URL, didOpen: @escaping @MainActor @Sendable () -> Void,
         didClose: @escaping @MainActor @Sendable (Int, String?) -> Void) {
        let observer = SocketObserver(didOpen: didOpen, didClose: didClose)
        session = URLSession(configuration: .default, delegate: observer, delegateQueue: nil)
        task = session.webSocketTask(with: url)
        // A real transcript exceeds URLSession's 1 MiB default. Keep frame order
        // in the client's serial receive loop, and decode off the main actor.
        task.maximumMessageSize = 64 * 1024 * 1024
    }

    func resume() { task.resume() }

    func receive() async throws -> String {
        switch try await task.receive() {
        case .string(let text): return text
        case .data(let data):
            guard let text = String(data: data, encoding: .utf8) else {
                throw ClientError.rpc("invalid UTF-8 WebSocket frame")
            }
            return text
        @unknown default: throw ClientError.rpc("unsupported WebSocket frame")
        }
    }

    func send(_ text: String, completion: @escaping @MainActor (Error?) -> Void) {
        task.send(.string(text)) { error in Task { @MainActor in completion(error) } }
    }

    func ping(completion: @escaping @MainActor (Error?) -> Void) {
        task.sendPing { error in Task { @MainActor in completion(error) } }
    }

    func cancel() {
        task.cancel(with: .goingAway, reason: nil)
        session.invalidateAndCancel()
    }
}

private final class SocketObserver: NSObject, URLSessionWebSocketDelegate, Sendable {
    private let didOpen: @MainActor @Sendable () -> Void
    private let didClose: @MainActor @Sendable (Int, String?) -> Void

    init(didOpen: @escaping @MainActor @Sendable () -> Void,
         didClose: @escaping @MainActor @Sendable (Int, String?) -> Void) {
        self.didOpen = didOpen
        self.didClose = didClose
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        Task { @MainActor [didOpen] in didOpen() }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        let text = reason.flatMap { String(data: $0, encoding: .utf8) }
        Task { @MainActor [didClose] in didClose(closeCode.rawValue, text) }
    }
}
