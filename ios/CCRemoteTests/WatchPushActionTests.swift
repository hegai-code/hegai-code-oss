import XCTest
import UserNotifications
@testable import CCRemote

/// WATCH.md §3 / §5 / §6: the notification-action mapping, the push-action body,
/// the Live Activity ContentState JSON and the small Russian strings.
final class WatchPushActionTests: XCTestCase {
    private let act = "tok.en.jwt"
    private var info: [AnyHashable: Any] { ["act": act, "runId": "r1", "requestId": "q1"] }

    private func body(_ category: String, _ action: String, text: String? = nil,
                      info: [AnyHashable: Any]? = nil) -> PushActionBody? {
        PushActionMapper.tokenBody(category: category, actionId: action, userInfo: info ?? self.info, text: text)
    }

    func testActionMappingTable() {
        XCTAssertEqual(PushActionMapper.action(category: "TOOL_APPROVAL", actionId: "APPROVE_ALLOW"), "allow")
        XCTAssertEqual(PushActionMapper.action(category: "TOOL_APPROVAL", actionId: "APPROVE_DENY"), "deny")
        XCTAssertEqual(PushActionMapper.action(category: "HEGAI_ASK", actionId: "REPLY"), "answer")
        XCTAssertEqual(PushActionMapper.action(category: "HEGAI_PLAN", actionId: "REPLY"), "plan_revise")
        XCTAssertEqual(PushActionMapper.action(category: "HEGAI_PLAN", actionId: "PLAN_ACCEPT"), "plan_accept")
        XCTAssertEqual(PushActionMapper.action(category: "HEGAI_DONE", actionId: "REPLY"), "reply")
        XCTAssertEqual(PushActionMapper.action(category: "HEGAI_ERROR", actionId: "REPLY"), "reply")
        XCTAssertNil(PushActionMapper.action(category: "HEGAI_ASK", actionId: "PLAN_ACCEPT"))
        XCTAssertNil(PushActionMapper.action(category: "HEGAI_DONE", actionId: "com.apple.UNNotificationDefaultActionIdentifier"))
    }

    func testTokenBodyCarriesTokenAndText() {
        XCTAssertEqual(body("HEGAI_ASK", "REPLY", text: "  да  "),
                       PushActionBody(token: act, action: "answer", text: "да"))
        XCTAssertEqual(body("HEGAI_PLAN", "PLAN_ACCEPT"),
                       PushActionBody(token: act, action: "plan_accept"))
        // Plain decisions never carry text, even if the system hands some over.
        XCTAssertNil(body("TOOL_APPROVAL", "APPROVE_ALLOW", text: "x")?.text)
    }

    func testNoActNoTokenBody() {
        XCTAssertNil(body("HEGAI_ASK", "REPLY", text: "да", info: ["runId": "r1"]))
        XCTAssertNil(body("HEGAI_ASK", "REPLY", text: "да", info: ["act": ""]))
    }

    func testEmptyReplyIsDropped() {
        XCTAssertNil(body("HEGAI_DONE", "REPLY", text: "   "))
        XCTAssertNil(body("HEGAI_DONE", "REPLY", text: nil))
    }

    func testBodyJSONOmitsAbsentKeys() throws {
        let data = try JSONEncoder().encode(PushActionBody(token: act, action: "allow"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(json.keys), ["token", "action"])
    }

    func testSessionBodyWithAnswers() throws {
        let b = PushActionMapper.sessionBody(runId: "r1", requestId: "q1", action: "answer",
                                             answers: ["Какой?": .one("A"), "Теги": .many(["x", "y"])])
        let data = try JSONEncoder().encode(b)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["runId"] as? String, "r1")
        XCTAssertEqual(json["requestId"] as? String, "q1")
        XCTAssertNil(json["token"])
        let answers = try XCTUnwrap(json["answers"] as? [String: Any])
        XCTAssertEqual(answers["Какой?"] as? String, "A")
        XCTAssertEqual(answers["Теги"] as? [String], ["x", "y"])
        XCTAssertEqual(try JSONDecoder().decode(PushActionBody.self, from: data), b)
    }

