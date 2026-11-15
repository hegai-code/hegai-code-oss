import Foundation
import Network

/// Смена сети → немедленная проверка связи с хабом (09.10.2026).
///
/// Без этого переход Wi-Fi ↔ сотовая замечал только упавший пинг, до 25 с
/// спустя, и всё это время экран молча не обновлялся. Первое срабатывание
/// монитора — текущее состояние при старте, а не перемена; его пропускаем.
/// Пропажа сети передаётся сразу (клиент перестаёт долбить хаб до её возвращения).
/// Дальше — на каждом обновлении пути с рабочей сетью: смена одной Wi-Fi на
/// другую оставляет тот же тип интерфейса, и сравнение типов её пропускало
/// (ревью 09.10.2026). Проверка — один пинг; чаще раза в 2 с не зовём.
@MainActor
final class NetworkPathWatcher {
    private let monitor = NWPathMonitor()
    private var seenFirst = false
    private var lastCall = Date.distantPast
    private var lastSatisfied = true
    private var started = false

    func start(onChange: @escaping @MainActor (_ satisfied: Bool) -> Void) {
        guard !started else { return }
        started = true
        monitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            Task { @MainActor in
                guard let self else { return }
                guard self.seenFirst else {
                    self.seenFirst = true
                    self.lastSatisfied = satisfied
                    // Started without a route: the client must not hammer the hub.
                    if !satisfied { onChange(false) }
                    return
                }
                // Losing the route is reported at once (the client stops retrying
                // until it returns). Its return is never throttled: dropping a
                // satisfied event after an unsatisfied one would leave the client
                // believing it is offline (60 s retries) on a stable path that
                // sends no further updates. Only repeat satisfied updates are.
                guard satisfied else { self.lastSatisfied = false; onChange(false); return }
                let cameBack = !self.lastSatisfied
                self.lastSatisfied = true
                guard cameBack || Date().timeIntervalSince(self.lastCall) > 2 else { return }
                self.lastCall = Date()
                onChange(true)
            }
        }
        monitor.start(queue: DispatchQueue(label: "net.hegai.ccremote.path", qos: .utility))
    }
}
