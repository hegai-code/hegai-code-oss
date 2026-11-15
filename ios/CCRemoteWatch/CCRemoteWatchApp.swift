import SwiftUI
import UserNotifications
import WatchKit
import WidgetKit

@main
struct CCRemoteWatchApp: App {
    @WKApplicationDelegateAdaptor(WatchAppDelegate.self) private var delegate

    var body: some Scene {
        WindowGroup {
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("-watchFixtureInbox") {
                InboxView(store: WatchFixture.inboxStore())
            } else if ProcessInfo.processInfo.arguments.contains("-watchFixture") {
                NavigationStack { DetailView(store: WatchStore.shared,
                                             item: WatchFixture.detailItem(ProcessInfo.processInfo.arguments),
                                             fixture: WatchFixture.history) }
            } else {
                InboxView(store: WatchStore.shared)
            }
            #else
            InboxView(store: WatchStore.shared)
            #endif
        }
        // Long-look interfaces for the categories that carry content. A category
        // without a scene falls back to the system alert plus its action buttons.
        WKNotificationScene(controller: AskNotificationController.self, category: HegaiNotif.ask)
        WKNotificationScene(controller: PlanNotificationController.self, category: HegaiNotif.plan)
        WKNotificationScene(controller: DoneNotificationController.self, category: HegaiNotif.done)
    }
}

@MainActor
final class WatchAppDelegate: NSObject, WKApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(HegaiNotificationCategories.make())
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("-watchFixture") }) { return }
        #endif
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
        WatchStore.shared.start()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        WidgetCenter.shared.reloadAllTimelines()
        return [.banner, .list, .sound]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse) async {
        let content = response.notification.request.content
        // A plain tap opens that session here, on the watch.
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
            if let machine = content.userInfo["machineId"] as? String,
               let session = content.userInfo["sessionId"] as? String {
                // Refresh first: the destination looks the session up in the inbox.
                await WatchStore.shared.refresh()
                WatchStore.shared.openSessionKey = "\(machine)/\(session)"
            }
            return
        }
        let text = (response as? UNTextInputNotificationResponse)?.userText
        await WatchActions.handle(category: content.categoryIdentifier, actionId: response.actionIdentifier,
                                  userInfo: content.userInfo, text: text)
    }
}

#if DEBUG
enum WatchFixture {
    @MainActor static func inboxStore() -> WatchStore {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let idle = WatchInboxItem(runId: nil, machineId: "m", sessionId: "s2", title: "Разбор логов хаба за ночь",
            machine: "hub", state: "idle", sinceMs: nil, lastModifiedMs: now - 7_200_000, source: "claude",
            tool: nil, requestId: nil, questions: nil, plan: nil, lastText: nil)
        var work = item; work.runId = "r2"; work.sessionId = "s3"; work.state = "working"
        work.title = "Сборка iOS"; work.machine = "mini"; work.sinceMs = now - 300_000; work.questions = nil
        work.progress = WatchFixture.progress; work.contextPct = 62; work.startedMs = now - 300_000
        var done = idle; done.sessionId = "s4"; done.title = "Отчёт по выручке"
        done.replies = WatchFixture.replies; done.lastModifiedMs = now - 600_000
        var wait = item; wait.sinceMs = now - 120_000
        let store = WatchStore.shared
        store.debugSet(.ready(WatchInbox(waiting: 1, working: 1, items: [wait, work, done, idle])))
        return store
    }
    static let item = WatchInboxItem(runId: "r", machineId: "m", sessionId: "s", title: "Сайт: правка шапки",
        machine: "stage", state: "needs_attention", sinceMs: nil, lastModifiedMs: nil, source: "claude",
        tool: "AskUserQuestion", requestId: "q",
        questions: [WatchQuestion(key: "k", question: "Какой вариант?", options: ["Светлый", "Тёмный"], multiSelect: false)],
        plan: nil, lastText: nil)
    static let progress = WatchProgress(done: 3, total: 6, active: "Собираю watch-приложение на мини", steps: [
        WatchStep(text: "Разобраться в коде часов", status: "completed"),
        WatchStep(text: "Хаб: шаги плана в инбоксе", status: "completed"),
        WatchStep(text: "Убрать «Открыть на iPhone»", status: "completed"),
        WatchStep(text: "Собрать на мини", status: "in_progress"),
        WatchStep(text: "Ревью", status: "pending"),
        WatchStep(text: "TestFlight", status: "pending"),
    ])
    static let replies = [
        WatchReply(label: "Выкатывай", send: "Выкатывай в прод"),
        WatchReply(label: "Покажи цифры", send: "Покажи итоговые цифры по месяцам"),
        WatchReply(label: "Сравни с маем", send: "Сравни с маем"),
    ]
    /// `-watchFixture working|done`: the other two looks of the session screen.
    static func detailItem(_ args: [String]) -> WatchInboxItem {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        var it = item
        if args.contains("working") {
            it.state = "working"; it.questions = nil; it.tool = nil; it.requestId = nil
            it.title = "Часы: экран сессии"; it.progress = progress; it.contextPct = 84
            it.background = 2; it.startedMs = now - 754_000; it.sinceMs = now - 754_000
        } else if args.contains("done") {
            it.state = "idle"; it.questions = nil; it.tool = nil; it.requestId = nil
            it.title = "Отчёт по выручке"; it.sinceMs = now - 180_000
            it.summary = "Собрал отчёт за октябрь: выручка +12%, три канала дали 80%."
            it.replies = replies
        }
        return it
    }
    static let history = WatchHistory(items: [
        WatchHistoryItem(role: "user", text: "Поправь шапку на главной", ts: 1),
        WatchHistoryItem(role: "tool", text: "🔧 Read ×2, Edit", ts: 2),
        WatchHistoryItem(role: "assistant", text: "Готово: шапка стала компактнее, кнопка справа.", ts: 3),
        WatchHistoryItem(role: "user", text: "А тёмная тема?", ts: 4),
        WatchHistoryItem(role: "assistant", text: "Есть два варианта оформления.", ts: 5),
    ], more: true)
}
#endif
