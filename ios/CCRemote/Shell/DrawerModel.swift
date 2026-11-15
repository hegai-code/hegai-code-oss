import Foundation
import Observation
import CCRemoteKit

/// Prepared project inventory retained across gestures. No history reads or I/O.
@MainActor @Observable
final class DrawerModel {
    struct Project: Identifiable {
        let id: String
        let title: String
        let items: [SessionItem]
        let activeCount: Int
        let machineName: String
        let cwd: String?
        let target: ProjectTarget?
        let unavailableReason: String?
        let unreadCompletions: Set<String>
        /// 2 = waits for you (decision or error), 1 = the agent is working,
        /// 0 = anything else — an open editor or an idle run included.
        let urgency: Int
        let lastModified: Double
        /// Newest `created` among its rows — the project's place in the list.
        let created: Double
        /// No project to speak of: `/`, `/root`, a home dir, or no cwd at all.
        let rootish: Bool
        /// Rows that are working or wait for you (anywhere in `items`).
        let urgentIds: Set<String>
        var urgentCount: Int { urgentIds.count }
        /// Urgent rows all, then the two newest calm ones (web parity since
        /// 30.09.2026 — four rows per card made the drawer a long canvas).
        /// Never hide an unread result behind the preview. Shown in list
        /// order (urgent rows lead it anyway).
        var preview: [SessionItem] {
            let calm = Set(items.lazy.filter { !urgentIds.contains($0.id) }.prefix(2).map(\.id))
            return items.filter {
                urgentIds.contains($0.id) || calm.contains($0.id) || unreadCompletions.contains($0.id)
            }
        }
    }

    /// Drawer shelves: fresh projects as cards, the rest folded, hidden apart.
    struct Shelves {
        var recent: [Project] = []
        var older: [Project] = []
        var hidden: [Project] = []
    }
    /// A project counts as recent when touched within a week, at most eight
    /// cards; urgent ones are cards regardless (web `arrangeProjects`).
    static let recentWindow: Double = 7 * 24 * 60 * 60 * 1000
    static let recentMax = 8

    static func arrange(_ projects: [Project], hidden: Set<String>, now: Double) -> Shelves {
        var out = Shelves()
        var calm = 0
        for p in projects {   // already urgency → creation ordered
            if p.urgency < 2, hidden.contains(p.id) { out.hidden.append(p); continue }
            if p.urgency > 0 { out.recent.append(p); continue }
            let fresh = now - p.lastModified < recentWindow
            if !p.rootish, fresh, calm < recentMax {
                out.recent.append(p); calm += 1
            } else {
                out.older.append(p)
            }
        }
        return out
    }
    enum Indicator: Equatable { case attention, completed }

    struct Corpus {
        var items: [SessionItem] = []
        var runs: [String: ActiveRunInfo] = [:]
        var projects: [Project] = []
        var shelves = Shelves()
        /// The same owned, visible corpus as the drawer, independent of search
        /// and project expansion. Read decisions remain blue in their row only.
        func indicator(unreadDecisions: Set<String>, unreadCompletions: [String: Double]) -> Indicator? {
            var hasCompletion = false
            for item in items {
                let mark = RunMark(item.session.activityState(run: runs[item.id]))
                if mark == .attention, unreadDecisions.contains(item.id) { return .attention }
                if mark == .none, unreadCompletions[item.id] != nil { hasCompletion = true }
            }
            return hasCompletion ? .completed : nil
        }

        /// Work in progress only, using the same ownership and status as drawer rows.
        var working: [SessionItem] { items.filter { $0.session.activityState(run: runs[$0.id]) == .working } }
    }
    private(set) var corpus = Corpus()
    private(set) var rebuilds = 0
    @ObservationIgnored private var previous: Input?
    @ObservationIgnored private var nextShelfExpiry = Double.infinity
    private struct Input: Equatable {
        let machines: [MachineSnapshot]
        let runs: [ActiveRunInfo]
        let favorites: Set<String>
        let viewerId: String?
        let unreadCompletions: [String: Double]
        let hiddenProjects: Set<String>
        let excludedSessions: Set<String>
    }

