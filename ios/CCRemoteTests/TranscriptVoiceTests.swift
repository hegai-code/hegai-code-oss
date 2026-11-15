import XCTest
@testable import CCRemote
@testable import CCRemoteKit

/// Кто назван в колонке говорящего и что означает цвет машинной строки — две
/// вещи, которые ломаются молча: подпись видно только в длинном разговоре, а
/// цвет квадрата неотличим от «просто другого оттенка», пока не знаешь, что он
/// вообще что-то значит.
final class TranscriptVoiceTests: XCTestCase {

    /// `ViewerContext` собирается из JSON, а не мембервайзом: его инициализатор
    /// internal для своего модуля, и тест его не видит.
    ///
    /// `platformAdmin` и `workspaces` объявлены со значением по умолчанию — и
    /// это НЕ делает их необязательными для `Decodable`: синтезированный
    /// `init(from:)` всё равно требует ключ и падает `keyNotFound`. Первая
    /// версия этой фикстуры их не писала и валила три теста подряд на том, что
    /// выглядело как ошибка в разбираемом коде.
    private func viewer(fullName: String?, email: String) throws -> ViewerContext {
        let name = fullName.map { "\"fullName\":\"\($0)\"," } ?? ""
        let json = """
        {"userId":"u1","email":"\(email)",\(name)
         "platformAdmin":false,"workspaces":[],
         "workspace":{"workspaceId":"w1","name":"Hegai","kind":"organization","role":"owner"}}
        """
        return try JSONDecoder().decode(ViewerContext.self, from: Data(json.utf8))
    }

    // MARK: Имя человека

    /// Канон: имя человека — ЕГО СОБСТВЕННОЕ, первое слово из профиля. «Вы» в
    /// общем пространстве не называет никого: сессию видит и коллега.
    func testFirstWordOfFullName() throws {
        let v = try viewer(fullName: "Владелец Сергеев", email: "owner@x.test")
        XCTAssertEqual(SpeakerName.human(v), "Владелец")
    }

    func testSingleWordFullName() throws {
        XCTAssertEqual(SpeakerName.human(try viewer(fullName: "Владелец", email: "owner@x.test")), "Владелец")
    }

    /// Профиль без имени — локальная часть почты с заглавной. Не «Вы».
    func testFallsBackToEmailLocalPart() throws {
        let v = try viewer(fullName: nil, email: "owner@x.test")
        XCTAssertEqual(SpeakerName.human(v), "Owner")
        XCTAssertNotEqual(SpeakerName.human(v), "Вы")
    }

    /// Хаб ещё не прислал `viewer` — подпись всё равно не второе лицо.
    func testNoViewerIsStillNotSecondPerson() {
        XCTAssertEqual(SpeakerName.human(nil), SpeakerName.unknown)
        XCTAssertNotEqual(SpeakerName.human(nil), "Вы")
    }

    // MARK: Три смысловых цвета

    /// Читающие инструменты — зелёный: у вызова нет последствий.
    func testReadingToolsAreSafe() {
        for name in ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "Ls"] {
            XCTAssertEqual(ToolTone.of(name), .read, "\(name) ничего не меняет")
        }
    }

    /// Пишущие и запускающие — ember: у вызова есть последствия.
    func testWritingAndRunningToolsAreConsequential() {
        for name in ["Edit", "Write", "NotebookEdit", "Bash", "$", "KillShell", "Task", "Skill"] {
            XCTAssertEqual(ToolTone.of(name), .act, "\(name) меняет мир или запускает процесс")
        }
    }

    /// `TodoWrite` — `read`, несмотря на «Write» в имени: список задач живёт
    /// внутри хода. Классификация по ПОСЛЕДСТВИЮ, а не по слову в имени.
    func testTodoWriteIsNotConsequential() {
        XCTAssertEqual(ToolTone.of("TodoWrite"), .read)
        XCTAssertEqual(ToolTone.of("ExitPlanMode"), .read)
    }

    /// Незнакомый инструмент — БЕЗ тона. «Не знаю» и «безопасно» это разные
    /// утверждения: произвольный MCP-инструмент может делать что угодно, и
    /// зелёный квадрат на нём — обещание, которого никто не проверял.
    func testUnknownToolGetsNoTone() {
        XCTAssertNil(ToolTone.of("SomeNewMcpThing"))
    }

    // `testRunToneTakesTheStrongestAndDoesNotOverclaim` снят вместе с
    // `runTone`: свёрнутый прогон стал бесцветной шестерёнкой со счётчиком, как
    // в вебе, и красить в нём больше нечего. `ToolTone` и его тесты остались —
    // он работает на пилюлях ВНУТРИ раскрытого прогона.

    /// Классификатор — дословный порт `toolFamily()` из веба. Значения, на
    /// которых первый пересказ своими словами уже разошёлся.
    func testPortedVerbatimFromTheWeb() {
        XCTAssertEqual(ToolTone.of("BashOutput"), .act)
        XCTAssertEqual(ToolTone.of("Monitor"), .act)
        XCTAssertEqual(ToolTone.of("WebSearch"), .read)
    }

    /// Ровно три тона, и каждый несёт свою пару заливка/чернила. Тест держит
    /// именно СЧЁТ: шесть семейств вернутся ровно так — по одному.
    func testExactlyThreeTones() {
        let tones: [ToolTone] = [.read, .act, .fail]
        XCTAssertEqual(Set(tones.map { "\($0)" }).count, 3)
    }
}
