import Foundation

/// Explicit native-app permission; scoped to the verified account's storage.
/// Bump the version when recipients or the purposes described to people change.
public struct AIDataConsent: Codable, Equatable, Sendable {
    public static let currentVersion = "2026-09-26"
    public let version: String
    public let acceptedAt: Date

    public static func load(directory: URL) -> AIDataConsent? {
        guard let data = try? Data(contentsOf: directory.appendingPathComponent("AIConsent.json")),
              let record = try? JSONDecoder().decode(Self.self, from: data),
              record.version == currentVersion else { return nil }
        return record
    }

    public static func save(directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let record = Self(version: currentVersion, acceptedAt: Date())
        try JSONEncoder().encode(record).write(to: directory.appendingPathComponent("AIConsent.json"), options: .atomic)
    }

    public static func remove(directory: URL) throws {
        let file = directory.appendingPathComponent("AIConsent.json")
        if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
    }
}

extension ClientMessage {
    /// Reading existing chats and stopping work remain possible without consent.
    var requiresAIDataConsent: Bool {
        switch self {
        case .open, .newSession, .takeover, .input, .compact, .enrichRequest, .toolDecision:
            return true
        default:
            return false
        }
    }
}
