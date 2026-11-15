import Foundation
import UserNotifications

// The wire half of docs/WATCH.md §3 and §6, shared by the iPhone app and the
// watch app (this directory is compiled into both). Foundation + UserNotifications
// only, and every decision is a pure function so the unit tests can pin it.

/// Category and action ids. The hub sets `category` in the APNs payload; the
/// phone and the watch register the same ids.
enum HegaiNotif {
    static let toolApproval = "TOOL_APPROVAL"
    static let ask = "HEGAI_ASK"
    static let plan = "HEGAI_PLAN"
    static let done = "HEGAI_DONE"
    static let error = "HEGAI_ERROR"

    static let allow = "APPROVE_ALLOW"
    static let deny = "APPROVE_DENY"
    static let reply = "REPLY"
    static let planAccept = "PLAN_ACCEPT"
}

/// One answer under a question key: a string, or a list for multi-select.
enum AnswerValue: Codable, Equatable {
    case one(String)
    case many([String])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { self = .one(s) }
        else { self = .many(try c.decode([String].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .one(let s): try c.encode(s)
        case .many(let a): try c.encode(a)
        }
    }
}

/// Body of `POST /api/push-action`. Token mode sets `token`; session mode (the
/// watch app, Bearer) sets `runId` / `requestId`. Absent keys are omitted.
struct PushActionBody: Codable, Equatable {
    var token: String?
    var runId: String?
    var requestId: String?
    /// Session reply without a live run (WATCH.md §4c): machineId + sessionId + source.
    var machineId: String?
    var sessionId: String?
    var source: String?
    var action: String
    var text: String?
    var answers: [String: AnswerValue]?
}

enum PushActionMapper {
    /// Actions that carry the user's typed text.
    static let textActions: Set<String> = ["answer", "plan_revise", "reply"]

    /// `category` + notification action id -> hub `action` (WATCH.md §6).
    static func action(category: String, actionId: String) -> String? {
        switch (category, actionId) {
        case (HegaiNotif.toolApproval, HegaiNotif.allow): return "allow"
        case (HegaiNotif.toolApproval, HegaiNotif.deny): return "deny"
        case (HegaiNotif.ask, HegaiNotif.reply): return "answer"
        case (HegaiNotif.plan, HegaiNotif.reply): return "plan_revise"
        case (HegaiNotif.plan, HegaiNotif.planAccept): return "plan_accept"
        case (HegaiNotif.done, HegaiNotif.reply), (HegaiNotif.error, HegaiNotif.reply): return "reply"
        default: return nil
        }
    }

    /// The token-mode request for a tapped notification action, or nil when the
    /// push has no `act`, the pair is unknown, or a text action came back empty.
    static func tokenBody(category: String, actionId: String,
                          userInfo: [AnyHashable: Any], text: String?) -> PushActionBody? {
        guard let act = userInfo["act"] as? String, !act.isEmpty,
              let action = action(category: category, actionId: actionId) else { return nil }
        if textActions.contains(action) {
            let trimmed = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return nil }
            return PushActionBody(token: act, action: action, text: trimmed)
        }
        return PushActionBody(token: act, action: action)
    }

    enum WatchRoute: Equatable {
        case ignore                        // default tap / dismiss / unknown / empty text
        case token(PushActionBody)         // push carries `act`
        case session(PushActionBody)       // no `act`, the watch has its own session
        case useIPhone                     // no `act`, no session: say «Ответьте с iPhone»
    }

    /// What the watch does with a tapped notification action (WATCH.md §6).
    static func watchRoute(category: String, actionId: String, userInfo: [AnyHashable: Any],
                           text: String?, hasSession: Bool) -> WatchRoute {
        guard let action = action(category: category, actionId: actionId) else { return .ignore }
        if let body = tokenBody(category: category, actionId: actionId, userInfo: userInfo, text: text) {
            return .token(body)
        }
        let trimmed = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if textActions.contains(action) && trimmed.isEmpty { return .ignore }
        guard hasSession, let runId = userInfo["runId"] as? String, !runId.isEmpty else { return .useIPhone }
        let requestId = userInfo["requestId"] as? String
        return .session(sessionBody(runId: runId, requestId: requestId, action: action,
                                    text: textActions.contains(action) ? trimmed : nil))
    }

    /// Session-mode request (watch app, `Authorization: Bearer`).
    static func sessionBody(runId: String, requestId: String?, action: String,
                            text: String? = nil, answers: [String: AnswerValue]? = nil) -> PushActionBody {
        PushActionBody(token: nil, runId: runId, requestId: requestId, action: action,
                       text: text, answers: answers)
    }

    /// `reply` to an idle session that has no live run (WATCH.md §4c).
    static func sessionReplyBody(machineId: String, sessionId: String, source: String,
                                 text: String) -> PushActionBody {
        PushActionBody(token: nil, runId: nil, requestId: nil, machineId: machineId,
                       sessionId: sessionId, source: source, action: "reply", text: text, answers: nil)
    }

    /// Human reason for a failed call, in Russian (WATCH.md §3 status table).
    static func failureText(status: Int?, serverError: String?) -> String {
        guard let status else { return "нет связи с хабом" }
        switch status {
        case 401: return "сессия истекла, войдите заново"
        case 403: return "нет доступа"
        case 404: return "сессия уже закрыта"
        case 409:
            if serverError == "busy" { return "Сессия занята другим устройством" }
            return serverError == "used" ? "уже отправлено" : "вопрос уже не актуален"
        case 503: return "Машина офлайн"
        case 400: return "неверный запрос"
        default: return "ошибка хаба (\(status))"
        }
    }
}

enum PushActionResult: Equatable {
    case ok
    case failed(status: Int?, error: String?)

    var message: String? {
        if case .failed(let status, let error) = self {
            return PushActionMapper.failureText(status: status, serverError: error)
        }
        return nil
    }
}

/// Plain URLSession client for `/api/push-action`. `base` is the hub's https origin.
struct PushActionClient {
    var base: URL
    var session: URLSession = .shared

    func send(_ body: PushActionBody, bearer: String? = nil) async -> PushActionResult {
        var request = URLRequest(url: base.appendingPathComponent("api/push-action"))
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let bearer, !bearer.isEmpty { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        do {
            request.httpBody = try JSONEncoder().encode(body)
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { return .failed(status: nil, error: nil) }
            if (200..<300).contains(http.statusCode) { return .ok }
            struct ErrorBody: Decodable { let error: String? }
            let err = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
            return .failed(status: http.statusCode, error: err)
        } catch {
            return .failed(status: nil, error: nil)
        }
    }
}
