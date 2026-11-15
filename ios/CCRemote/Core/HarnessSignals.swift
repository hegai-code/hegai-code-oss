import SwiftUI
import CCRemoteKit

/// DEBUG-only readiness beacon for `scripts/shoot.sh`.
///
/// The screenshot harness has to answer one question — "has this screen finished
/// becoming what it is going to be?" — and the first launch after an install is
/// exactly when that takes longest. Every way of guessing from the outside is
/// worse than it looks:
///
///   * a fixed `sleep` is either flaky or slow, and gets tuned until it is both;
///   * waiting for the screenshot to stop changing never settles, because the
///     design has live dots and running-session indicators that animate forever;
///   * scraping the unified log costs a `simctl spawn log show` per poll (seconds
///     each) and depends on log lines nobody promised to keep.
///
/// So the app states it plainly: the moment it reaches a state that will not
/// change on its own, it drops a small JSON file in its own container, and the
/// harness polls for that path.
///
/// **A settled screen is not the same as a connected one**, and the first cut of
/// this file got that wrong: it only fired once `machines` was non-empty, so a
/// sign-in screen, a rejected token and a connected-but-empty fleet were all
/// indistinguishable from "still loading". The harness then burned its whole
/// timeout and labelled a screen that had finished rendering seconds in as
/// `.notready` — blaming itself for a state the app had settled into long
/// before. Readiness is now a FACT with a name attached:
///
///   * `signin`     — no hub/token configured; onboarding is what is on screen
///   * `connected`  — socket open; carries the machine count (0 is legitimate)
///   * `offline`    — a connection attempt completed and failed (bad token,
///                    unreachable hub). It retries on a backoff, but the visible
///                    state stops changing, so it is photographable.
///
/// Whoever reads the screenshot gets told which of those it is instead of
/// guessing from pixels.
///
/// DEBUG only — this must never exist in a shipped build.
enum HarnessSignals {
    /// Filename inside the app container's Documents directory. `shoot.sh`
    /// resolves the container with `simctl get_app_container … data`.
    static let readyFilename = "harness-ready.json"

    #if DEBUG
    /// First settled state wins. The app keeps living after the beacon fires
    /// (a retry flips `offline`→`connected`), but the harness has already been
    /// told what it is looking at, and a beacon that rewrote itself would race
    /// the screenshot.
    private static var written = false

    static func settled(_ state: String, machines: Int? = nil, detail: String? = nil) {
        guard !written else { return }
        written = true
        var fields = ["\"state\":\"\(state)\""]
        if let machines { fields.append("\"machines\":\(machines)") }
        if let detail {
            // Keep the JSON well-formed whatever the error text contains.
            let safe = detail
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"")
                .replacingOccurrences(of: "\n", with: " ")
            fields.append("\"detail\":\"\(safe)\"")
        }
        let payload = "{\(fields.joined(separator: ","))}"
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        try? payload.write(to: dir.appendingPathComponent(readyFilename),
                           atomically: true, encoding: .utf8)
        print("[harness] settled \(payload)")
    }

    /// ВТОРОЙ факт, с отдельным именем и отдельным файлом.
    ///
    /// Полка стартового экрана строится из ДВУХ источников: описи сессий,
    /// которая приезжает вместе с флотом, и `projects.list` — кругового рейса
    /// до каждой управляемой машины. Основной маяк про второй источник не знает
    /// и знать не может: он гаснет на `connected`, то есть на секунды раньше.
    ///
    /// Чем это стоило. Кадр приёмки фазы 4 снимался ровно в это окно, и полка
    /// на нём была наполовину построена: пустые проекты (те самые, которых одна
    /// опись не видит, и ради которых второй источник и заведён) в кадр не
    /// попадали вовсе. Скриншот выглядел здоровым — просто с другим набором
    /// папок, и заметить это можно было только сравнив два прогона.
    ///
    /// Поэтому отдельный файл, а не поле в общем: у основного маяка правило
    /// «первый победил», и переписывать его значило бы гонку со скриншотом.
    ///
    /// `answered` — сколько из `asked` машин РЕАЛЬНО ответили. С фазы 6 полка
    /// публикуется по мере прихода ответов, поэтому «собралась» и «собралась
    /// целиком» — разные факты, и кадр, снятый при `answered < asked`, обязан
    /// называть это вслух, а не выглядеть полным.
    /// `silent` — кто именно не ответил. Молчащая коробка стоит 30 секунд
    /// таймаута RPC, и без имени её ищут заново каждую фазу.
    static func shelfSettled(projects: Int, asked: Int, answered: Int, silent: [String] = []) {
        guard !shelfWritten else { return }
        shelfWritten = true
        let names = silent.sorted().map { "\"\($0)\"" }.joined(separator: ",")
        let payload = "{\"shelf\":\"ready\",\"projects\":\(projects),\"asked\":\(asked)"
            + ",\"answered\":\(answered),\"silent\":[\(names)]}"
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        try? payload.write(to: dir.appendingPathComponent(shelfFilename),
                           atomically: true, encoding: .utf8)
        print("[harness] shelf \(payload)")
    }
    private static var shelfWritten = false
    #endif

    /// Имя файла второго маяка — полки стартового экрана.
    static let shelfFilename = "harness-shelf.json"
}

extension View {
    /// Fire the readiness beacon as soon as the screen reaches a state that will
    /// not change by itself. No-op in release builds.
    func harnessReadySignal(_ client: CentralClient, _ settings: AppSettings) -> some View {
        #if DEBUG
        return self
            // Not configured means onboarding is on screen and nothing is
            // pending — that is settled immediately, not a failure.
            .onChange(of: settings.isConfigured, initial: true) { _, configured in
                if !configured { HarnessSignals.settled("signin") }
            }
            .onChange(of: client.status, initial: true) { previous, current in
                switch current {
                case .open:
                    // An empty fleet is a real, settled answer — report the
                    // count rather than waiting for it to become non-zero,
                    // which is the bug this replaced.
                    HarnessSignals.settled("connected", machines: client.machines.count)
                case .closed:
                    // Only after an attempt actually completed. `initial: true`
                    // fires with previous == current == .closed before anything
                    // has been tried, and calling that "offline" would photograph
                    // the launch frame.
                    if previous == .connecting {
                        HarnessSignals.settled("offline", detail: client.lastError?.message)
                    }
                case .connecting:
                    break
                }
            }
        #else
        return self
        #endif
    }
}
