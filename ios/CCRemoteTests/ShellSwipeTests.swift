import XCTest
import CoreGraphics
@testable import CCRemote

/// Арифметика жеста шторки и правило «не красть у того, что едет вбок».
///
/// Числа перенесены из `web/src/shell/useSwipe.ts` дословно, и тест здесь
/// затем, чтобы они не «поехали» по чьему-нибудь вкусу: подобрать их заново
/// нечем — ни того корпуса сессий, ни тех рук у нас нет.
final class ShellSwipeTests: XCTestCase {

    // MARK: Порог

    func testAStraightLongDragIsASwipe() {
        XCTAssertTrue(ShellSwipe.isSwipe(dx: 120, dy: 10))
        XCTAssertTrue(ShellSwipe.isSwipe(dx: -120, dy: -10))
    }

    /// Короткая тяга — это не жест, а промах. Иначе шторка открывалась бы от
    /// любого касания с дрожью.
    func testTooShortIsNotASwipe() {
        XCTAssertFalse(ShellSwipe.isSwipe(dx: 63, dy: 0))
        XCTAssertTrue(ShellSwipe.isSwipe(dx: 64, dy: 0), "порог включающий")
    }

    /// Диагональный флик во время чтения обязан остаться прокруткой — и это
    /// ДВА независимых условия, а не одно.
    func testDiagonalStaysAScroll() {
        // Вертикали больше, чем прощается.
        XCTAssertFalse(ShellSwipe.isSwipe(dx: 100, dy: 45))
        // Вертикали прощается, но горизонталь не перевесила её вдвое.
        XCTAssertFalse(ShellSwipe.isSwipe(dx: 70, dy: 40))
        XCTAssertTrue(ShellSwipe.isSwipe(dx: 90, dy: 40))
    }

    func testThresholdsMatchTheWeb() {
        XCTAssertEqual(ShellSwipe.distance, 64, "DIST в useSwipe.ts")
        XCTAssertEqual(ShellSwipe.slop, 44, "SLOP в useSwipe.ts")
        XCTAssertEqual(ShellSwipe.straightness, 2, "|dx| < |dy| * 2 в useSwipe.ts")
    }

    // MARK: Интерактивная тяга — «чей жест» и «куда встать»

    /// На первом различимом сдвиге про расстояние ещё ничего не известно, и
    /// спрашивается поэтому ровно одно — прямизна.
    func testTheClaimIsDecidedByStraightnessAlone() {
        // Шесть точек вбок и ни одной вниз — наш, хотя до 64 ещё далеко.
        XCTAssertTrue(ShellSwipe.isHorizontal(dx: 6, dy: 0))
        XCTAssertTrue(ShellSwipe.isHorizontal(dx: -6, dy: 0))
        // Столько же вниз — прокрутка.
        XCTAssertFalse(ShellSwipe.isHorizontal(dx: 0, dy: 6))
        // По диагонали: горизонталь обязана перевесить вертикаль вдвое — тем же
        // отношением, что и в `isSwipe`.
        XCTAssertFalse(ShellSwipe.isHorizontal(dx: 7, dy: 4))
        XCTAssertTrue(ShellSwipe.isHorizontal(dx: 9, dy: 4))
    }

    /// `slop` сюда НЕ идёт, и это не забывчивость: 44 точки абсолютного допуска
    /// на жесте длиной шесть точек пропускают вообще всё, включая вертикаль.
    func testTheClaimDoesNotUseTheAbsoluteSlop() {
        XCTAssertFalse(ShellSwipe.isHorizontal(dx: 8, dy: 20),
                       "вертикаль перевесила — это прокрутка, сколько бы ни прощал slop")
    }

    /// Медленная тяга решается расстоянием — тем же, что и раньше.
    func testASlowDragSettlesByDistance() {
        XCTAssertTrue(ShellSwipe.settle(dx: 64, velocity: 0, wasOpen: false))
        XCTAssertFalse(ShellSwipe.settle(dx: 63, velocity: 0, wasOpen: false))
        // Из открытого — то же расстояние в обратную сторону.
        XCTAssertFalse(ShellSwipe.settle(dx: -64, velocity: 0, wasOpen: true))
        XCTAssertTrue(ShellSwipe.settle(dx: -63, velocity: 0, wasOpen: true))
    }

    /// Быстрый бросок решает САМ — иначе шторку нельзя открыть одной рукой.
    func testAFlickSettlesByVelocity() {
        XCTAssertTrue(ShellSwipe.settle(dx: 20, velocity: 900, wasOpen: false),
                      "бросок вправо открывает, не пройдя 64")
        XCTAssertFalse(ShellSwipe.settle(dx: -20, velocity: -900, wasOpen: true),
                       "бросок влево закрывает, не пройдя 64")
        // И наоборот: бросок ПРОТИВ пройденного расстояния перевешивает его.
        XCTAssertFalse(ShellSwipe.settle(dx: 200, velocity: -900, wasOpen: false),
                       "утащили далеко и швырнули обратно — шторка не открывается")
    }

    /// Отпущенное на полпути без скорости возвращается туда, откуда взяли, —
    /// а не остаётся висеть посередине.
    func testHalfwayWithoutVelocityGoesBack() {
        XCTAssertFalse(ShellSwipe.settle(dx: 30, velocity: 0, wasOpen: false))
        XCTAssertTrue(ShellSwipe.settle(dx: -30, velocity: 0, wasOpen: true))
    }

    // MARK: Что едет вбок само

    /// Самая заметная из возможных поломок: широкий код на телефоне читается
    /// только протаскиванием, и шторка, дёргающаяся на каждое протаскивание,
    /// делает его нечитаемым.
    func testADragStartedInsideASidewaysScrollerIsNotOurs() {
        let codeBlock = CGRect(x: 16, y: 220, width: 343, height: 96)
        XCTAssertTrue(SwipeGuard.blocks(CGPoint(x: 100, y: 260), in: [codeBlock]))
    }

    func testADragStartedBesideItIsOurs() {
        let codeBlock = CGRect(x: 16, y: 220, width: 343, height: 96)
        // Ниже блока — обычное полотно.
        XCTAssertFalse(SwipeGuard.blocks(CGPoint(x: 100, y: 400), in: [codeBlock]))
        // И выше него.
        XCTAssertFalse(SwipeGuard.blocks(CGPoint(x: 100, y: 180), in: [codeBlock]))
    }

    func testNothingRegisteredBlocksNothing() {
        XCTAssertFalse(SwipeGuard.blocks(CGPoint(x: 10, y: 10), in: []))
    }

    /// Транскрипт носит их пачками — код-блок, вывод инструмента, ряд чипов, —
    /// и достаточно попасть в ЛЮБОЙ.
    func testAnyOneOfManyIsEnough() {
        let rects = [
            CGRect(x: 0, y: 100, width: 375, height: 40),
            CGRect(x: 16, y: 300, width: 343, height: 96),
            CGRect(x: 0, y: 600, width: 375, height: 30),
        ]
        XCTAssertTrue(SwipeGuard.blocks(CGPoint(x: 200, y: 320), in: rects))
        XCTAssertFalse(SwipeGuard.blocks(CGPoint(x: 200, y: 500), in: rects))
    }
}
