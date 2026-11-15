import Foundation

/// Short-lived connections for lock-screen decisions. Every attempt owns its
/// timeout and background assertion; signing out cancels all of them.
@MainActor
final class PushDecisionSender {
    private let factory: SocketFactory
    private let grace: BackgroundGrace
    private let timeout: Duration
    private var jobs: [UUID: Task<Void, Never>] = [:]
    private var sockets: [UUID: any WebSocketConnection] = [:]

    init(factory: @escaping SocketFactory, grace: BackgroundGrace, timeout: Duration = .seconds(10)) {
        self.factory = factory
        self.grace = grace
        self.timeout = timeout
    }

    func send(_ decision: ClientMessage, endpoint: String, token: String, workspace: String?,
              onError: @escaping (Error) -> Void) {
        guard !token.isEmpty, var components = URLComponents(string: endpoint),
              ["ws", "wss"].contains(components.scheme ?? ""), components.host != nil else { return }
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        if let workspace { components.queryItems?.append(URLQueryItem(name: "workspaceId", value: workspace)) }
        guard let url = components.url else { return }
        let id = UUID()
        let socket = factory(url, {}, { _, _ in })
        sockets[id] = socket
        let token = grace.begin("cc-approve")
        jobs[id] = Task { [weak self, grace, timeout] in
            let timer = Task {
                try? await Task.sleep(for: timeout)
                if !Task.isCancelled { socket.cancel() }
            }
            defer {
                timer.cancel()
                socket.cancel()
                if let token { grace.end(token) }
                self?.sockets[id] = nil
                self?.jobs[id] = nil
            }
            socket.resume()
            do {
                // A complete inbound frame establishes authentication/routing.
                // The transport shares the main client's 64 MiB frame ceiling.
                _ = try await socket.receive()
                try Task.checkCancellation()
                let text = String(decoding: try JSONEncoder().encode(decision), as: UTF8.self)
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    socket.send(text) { error in
                        if let error { continuation.resume(throwing: error) }
                        else { continuation.resume() }
                    }
                }
                // The wire has no decision acknowledgement. Preserve the existing
                // routing grace, bounded by the attempt's overall deadline.
                try await Task.sleep(for: .milliseconds(500))
            } catch {
                if !Task.isCancelled { onError(error) }
            }
        }
    }

    func cancelAll() {
        for job in jobs.values { job.cancel() }
        for socket in sockets.values { socket.cancel() }
        jobs = [:]
        sockets = [:]
    }
}
