import Observation
import CCRemoteKit

/// Derived shelf data belongs to the account-owned screen, not to each body
/// evaluation. Selection, typing and drawer gestures only read the result.
@MainActor @Observable
final class StartProjectModel {
    private(set) var projects: [ProjectTarget] = []
    private(set) var rebuilds = 0
    @ObservationIgnored private var previous: Input?

    private struct Input: Equatable {
        let machines: [MachineSnapshot]
        let viewerId: String?
        let runs: [ActiveRunInfo]
        let extra: [ExtraTarget]
    }

    func update(machines: [MachineSnapshot], viewerId: String?, runs: [ActiveRunInfo], extra: [ExtraTarget]) {
        let input = Input(machines: machines, viewerId: viewerId, runs: runs, extra: extra)
        guard input != previous else { return }
        previous = input
        rebuilds += 1
        #if DEBUG
        DrawerPerformanceProbe.shelfBuilds += 1
        #endif
        projects = ProjectShelf.targets(machines: machines, viewerId: viewerId, runs: runs, extra: extra)
    }
}