    func testFailureTexts() {
        XCTAssertEqual(PushActionMapper.failureText(status: nil, serverError: nil), "нет связи с хабом")
        XCTAssertEqual(PushActionMapper.failureText(status: 409, serverError: "stale"), "вопрос уже не актуален")
        XCTAssertEqual(PushActionMapper.failureText(status: 409, serverError: "used"), "уже отправлено")
        XCTAssertEqual(PushActionMapper.failureText(status: 503, serverError: "machine_offline"), "Машина офлайн")
        XCTAssertEqual(PushActionMapper.failureText(status: 500, serverError: nil), "ошибка хаба (500)")
    }

    func testCategoriesFollowSection6() {
        let specs = HegaiNotificationCategories.specs
        XCTAssertEqual(specs.map(\.id), ["TOOL_APPROVAL", "HEGAI_ASK", "HEGAI_PLAN", "HEGAI_DONE", "HEGAI_ERROR"])
        XCTAssertEqual(specs[0].actions.map(\.title), ["Запретить", "Разрешить"])
        XCTAssertEqual(specs[2].actions.map(\.id), ["REPLY", "PLAN_ACCEPT"])
        XCTAssertEqual(specs[2].actions[1].kind, .authenticated)
        // The double-tap action (first) is never an acceptance.
        for spec in specs {
            XCTAssertFalse(["APPROVE_ALLOW", "PLAN_ACCEPT"].contains(spec.actions[0].id), spec.id)
        }
        let built = HegaiNotificationCategories.make()
        XCTAssertEqual(Set(built.map(\.identifier)), Set(specs.map(\.id)))
        let plan = built.first { $0.identifier == "HEGAI_PLAN" }
        XCTAssertTrue(plan?.actions.first is UNTextInputNotificationAction)
    }

    func testPushPayloadParsing() {
        let p = PushPayload(userInfo: [
            "act": "a", "runId": "r", "state": "needs_attention",
            "ask": ["questions": [["key": "Что?", "question": "Что?", "options": ["A", "B"], "multiSelect": true]]],
            "replies": [["label": "Дальше", "send": "продолжай"]],
        ])
        XCTAssertEqual(p.questions.first?.options, ["A", "B"])
        XCTAssertEqual(p.questions.first?.multiSelect, true)
        XCTAssertEqual(p.replies, [WatchReply(label: "Дальше", send: "продолжай")])
        XCTAssertEqual(p.suggestions(category: "HEGAI_ASK"), ["A", "B"])
        XCTAssertEqual(p.suggestions(category: "HEGAI_DONE"), ["продолжай"])
        XCTAssertEqual(p.suggestions(category: "HEGAI_PLAN"), [])
        XCTAssertTrue(PushPayload(userInfo: [:]).questions.isEmpty)
    }

    func testInboxDecoding() throws {
        let json = """
        {"waiting":1,"working":2,"items":[{"runId":"r","machineId":"m","sessionId":"s","title":"T","machine":"stage",
        "state":"needs_attention","sinceMs":4000,"tool":"AskUserQuestion","requestId":"q",
        "questions":[{"question":"Как?","options":["a"]}],"lastText":"привет"}]}
        """
        let inbox = try JSONDecoder().decode(WatchInbox.self, from: Data(json.utf8))
        XCTAssertEqual(inbox.waiting, 1)
        XCTAssertTrue(inbox.items[0].isWaiting)
        // `key` falls back to the question text; multiSelect defaults to false.
        XCTAssertEqual(inbox.items[0].questions?[0].key, "Как?")
        XCTAssertEqual(inbox.items[0].questions?[0].multiSelect, false)
    }

    func testIdleInboxItemWithoutRunId() throws {
        let json = """
        {"waiting":0,"working":0,"items":[{"machineId":"m","sessionId":"s","title":"Старое","machine":"stage",
        "state":"idle","lastModifiedMs":1000,"source":"codex"},
        {"runId":"r","machineId":"m","sessionId":"s2","title":"Живое","machine":"stage","state":"working","sinceMs":5}]}
        """
        let inbox = try JSONDecoder().decode(WatchInbox.self, from: Data(json.utf8))
        XCTAssertNil(inbox.items[0].runId)
        XCTAssertEqual(inbox.items[0].id, "m/s")
        XCTAssertEqual(inbox.items[0].activityMs, 1000)
        XCTAssertEqual(inbox.items[0].engine, "codex")
        XCTAssertFalse(inbox.items[0].isWaiting)
        XCTAssertEqual(inbox.items[1].id, "r")
        XCTAssertEqual(inbox.items[1].engine, "claude")
        let groups = WatchInboxSection.group(inbox.items)
        XCTAssertEqual(groups.map(\.0), [.working, .recent])
        // Old hub: none of the 09.11.2026 keys.
        XCTAssertNil(inbox.items[1].progress)
        XCTAssertNil(inbox.items[0].replies)
    }

