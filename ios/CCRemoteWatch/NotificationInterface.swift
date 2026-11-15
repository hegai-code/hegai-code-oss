import SwiftUI
import UserNotifications
import WatchKit
import WidgetKit

/// What the long-look interface shows, filled from the delivered notification.
@MainActor
final class NotificationModel: ObservableObject {
    @Published var title = ""
    @Published var body = ""
    @Published var category = ""
    @Published var payload = PushPayload(userInfo: [:])
    @Published var status: Status = .idle

    enum Status: Equatable { case idle, sending, sent, failed(String) }
    /// Bumped by every `load`: a late result of an earlier notification's
    /// request must not overwrite the one now on screen.
    private var generation = 0

    func load(_ notification: UNNotification) {
        let content = notification.request.content
        title = content.title
        body = content.body
        category = content.categoryIdentifier
        payload = PushPayload(userInfo: content.userInfo)
        generation += 1
        status = .idle
        WidgetCenter.shared.reloadAllTimelines()
    }

    func send(_ body: PushActionBody) {
        // One request at a time: a second tap while one is in flight is dropped.
        guard status != .sending else { return }
        status = .sending
        let mine = generation
        Task {
            let result = await WatchActions.submit(body)
            guard mine == generation else { return }
            status = result == .ok ? .sent : .failed(result.message ?? "ошибка")
        }
    }

    func send(action: String, text: String? = nil, answers: [String: AnswerValue]? = nil) {
        if let act = payload.act, !act.isEmpty {
            send(PushActionBody(token: act, action: action, text: text, answers: answers))
        } else if let runId = payload.runId, !runId.isEmpty {
            // No `act`: the watch's own session (same route as the system actions).
            send(PushActionMapper.sessionBody(runId: runId, requestId: payload.requestId,
                                              action: action, text: text, answers: answers))
        } else {
            status = .failed("нет токена действия")
        }
    }
}

struct NotificationBodyView: View {
    @ObservedObject var model: NotificationModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(model.title).font(.footnote.weight(.semibold)).foregroundStyle(WatchTheme.ivory)
            if !model.body.isEmpty { Text(model.body).font(.footnote).foregroundStyle(WatchTheme.ivory) }
            switch model.status {
            case .sent:
                Label("Отправлено", systemImage: "checkmark").font(.footnote).foregroundStyle(WatchTheme.working)
            case .failed(let reason):
                Text("Не отправилось: \(reason)").font(.caption2).foregroundStyle(WatchTheme.ember)
                actions
            case .sending:
                ProgressView()
            case .idle:
                actions
            }
        }
    }

    @ViewBuilder private var actions: some View {
        switch model.category {
        case HegaiNotif.ask:
            // Several questions can't be answered by one tap; the «Ответить…»
            // action (dictation) covers them.
            if model.payload.questions.count == 1, let q = model.payload.questions.first {
                QuestionView(question: q) { answer in
                    model.send(action: "answer", answers: [q.key: answer])
                }
            }
        case HegaiNotif.plan:
            if let plan = model.payload.plan, !plan.isEmpty, plan != model.body {
                Text(plan).font(.caption2).foregroundStyle(WatchTheme.muted)
            }
            Button("Принять") { model.send(action: "plan_accept") }
                .buttonStyle(WatchButtonStyle(prominent: true))
        default:
            ForEach(model.payload.replies, id: \.self) { reply in
                Button(reply.label) { model.send(action: "reply", text: reply.send) }
                    .buttonStyle(WatchButtonStyle())
            }
        }
    }
}

/// The three long-look controllers share everything but their category.
class HegaiNotificationController: WKUserNotificationHostingController<NotificationBodyView> {
    private let model = NotificationModel()

    override var body: NotificationBodyView { NotificationBodyView(model: model) }

    override class var isInteractive: Bool { true }

    override func didReceive(_ notification: UNNotification) {
        model.load(notification)
    }

    /// Dictation suggestions for «Ответить…»: the question's options, or the
    /// reply chips' texts.
    override func suggestionsForResponseToAction(withIdentifier identifier: String,
                                                 for notification: UNNotification,
                                                 inputLanguage: String) -> [String] {
        let content = notification.request.content
        return PushPayload(userInfo: content.userInfo).suggestions(category: content.categoryIdentifier)
    }
}

final class AskNotificationController: HegaiNotificationController {}
final class PlanNotificationController: HegaiNotificationController {}
final class DoneNotificationController: HegaiNotificationController {}
