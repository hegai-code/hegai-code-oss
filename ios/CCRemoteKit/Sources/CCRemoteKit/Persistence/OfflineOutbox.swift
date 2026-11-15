import Foundation

/// A message the user sent while the hub (or the session's machine) was
/// unreachable. It is not an error to send into a dead connection — the message
/// is kept here, on disk, and delivered the moment the connection returns.
///
/// This is deliberately NOT `QueuedMessage` (the legacy typed-while-busy chips):
/// that queue is in-memory machinery of a live run; this one survives app
/// restarts and machine reboots, because "I told the agent to do something from
/// the subway" must not depend on the socket staying up.
public struct PendingMessage: Codable, Identifiable, Equatable, Sendable {
    public let id: UUID
    public let machineId: String
    public let sessionId: String
    public var text: String
    public var images: [PendingImage]
    public let createdAt: Date

    public init(id: UUID = UUID(), machineId: String, sessionId: String,
         text: String, images: [PendingImage] = [], createdAt: Date = Date()) {
        self.id = id
        self.machineId = machineId
        self.sessionId = sessionId
        self.text = text
        self.images = images
        self.createdAt = createdAt
    }
}

/// An attachment inside a pending message — `ImageAttachment` with the bytes
/// made Codable so the queue can persist.
public struct PendingImage: Codable, Equatable, Sendable {
    public let mediaType: String
    public let dataBase64: String

    public init(_ attachment: ImageAttachment) {
        mediaType = attachment.mediaType
        dataBase64 = attachment.dataBase64
    }
    public var attachment: ImageAttachment? {
        guard let data = Data(base64Encoded: dataBase64) else { return nil }
        return ImageAttachment(mediaType: mediaType, data: data)
    }
}

/// A durable mutation completes before the UI forgets the draft. No detached
/// snapshots: a late enqueue must never resurrect a removed message. Errors
/// propagate so a failed write cannot look like an accepted message.
public final class OfflineOutboxStore {
    private let url: URL

    public init(directory: URL) {
        url = directory.appendingPathComponent("PendingMessages.json")
    }

    public func load() throws -> [PendingMessage] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        return try JSONDecoder().decode([PendingMessage].self, from: Data(contentsOf: url))
    }

    public func save(_ messages: [PendingMessage]) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(messages)
        try data.write(to: url, options: .atomic)
    }
}
