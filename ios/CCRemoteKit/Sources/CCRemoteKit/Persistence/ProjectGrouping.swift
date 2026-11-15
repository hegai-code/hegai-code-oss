import Foundation

/// One session paired with the machine (server) it lives on. `client.machines`
/// keys sessions by machine; the project views key them by `project` across
/// machines, so each item carries its server identity for the row's label.
public struct SessionItem: Identifiable, Hashable {
    public let machineId: String
    public let machineName: String
    public let session: SessionSummary
    public var id: String { "\(machineId)::\(session.sessionId)" }

    public init(machineId: String, machineName: String, session: SessionSummary) {
        self.machineId = machineId
        self.machineName = machineName
        self.session = session
    }
}

/// Sessions across the fleet, newest-first.
///
/// `ProjectBucket` and `buckets(from:)` lived here until the phone stopped
/// having a list keyed by project. It has one list (the drawer, by time) and one
/// project surface (the start screen's shelf, which is keyed by `machine::cwd`
/// and answers «where will this run» — a different question from «what happened
/// in this repo»). A grouping nobody groups by is a second definition of
/// "project" waiting to disagree with `ProjectShelf`.
public enum ProjectGrouping {
    /// Personal navigation and warming share the same ownership rule as the drawer.
    public static func myItems(from machines: [MachineSnapshot], viewerId: String?,
                               runs: [ActiveRunInfo]) -> [SessionItem] {
        let machinesById = Dictionary(uniqueKeysWithValues: machines.map { ($0.machine.machineId, $0) })
        let runsById = Dictionary(runs.map { ("\($0.machineId)::\($0.sessionId)", $0) },
                                  uniquingKeysWith: { _, last in last })
        return allItems(from: machines).filter {
            $0.session.isMine(on: machinesById[$0.machineId], viewerId: viewerId, run: runsById[$0.id])
        }
    }

    /// Every session across all machines, newest-first.
    public static func allItems(from machines: [MachineSnapshot]) -> [SessionItem] {
        machines
            .flatMap { snap in
                snap.sessions.map {
                    SessionItem(machineId: snap.machine.machineId,
                                machineName: snap.machine.name,
                                session: $0)
                }
            }
            .sorted { $0.session.lastModified > $1.session.lastModified }
    }
}
