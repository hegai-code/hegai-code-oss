import XCTest
@testable import CCRemote

/// Черновик принадлежит МЕСТУ, и место под ним меняется — на стартовом экране
/// это проект, который переключают прямо под набранным текстом.
///
/// Тесты на хранилище, а не на вьюху: правило целиком живёт в паре
/// `DraftStore` + `ComposerView.moveDraft`, и ломается оно тихо — текст просто
/// оказывается не там, где его набрали.
final class ComposerDraftTests: XCTestCase {
    private let a = "new::m::/a"
    private let b = "new::m::/b"

    override func setUp() {
        super.setUp()
        for k in [a, b, ""] { DraftStore.save(k, "") }
    }

    func testDraftsAreKeptPerPlace() {
        DraftStore.save(a, "текст A")
        DraftStore.save(b, "текст B")
        XCTAssertEqual(DraftStore.load(a), "текст A")
        XCTAssertEqual(DraftStore.load(b), "текст B")
    }

    /// Отправленное сообщение забирает свой слот с собой: иначе следующий заход
    /// в то же место открывается засеянным текстом уже отправленного хода.
    func testSendingClearsTheSlot() {
        DraftStore.save(a, "уехало")
        DraftStore.save(a, "")
        XCTAssertEqual(DraftStore.load(a), "")
    }

    /// Пробелы — это пусто. Слот из одних переводов строки ничем не лучше
    /// отсутствующего, а «восстановленный» из него черновик выглядит поломкой.
    func testWhitespaceOnlyIsNotADraft() {
        DraftStore.save(a, "   \n  ")
        XCTAssertEqual(DraftStore.load(a), "")
    }

    /// Пустой ключ — это «место ещё не известно» (стартовый экран до описи), а
    /// не место с пустым именем. Иначе черновики всех мест, у которых случился
    /// момент неизвестности, сложились бы в одну кучу под общим ключом.
    func testTheUnknownPlaceIsNotAPlace() {
        DraftStore.save("", "набрано до описи")
        XCTAssertEqual(DraftStore.load(""), "")
        XCTAssertEqual(UserDefaults.standard.string(forKey: "cc-draft::"), nil)
    }

    func testSameSessionDraftsAreIsolatedByAccount() {
        defer {
            DraftStore.save(a, "", scope: "alice")
            DraftStore.save(a, "", scope: "bob")
        }
        DraftStore.save(a, "private A", scope: "alice")
        XCTAssertEqual(DraftStore.load(a, scope: "bob"), "")
        DraftStore.save(a, "private B", scope: "bob")
        XCTAssertEqual(DraftStore.load(a, scope: "alice"), "private A")
        XCTAssertEqual(DraftStore.load(a, scope: "bob"), "private B")
    }
}
