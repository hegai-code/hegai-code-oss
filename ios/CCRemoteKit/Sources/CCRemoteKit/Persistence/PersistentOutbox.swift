import Foundation
import Observation

/// Owns durable messages and the exact ids currently in flight. CentralClient
/// decides when a destination is reachable; this object decides what may be
/// removed. An `opened` reply must never remove the next message after the user
/// deletes the first, and a write failure must never discard the draft.
@MainActor
@Observable
final class PersistentOutbox {
    private(set) var messages: [PendingMessage] = []
    private(set) var loadError: String?
    private let store: OfflineOutboxStore
    private var retired = false
    private var inputs: Set<UUID> = []
    private var verifiedOwner: PersistentOutbox?
    private struct Opening { let id: UUID; let at: Date }
    private var openings: [String: Opening] = [:]

    init(directory: URL) {
        store = OfflineOutboxStore(directory: directory)
        do { messages = try store.load() }
        catch { loadError = error.localizedDescription }
    }

    func append(_ message: PendingMessage) throws {
        if let verifiedOwner { try verifiedOwner.append(message); return }
        try commit(messages + [message])
    }

    /// Verification joins only this credential's queue to the identity just
    /// proved by the hub. UUID dedup makes retry safe if the second write fails.
    func transfer(to owner: PersistentOutbox) throws {
        guard owner !== self else { return }
        let ids = Set(owner.messages.map(\.id))
        try owner.commit((owner.messages + messages.filter { !ids.contains($0.id) })
            .sorted { $0.createdAt < $1.createdAt })
        try commit([])
        verifiedOwner = owner
    }

    func remove(_ id: UUID) throws {
        try commit(messages.filter { $0.id != id })
    }

    private func commit(_ next: [PendingMessage]) throws {
        guard !retired else { throw ClientError.connectionClosed }
        // Preserve an unreadable file for recovery instead of overwriting it
        // with an empty queue on the first send after a decoding failure.
        if let loadError { throw ClientError.rpc(loadError) }
        try store.save(next)
        messages = next
    }

    func beginInput(_ id: UUID) -> Bool { inputs.insert(id).inserted }

    func finishInput(_ id: UUID, delivered: Bool) throws {
        guard inputs.remove(id) != nil else { return }
        if delivered { try remove(id) }
    }

    func beginOpen(_ message: PendingMessage, now: Date = Date()) -> Bool {
        let key = Self.key(message.machineId, message.sessionId)
        if let opening = openings[key], now.timeIntervalSince(opening.at) < 60 { return false }
        openings[key] = Opening(id: message.id, at: now)
        return true
    }

    func isOpening(machine: String, session: String) -> Bool {
        openings[Self.key(machine, session)] != nil
    }

    func failOpen(machine: String, session: String) {
        openings[Self.key(machine, session)] = nil
    }

    func confirmOpen(machine: String, session: String) throws {
        let key = Self.key(machine, session)
        guard let opening = openings.removeValue(forKey: key) else { return }
        try remove(opening.id)
    }

    func connectionClosed() {
        inputs = []
        openings = [:]
    }

    func retire() {
        retired = true
        messages = []
        inputs = []
        openings = [:]
    }

    private static func key(_ machine: String, _ session: String) -> String {
        ClientStorage.digest([machine, session])
    }
}
