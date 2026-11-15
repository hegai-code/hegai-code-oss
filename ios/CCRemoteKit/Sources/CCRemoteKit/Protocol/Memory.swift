import Foundation

/// Where a memory lives (mirror `MemoryScope` in shared/src/protocol.ts).
public enum MemoryScope: String, Codable, Sendable {
    case fleet, machine, project
}

/// A memory file's identity and fingerprint, without its body (mirror
/// `MemoryEntry`). Bodies are fetched one at a time with `memory_read`.
public struct MemoryEntry: Codable, Hashable, Identifiable, Sendable {
    public let scope: MemoryScope
    /// `machineId` for `machine`, project root for `project`, `""` for `fleet`.
    public let scopeKey: String
    /// Path relative to the memory directory, e.g. `ccremote-hub-host.md`.
    public let path: String
    public let sha256: String
    public let revision: Int
    public let updatedAt: Double
    /// Body size. zod `.default(0)` — old agents may omit it entirely, so the
    /// decode fills the default by hand instead of failing the whole list.
    public var bytes: Int
    /// Tombstone: deleted, must not be pushed back up. Same `.default(false)`.
    public var deleted: Bool

    public var id: String { "\(scope.rawValue):\(scopeKey):\(path)" }

    private enum CodingKeys: String, CodingKey {
        case scope, scopeKey, path, sha256, revision, updatedAt, bytes, deleted
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        scope = try c.decode(MemoryScope.self, forKey: .scope)
        scopeKey = try c.decode(String.self, forKey: .scopeKey)
        path = try c.decode(String.self, forKey: .path)
        sha256 = try c.decode(String.self, forKey: .sha256)
        revision = try c.decode(Int.self, forKey: .revision)
        updatedAt = try c.decode(Double.self, forKey: .updatedAt)
        bytes = try c.decodeIfPresent(Int.self, forKey: .bytes) ?? 0
        deleted = try c.decodeIfPresent(Bool.self, forKey: .deleted) ?? false
    }

    public init(scope: MemoryScope, scopeKey: String, path: String, sha256: String,
                revision: Int, updatedAt: Double, bytes: Int = 0, deleted: Bool = false) {
        self.scope = scope
        self.scopeKey = scopeKey
        self.path = path
        self.sha256 = sha256
        self.revision = revision
        self.updatedAt = updatedAt
        self.bytes = bytes
        self.deleted = deleted
    }
}
