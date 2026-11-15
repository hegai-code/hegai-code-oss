import Foundation

/// One serial writer per account. A late write retains its original destination.
final class FleetSnapshotStore: @unchecked Sendable {
    private var retired = false
    private let url: URL
    /// Кто смотрел этот снимок. Без него фильтр «мои сессии» прятал весь
    /// кэш до первого ответа хаба, и приложение открывалось пустым
    /// (09.10.2026). Отдельный файл: старый `FleetSnapshot.json` читается как был.
    private let viewerURL: URL
    private let queue = DispatchQueue(label: "net.hegai.ccremote.fleet-store", qos: .utility)

    init(directory: URL) {
        url = directory.appendingPathComponent("FleetSnapshot.json")
        viewerURL = directory.appendingPathComponent("FleetViewer.json")
    }

    private struct SavedViewer: Codable { let userId: String }

    func loadViewerId() -> String? {
        queue.sync {
            guard let data = try? Data(contentsOf: viewerURL) else { return nil }
            return (try? JSONDecoder().decode(SavedViewer.self, from: data))?.userId
        }
    }

    func load() -> [MachineSnapshot] {
        queue.sync {
            guard let data = try? Data(contentsOf: url),
                  var list = try? JSONDecoder().decode([MachineSnapshot].self, from: data) else { return [] }
            for i in list.indices {
                list[i].online = false
                // A persisted editor phase is not evidence of current work.
                for j in list[i].sessions.indices {
                    list[i].sessions[j].liveStatus = nil
                    list[i].sessions[j].livePid = nil
                    list[i].sessions[j].active = nil
                }
            }
            return list
        }
    }

    func save(_ machines: [MachineSnapshot], viewerId: String?) {
        queue.async { [self] in
            guard !retired else { return }
            guard let data = try? JSONEncoder().encode(machines) else { return }
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
            if let viewerId, let who = try? JSONEncoder().encode(SavedViewer(userId: viewerId)) {
                try? who.write(to: viewerURL, options: .atomic)
            }
        }
    }
    func retire() { queue.sync { retired = true } }

}
