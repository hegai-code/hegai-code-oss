import Foundation

// Mirrors of the workspace REST payloads (web-protocol.ts). Roles stay plain
// strings — a new role value must degrade to "shown verbatim", not fail decode.

public struct MemberSummary: Codable, Hashable, Identifiable, Sendable {
    public let userId: String
    /// Absent for an account without an address (Telegram-only sign-in).
    /// Required here failed the whole members envelope for one such member.
    public let email: String?
    public var fullName: String?
    public var role: String
    public let joinedAt: Double
    public var id: String { userId }

    public var displayName: String { fullName ?? email ?? "Без имени" }
    public var isOwner: Bool { role == "owner" }
    public var isManager: Bool { role == "manager" }
    public var isMember: Bool { role == "member" }
}

public struct ProjectShare: Codable, Hashable, Identifiable, Sendable {
    public let projectShareId: String
    public let workspaceId: String
    public let machineId: String
    public let ownerUserId: String
    public let root: String
    public let name: String
    public let createdAt: Double
    /// 'view' (default) = read-only; 'control' = members may start and drive
    /// their own sessions inside this root. Absent = 'view' (older hubs).
    public var access: String?
    public var id: String { projectShareId }

    public var isControl: Bool { access == "control" }
}

public struct DeviceRecord: Codable, Hashable, Identifiable, Sendable {
    public let machineId: String
    public let ownerUserId: String
    public let name: String
    public let os: OsKind
    public let online: Bool
    public let lastSeen: Double
    public var revoked: Bool?
    public var agentVersion: String?
    public var id: String { machineId }
}

public struct AuditEvent: Codable, Hashable, Identifiable, Sendable {
    public let auditEventId: String
    public let workspaceId: String
    public let actorUserId: String
    public var actorName: String?
    public let action: String
    public let targetKind: String
    public let targetId: String
    public let createdAt: Double
    public var metadata: JSONValue?
    public var id: String { auditEventId }
}

public struct InvitationInfo: Codable, Hashable, Sendable {
    public let invitationId: String
    /// The secret the invite link carries (`origin/?invite=<token>`).
    public let token: String
    public let expiresAt: Double
}

public struct EnrollmentCode: Codable, Hashable, Sendable {
    public let code: String
    public let expiresAt: Double
}