    /// WATCH.md §4, since 09.11.2026: plan, context, background, digest.
    func testInboxProgressAndDigestDecoding() throws {
        let json = """
        {"waiting":0,"working":1,"items":[
        {"runId":"r","machineId":"m","sessionId":"s","title":"Т","machine":"stage","state":"working","sinceMs":5,
         "startedMs":3,"contextPct":62,"background":2,
         "progress":{"done":3,"total":7,"active":"Собираю","steps":[{"text":"Раз","status":"completed"},
                                                                    {"text":"Два","status":"in_progress"}]}},
        {"machineId":"m","sessionId":"s2","title":"И","machine":"stage","state":"idle","lastModifiedMs":9,
         "summary":"Сделал","replies":[{"label":"Дальше","send":"Делай дальше"}]}]}
        """
        let inbox = try JSONDecoder().decode(WatchInbox.self, from: Data(json.utf8))
        let working = inbox.items[0]
        XCTAssertEqual(working.progress?.done, 3)
        XCTAssertEqual(working.progress?.total, 7)
        XCTAssertEqual(working.progress?.active, "Собираю")
        XCTAssertEqual(working.progress?.steps?.map(\.status), ["completed", "in_progress"])
        XCTAssertEqual(working.progress?.fraction ?? 0, 3.0 / 7.0, accuracy: 0.0001)
        XCTAssertEqual(working.startedMs, 3)
        XCTAssertEqual(working.contextPct, 62)
        XCTAssertEqual(working.background, 2)
        XCTAssertEqual(inbox.items[1].summary, "Сделал")
        XCTAssertEqual(inbox.items[1].replies, [WatchReply(label: "Дальше", send: "Делай дальше")])
        XCTAssertEqual(WatchProgress(done: 5, total: 0, active: nil, steps: nil).fraction, 0)
    }

    func testRelativeTime() {
        let now = Date(timeIntervalSince1970: 100_000)
        XCTAssertEqual(FleetSummary.relative(ms: 100_000_000 - 30_000, now: now), "сейчас")
        XCTAssertEqual(FleetSummary.relative(ms: 100_000_000 - 300_000, now: now), "5 мин")
        XCTAssertEqual(FleetSummary.relative(ms: 100_000_000 - 7_300_000, now: now), "2 ч")
        XCTAssertNil(FleetSummary.relative(ms: nil, now: now))
    }

    func testHistoryDecoding() throws {
        let json = """
        {"items":[{"role":"user","text":"привет","ts":1},{"role":"assistant","text":"Здравствуй"},
        {"role":"tool","text":"🔧 Bash ×3, Edit"}],"more":true}
        """
        let h = try JSONDecoder().decode(WatchHistory.self, from: Data(json.utf8))
        XCTAssertEqual(h.items.map(\.role), ["user", "assistant", "tool"])
        XCTAssertEqual(h.items[0].ts, 1)
        XCTAssertNil(h.items[1].ts)
        XCTAssertTrue(h.more)
        let empty = try JSONDecoder().decode(WatchHistory.self, from: Data("{}".utf8))
        XCTAssertTrue(empty.items.isEmpty)
        XCTAssertFalse(empty.more)
    }

