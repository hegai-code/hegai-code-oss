import Foundation

/// Owns the complete lifecycle of id-correlated async continuations: timeout,
/// successful settlement, reject-on-socket-drop, timer cancellation, and an
/// optional rejection cleanup hook. Main-actor isolation matches CentralClient.
@MainActor
public final class PendingRegistry<Value, Context> {
    private struct Entry {
        let context: Context
        let continuation: CheckedContinuation<Value, Error>
        let timeoutTask: Task<Void, Never>
        let onReject: (() -> Void)?
    }

    private var entries: [String: Entry] = [:]
    private let timeoutSeconds: TimeInterval

    public init(timeoutSeconds: TimeInterval = 30) {
        self.timeoutSeconds = timeoutSeconds
    }

    public var count: Int { entries.count }

    public func context(for id: String) -> Context? {
        entries[id]?.context
    }

    public func wait(
        id: String,
        context: Context,
        timeoutError: Error,
        startError: Error,
        onReject: (() -> Void)? = nil,
        start: () -> Bool
    ) async throws -> Value {
        try await withTaskCancellationHandler {
            if Task.isCancelled {
                onReject?()
                throw CancellationError()
            }
            return try await withCheckedThrowingContinuation { continuation in
                precondition(entries[id] == nil, "duplicate pending id: \(id)")
                let timeout = timeoutSeconds
                let timeoutTask = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(timeout))
                    guard !Task.isCancelled else { return }
                    self?.reject(id: id, error: timeoutError)
                }
                entries[id] = Entry(
                    context: context,
                    continuation: continuation,
                    timeoutTask: timeoutTask,
                    onReject: onReject
                )
                if !start() {
                    reject(id: id, error: startError)
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.reject(id: id, error: CancellationError()) }
        }
    }

    @discardableResult
    public func resolve(id: String, value: Value) -> Bool {
        guard let entry = take(id: id) else { return false }
        entry.continuation.resume(returning: value)
        return true
    }

    @discardableResult
    public func reject(id: String, error: Error) -> Bool {
        guard let entry = take(id: id) else { return false }
        entry.onReject?()
        entry.continuation.resume(throwing: error)
        return true
    }

    public func rejectAll(error: Error) {
        for id in Array(entries.keys) {
            reject(id: id, error: error)
        }
    }

    private func take(id: String) -> Entry? {
        guard let entry = entries.removeValue(forKey: id) else { return nil }
        entry.timeoutTask.cancel()
        return entry
    }
}
