import Foundation

/// Last observed settings, for display only. Never replayed as commands on
/// resume: the runtime (or another client) may have changed them in the meantime.
@MainActor
public final class SessionSettingsStore {
    private let file: URL?
    private var values: [String: RunSettingsInfo]

    public init(directory: URL? = nil) {
        file = directory?.appendingPathComponent("SessionSettings.json")
        values = file.flatMap { try? Data(contentsOf: $0) }
            .flatMap { try? JSONDecoder().decode([String: RunSettingsInfo].self, from: $0) } ?? [:]
    }

    public func settings(machineId: String, sessionId: String) -> RunSettingsInfo? {
        values[ClientStorage.digest([machineId, sessionId])]
    }

    public func remember(_ settings: RunSettingsInfo, machineId: String, sessionId: String) {
        guard !sessionId.isEmpty, settings.model != nil || settings.activeModel != nil else { return }
        let key = ClientStorage.digest([machineId, sessionId])
        guard values[key] != settings else { return }
        values[key] = settings
        guard let file else { return }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(values) { try? data.write(to: file, options: .atomic) }
    }
}