    func update(machines: [MachineSnapshot], runs: [ActiveRunInfo], favorites: Set<String>, viewerId: String?,
                unreadCompletions: [String: Double] = [:], hiddenProjects: Set<String> = [],
                excludedSessions: Set<String> = [],
                now: Double = Date().timeIntervalSince1970 * 1000) {
        let input = Input(machines: machines, runs: runs, favorites: favorites, viewerId: viewerId,
                          unreadCompletions: unreadCompletions, hiddenProjects: hiddenProjects,
                          excludedSessions: excludedSessions)
        guard input != previous else {
            if now >= nextShelfExpiry { refreshShelves(hidden: hiddenProjects, now: now) }
            return
        }
        previous = input
        rebuilds += 1
        var items = ProjectGrouping.allItems(from: machines)
        let machinesById = Dictionary(uniqueKeysWithValues: machines.map { ($0.machine.machineId, $0) })
        var seen = Set(items.map(\.id))
        // As on web, a newly started run stays visible before inventory catches up.
        for run in runs where !run.sessionId.isEmpty {
            let key = RunIndex.key(machineId: run.machineId, sessionId: run.sessionId)
            guard !seen.contains(key), !excludedSessions.contains(key), let machine = machines.first(where: {
                $0.machine.machineId == run.machineId
            }) else { continue }
            let session = SessionSummary(sessionId: run.sessionId, title: run.title ?? "",
                                         project: run.project, lastModified: run.since)
            items.append(SessionItem(machineId: run.machineId, machineName: machine.machine.name,
                                     session: session))
            seen.insert(key)
        }
        let index = RunIndex.build(runs)
        // Viewing a shared machine does not make its team's sessions ours.
        // A run knows its owner before the inventory does; retain that evidence
        // for both existing rows and provisional rows created above.
        items = items.filter { item in
            item.session.isMine(on: machinesById[item.machineId], viewerId: viewerId, run: index[item.id])
        }
        func active(_ item: SessionItem) -> Bool {
            item.session.isActive(run: index[item.id])
        }
        // Urgency, not «live» (30.09.2026, web parity): a VS Code window open
        // for a week used to lead the drawer and made the order look random.
        func urgency(_ item: SessionItem) -> Int {
            switch RunMark(item.session.activityState(run: index[item.id])) {
            case .attention, .error: return 2
            case .live: return 1
            default: return 0
            }
        }
        // 11.11.2026 (web/Android parity): waits-for-you, then working, then
        // by CREATION time — sorting by the last change made the drawer jump
        // on every message. Active rows and projects stay on top (Owner).
        func ordered(_ a: SessionItem, _ b: SessionItem) -> Bool {
            if urgency(a) != urgency(b) { return urgency(a) > urgency(b) }
            if Self.created(a) != Self.created(b) { return Self.created(a) > Self.created(b) }
            return a.id < b.id
        }
        // Identity is a machine + directory, never a display name. Unknown
        // directories stay separate and cannot silently start in another folder.
        func identity(_ item: SessionItem) -> String {
            // Every rootish folder of a machine is one «Без проекта».
            if let cwd = item.session.cwd, !cwd.isEmpty, ProjectShelf.isRootish(cwd) {
                return "\(item.machineId)::rootish"
            }
            if let cwd = item.session.cwd, !cwd.isEmpty {
                return ProjectShelf.key(machineId: item.machineId, cwd: cwd,
                                        os: machinesById[item.machineId]?.machine.os)
            }
            return "\(item.machineId)::unknown:\(Self.projectName(item.session))"
        }
        let groups = Dictionary(grouping: items, by: identity)
        let projects = groups.map { key, entries in
            let sorted = entries.sorted(by: ordered)
            let first = sorted[0]
            let rootish = key.hasSuffix("::rootish")
            let name = rootish ? "Без проекта" : Self.projectName(first.session)
            let live = sorted.filter(active).count
            let machine = machinesById[first.machineId]
            let cwd = rootish ? nil : first.session.cwd.flatMap { $0.isEmpty ? nil : $0 }
            let reason: String? = cwd == nil ? "Папка проекта неизвестна"
                : machine?.canStartHere != true ? "Нет доступа к запуску на этом сервере"
                : machine?.online != true ? "Сервер не в сети" : nil
            let target = cwd.map {
                ProjectTarget(machineId: first.machineId, machineName: first.machineName,
                              cwd: $0, label: name, lastModified: sorted.map(\.session.lastModified).max() ?? 0,
                              mine: true, live: live)
            }
            return Project(id: key, title: name, items: sorted, activeCount: live,
                           machineName: first.machineName, cwd: cwd,
                           target: reason == nil ? target : nil, unavailableReason: reason,
                           unreadCompletions: Set(sorted.map(\.id)).intersection(unreadCompletions.keys),
                           urgency: sorted.map(urgency).max() ?? 0,
                           lastModified: sorted.map(\.session.lastModified).max() ?? 0,
                           created: sorted.map(Self.created).max() ?? 0,
                           rootish: rootish, urgentIds: Set(sorted.filter { urgency($0) > 0 }.map(\.id)))
        }.sorted {
            if $0.urgency != $1.urgency { return $0.urgency > $1.urgency }
            if $0.created != $1.created { return $0.created > $1.created }
            return $0.id < $1.id
        }
        corpus = Corpus(items: items.sorted(by: ordered), runs: index, projects: projects)
        refreshShelves(hidden: hiddenProjects, now: now)
    }

    private func refreshShelves(hidden: Set<String>, now: Double) {
        corpus.shelves = Self.arrange(corpus.projects, hidden: hidden, now: now)
        nextShelfExpiry = corpus.shelves.recent.filter { $0.urgency == 0 }
            .map { $0.lastModified + Self.recentWindow }.min() ?? .infinity
    }

    /// When the session was started; a row without it (older agents, a run
    /// ahead of the inventory) falls back to its last change.
    static func created(_ item: SessionItem) -> Double {
        item.session.createdAt ?? item.session.lastModified
    }

    static func projectName(_ session: SessionSummary?) -> String {
        let name = session?.project?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !name.isEmpty { return name }
        if let cwd = session?.cwd,
           let folder = cwd.replacingOccurrences(of: "\\", with: "/").split(separator: "/").last {
            return String(folder)
        }
        return "Без проекта"
    }

    /// Full search results; the view mounts them lazily instead of capping data.
    func sessions(projectId: String? = nil, query: String,
                  title: (SessionItem) -> String = { $0.session.title }) -> [SessionItem] {
        let items = projectId.map { id in corpus.projects.first { $0.id == id }?.items ?? [] } ?? corpus.items
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return items }
        return items.filter {
            [Self.projectName($0.session), title($0), $0.session.title,
             $0.session.cwd ?? "", $0.session.gitBranch ?? "", $0.machineName]
                .contains { $0.localizedCaseInsensitiveContains(q) }
        }
    }
}