    func testSessionReplyBodyWithoutRunId() throws {
        let b = PushActionMapper.sessionReplyBody(machineId: "m", sessionId: "s", source: "codex", text: "да")
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(b)) as! [String: Any]
        XCTAssertEqual(json["action"] as? String, "reply")
        XCTAssertEqual(json["machineId"] as? String, "m")
        XCTAssertEqual(json["sessionId"] as? String, "s")
        XCTAssertEqual(json["source"] as? String, "codex")
        XCTAssertEqual(json["text"] as? String, "да")
        XCTAssertNil(json["runId"])
        XCTAssertNil(json["token"])
        XCTAssertEqual(PushActionMapper.failureText(status: 409, serverError: "busy"), "Сессия занята другим устройством")
        XCTAssertEqual(PushActionMapper.failureText(status: 503, serverError: nil), "Машина офлайн")
    }

    func testLiveActivityContentStateDecoding() throws {
        let json = """
        {"working":2,"waiting":1,"items":[{"title":"Сайт","state":"needs_attention","sinceMs":120000},
        {"title":"Бот","state":"working","sinceMs":5},{"title":"Сбой","state":"error","sinceMs":9}],"updatedMs":1767225600000}
        """
        let state = try JSONDecoder().decode(HegaiFleetAttributes.ContentState.self, from: Data(json.utf8))
        XCTAssertEqual(state.working, 2)
        XCTAssertEqual(state.waiting, 1)
        XCTAssertEqual(state.items.count, 3)
        XCTAssertEqual(state.items[2].state, "error")
        XCTAssertEqual(FleetSummary.stateLabel("error"), "ошибка")
        XCTAssertEqual(state.items[0].title, "Сайт")
        XCTAssertEqual(state.items[0].sinceMs, 120_000)
        XCTAssertEqual(state.updatedMs, 1_767_225_600_000)
    }

    func testLiveActivityRegistrationBodies() throws {
        XCTAssertEqual(LiveActivityRegistration.hex(Data([0x0A, 0xFF, 0x00])), "0aff00")
        let start = LiveActivityRegistration.start(token: Data([0xAB, 0xCD]))
        XCTAssertEqual(start, LiveActivityRegistration(kind: "start", token: "abcd", activityId: nil))
        let data = try JSONEncoder().encode(LiveActivityRegistration.ended(id: "A1"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["kind"] as? String, "ended")
        XCTAssertEqual(json["activityId"] as? String, "A1")
        XCTAssertNil(json["token"])
    }

    func testWatchHandOffPayload() {
        XCTAssertEqual(WatchLink.payload(hubBase: "https://code.acme.test", token: "s"),
                       ["hub": "https://code.acme.test", "token": "s"])
        XCTAssertEqual(WatchLink.payload(hubBase: "https://code.acme.test", token: ""), ["token": ""])
        XCTAssertEqual(WatchLink.payload(hubBase: nil, token: "s"), ["token": ""])
    }

    func testFleetSummaryRussian() {
        XCTAssertEqual(FleetSummary.line(waiting: 1, working: 3), "ждёт 1")
        XCTAssertEqual(FleetSummary.line(waiting: 2, working: 0), "ждут 2")
        XCTAssertEqual(FleetSummary.line(waiting: 11, working: 0), "ждут 11")
        XCTAssertEqual(FleetSummary.line(waiting: 0, working: 3), "работают 3")
        XCTAssertEqual(FleetSummary.staleLine, "нет обновлений")
        XCTAssertEqual(FleetSummary.line(waiting: 0, working: 21), "работает 21")
        XCTAssertEqual(FleetSummary.line(waiting: 0, working: 0), "тихо")
    }

    // MARK: review fixes

    func testEveryActionRequiresAuthenticationExceptDeny() {
        for category in HegaiNotificationCategories.make() {
            for action in category.actions {
                let auth = action.options.contains(.authenticationRequired)
                if action.options.contains(.destructive) {
                    XCTAssertFalse(auth, "\(category.identifier)/\(action.identifier)")
                } else {
                    XCTAssertTrue(auth, "\(category.identifier)/\(action.identifier)")
                }
                if action is UNTextInputNotificationAction { XCTAssertTrue(auth) }
            }
        }
    }

    func testFallbackReplyMapping() {
        let info: [AnyHashable: Any] = ["runId": "r1", "requestId": "q1"]
        typealias L = LocalNotifications
        XCTAssertEqual(L.fallbackReply(category: "HEGAI_ASK", userInfo: info, text: " да "),
                       .toolDecision(runId: "r1", requestId: "q1", message: "да"))
        XCTAssertEqual(L.fallbackReply(category: "HEGAI_PLAN", userInfo: info, text: "x"),
                       .toolDecision(runId: "r1", requestId: "q1", message: "x"))
        XCTAssertEqual(L.fallbackReply(category: "HEGAI_DONE", userInfo: info, text: "x"), .input(runId: "r1", text: "x"))
        XCTAssertEqual(L.fallbackReply(category: "HEGAI_ERROR", userInfo: ["runId": "r1"], text: "x"),
                       .input(runId: "r1", text: "x"))
        XCTAssertNil(L.fallbackReply(category: "HEGAI_ASK", userInfo: ["runId": "r1"], text: "x"))
        XCTAssertNil(L.fallbackReply(category: "HEGAI_ASK", userInfo: info, text: "  "))
        XCTAssertNil(L.fallbackReply(category: "TOOL_APPROVAL", userInfo: info, text: "x"))
    }

    func testWatchRouteWithoutAct() {
        let info: [AnyHashable: Any] = ["runId": "r1", "requestId": "q1"]
        func route(_ c: String, _ a: String, _ t: String? = nil, session: Bool, _ i: [AnyHashable: Any]? = nil) -> PushActionMapper.WatchRoute {
            PushActionMapper.watchRoute(category: c, actionId: a, userInfo: i ?? info, text: t, hasSession: session)
        }
        XCTAssertEqual(route("TOOL_APPROVAL", "APPROVE_DENY", session: true),
                       .session(PushActionMapper.sessionBody(runId: "r1", requestId: "q1", action: "deny")))
        XCTAssertEqual(route("HEGAI_ASK", "REPLY", "да", session: true),
                       .session(PushActionMapper.sessionBody(runId: "r1", requestId: "q1", action: "answer", text: "да")))
        XCTAssertEqual(route("HEGAI_ASK", "REPLY", "да", session: false), .useIPhone)
        XCTAssertEqual(route("HEGAI_ASK", "REPLY", " ", session: true), .ignore)
        XCTAssertEqual(route("HEGAI_ASK", "com.apple.UNNotificationDefaultActionIdentifier", session: true), .ignore)
        XCTAssertEqual(route("TOOL_APPROVAL", "APPROVE_ALLOW", session: true, ["requestId": "q"]), .useIPhone)
        XCTAssertEqual(route("HEGAI_DONE", "REPLY", "x", session: true, ["act": "t"]),
                       .token(PushActionBody(token: "t", action: "reply", text: "x")))
    }

    func testSignoutRegistrationBody() throws {
        let data = try JSONEncoder().encode(LiveActivityRegistration.signout(tokens: ["aa", "bb"]))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["kind"] as? String, "signout")
        XCTAssertEqual(json["tokens"] as? [String], ["aa", "bb"])
        XCTAssertNil(json["token"])
    }

    func testWatchTokenCacheReuse() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let at = now.addingTimeInterval(-3600)
        let fresh = WatchLink.record(hub: "https://h", watchToken: "TOK", phoneToken: "P1", at: at)
        XCTAssertEqual(WatchLink.reusable(cached: fresh, hub: "https://h", phoneToken: "P1", now: now), "TOK")
        XCTAssertNil(WatchLink.reusable(cached: fresh, hub: "https://other", phoneToken: "P1", now: now))
        // Another account on the same hub must not inherit the watch bearer.
        XCTAssertNil(WatchLink.reusable(cached: fresh, hub: "https://h", phoneToken: "P2", now: now))
        let old = WatchLink.record(hub: "https://h", watchToken: "TOK", phoneToken: "P1", at: now.addingTimeInterval(-90_000))
        XCTAssertNil(WatchLink.reusable(cached: old, hub: "https://h", phoneToken: "P1", now: now))
        XCTAssertNil(WatchLink.reusable(cached: nil, hub: "https://h", phoneToken: "P1", now: now))
        XCTAssertNil(WatchLink.reusable(cached: "garbage", hub: "https://h", phoneToken: "P1", now: now))
        XCTAssertNil(WatchLink.reusable(cached: "https://h\nTOK\n1800000000", hub: "https://h", phoneToken: "P1", now: now))
        XCTAssertEqual(WatchLink.parse(fresh)?.token, "TOK")
    }

    func testLiveActivityTokensMergedCapsAndDedupes() {
        var list: [String] = []
        for i in 0..<40 { list = LiveActivityTokens.merged(list, adding: "t\(i)") }
        XCTAssertEqual(list.count, 32)
        XCTAssertEqual(list.first, "t8")
        XCTAssertEqual(list.last, "t39")
        list = LiveActivityTokens.merged(list, adding: "t10")
        XCTAssertEqual(list.count, 32)
        XCTAssertEqual(list.last, "t10")
        XCTAssertEqual(list.filter { $0 == "t10" }.count, 1)
    }
}
