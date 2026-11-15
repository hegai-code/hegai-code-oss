import Foundation

/// Workspace management over REST — the mirror of `web/src/teamApi.ts`.
/// Rides the `RestClient` that `CentralClient.connect()` already configured,
/// so a caller never owns a second, unconfigured HTTP client.
@MainActor
public final class TeamApi {
    private let rest: RestClient

    public init(rest: RestClient) {
        self.rest = rest
    }

    // MARK: Wire envelopes (the hub wraps lists in named fields)

    private struct MembersEnvelope: Decodable { let members: [MemberSummary] }
    private struct ProjectsEnvelope: Decodable { let projects: [ProjectShare] }
    private struct AuditEnvelope: Decodable { let events: [AuditEvent] }
    private struct DevicesEnvelope: Decodable { let devices: [DeviceRecord] }
    private struct AcceptedInvitation: Decodable { let workspaceId: String }

    // MARK: Members / roles / invitations

    public func members(workspaceId: String) async throws -> [MemberSummary] {
        try await rest.get("api/workspaces/\(workspaceId)/members", as: MembersEnvelope.self).members
    }

    public func invite(workspaceId: String, email: String, role: String) async throws -> InvitationInfo {
        struct Body: Encodable { let email: String; let role: String }
        return try await rest.post("api/workspaces/\(workspaceId)/invitations",
                                   body: Body(email: email, role: role), as: InvitationInfo.self)
    }

    public func acceptInvitation(token: String) async throws -> String {
        struct Body: Encodable { let token: String }
        return try await rest.post("api/invitations/accept",
                                   body: Body(token: token), as: AcceptedInvitation.self).workspaceId
    }

    public func setRole(workspaceId: String, userId: String, role: String) async throws {
        struct Body: Encodable { let role: String }
        try await rest.patch("api/workspaces/\(workspaceId)/members/\(userId)", body: Body(role: role))
    }

    /// Scope a manager onto a member or a project.
    public func assign(workspaceId: String, managerUserId: String,
                       targetKind: String, targetId: String) async throws {
        struct Body: Encodable { let managerUserId: String; let targetKind: String; let targetId: String }
        try await rest.post("api/workspaces/\(workspaceId)/assignments",
                            body: Body(managerUserId: managerUserId, targetKind: targetKind, targetId: targetId))
    }

    // MARK: Project shares

    public func projects(workspaceId: String) async throws -> [ProjectShare] {
        try await rest.get("api/workspaces/\(workspaceId)/projects", as: ProjectsEnvelope.self).projects
    }

    public func shareProject(workspaceId: String, machineId: String, root: String,
                             name: String, access: String = "view") async throws -> ProjectShare {
        struct Body: Encodable { let machineId: String; let root: String; let name: String; let access: String }
        return try await rest.post("api/workspaces/\(workspaceId)/projects",
                                   body: Body(machineId: machineId, root: root, name: name, access: access),
                                   as: ProjectShare.self)
    }

    public func removeProject(workspaceId: String, shareId: String) async throws {
        try await rest.delete("api/workspaces/\(workspaceId)/projects/\(shareId)")
    }

    // MARK: Audit

    public func audit(workspaceId: String) async throws -> [AuditEvent] {
        try await rest.get("api/workspaces/\(workspaceId)/audit", as: AuditEnvelope.self).events
    }

    // MARK: Enrollment / devices

    public func enrollment() async throws -> EnrollmentCode {
        try await rest.post("api/enrollments", body: RestClient.EmptyBody(), as: EnrollmentCode.self)
    }

    public func devices() async throws -> [DeviceRecord] {
        try await rest.get("api/devices", as: DevicesEnvelope.self).devices
    }

    public func revokeDevice(machineId: String) async throws {
        try await rest.delete("api/devices/\(machineId)")
    }

    public func restoreDevice(machineId: String) async throws {
        try await rest.post("api/devices/\(machineId)/restore", body: RestClient.EmptyBody())
    }

    // MARK: Admin

    public func createWorkspace(name: String, ownerUserId: String?) async throws -> WorkspaceSummary {
        struct Body: Encodable { let name: String; let ownerUserId: String? }
        return try await rest.post("api/admin/workspaces",
                                   body: Body(name: name, ownerUserId: ownerUserId),
                                   as: WorkspaceSummary.self)
    }
}
