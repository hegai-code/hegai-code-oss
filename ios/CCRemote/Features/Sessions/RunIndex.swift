import Foundation
import CCRemoteKit

/// Активные прогоны, разложенные по ключу «машина::сессия».
///
/// Существует ради одной арифметики. `CentralClient.runFor` — ЛИНЕЙНЫЙ поиск
/// по всем активным прогонам, и он совершенно уместен, когда спрашивают про
/// одну сессию. Список шторки спрашивает про каждую: на корпусе в 648 сессий
/// это 648 сканов на КАЖДУЮ отрисовку, и делались они не по разу — список
/// собирался из нескольких проходов, и каждый спрашивал заново.
///
/// Словарь строится один раз за отрисовку и отвечает за константу. Ключ —
/// та же строка, которой сессии уже адресуются в избранном, во Flow и в
/// `CC_OPEN`, поэтому нового понятия здесь не заводится.
enum RunIndex {
    static func key(machineId: String, sessionId: String) -> String {
        "\(machineId)::\(sessionId)"
    }

    static func build(_ runs: [ActiveRunInfo]) -> [String: ActiveRunInfo] {
        var out: [String: ActiveRunInfo] = [:]
        out.reserveCapacity(runs.count)
        for r in runs { out[key(machineId: r.machineId, sessionId: r.sessionId)] = r }
        return out
    }
}
