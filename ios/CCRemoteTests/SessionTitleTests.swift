import XCTest
import SwiftUI
@testable import CCRemote

@MainActor
final class SessionTitleTests: XCTestCase {
    private func size(_ title: String, width: CGFloat, active: Bool = false) -> CGSize {
        let host = UIHostingController(rootView: SessionTitle(
            title: title, active: active, isCodex: false, availableWidth: width))
        return host.sizeThatFits(in: CGSize(width: width, height: 44))
    }

    func testTitleUsesNaturalWidthUntilItReachesTheSpaceBetweenControls() {
        for width: CGFloat in [375, 430] {
            let short = size("Иконка", width: width)
            let medium = size("Дизайн приложения", width: width)
            let long = size("Очень длинное название сессии с обсуждением интерфейса", width: width, active: true)
            XCTAssertLessThan(short.width, medium.width - 20)
            XCTAssertLessThanOrEqual(medium.width, width - 136)
            XCTAssertEqual(long.width, width - 136, accuracy: 1)
            XCTAssertEqual(long.height, 44, accuracy: 1)
        }
    }
}
