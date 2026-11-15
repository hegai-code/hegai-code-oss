import XCTest
import UIKit
@testable import CCRemote

/// Лого Claude/OpenAI в сборках TestFlight. Если ассета нет, `mark` молча
/// падает на свои знаки — без этого теста пропажа лого никем не заметна.
@MainActor
final class ProviderMarksTests: XCTestCase {
    /// The flag is set on the app target, not on this bundle, so ask the host
    /// app's Info.plist (it echoes `HEGAI_PROVIDER_MARKS`).
    func testDevAndTestFlightBuildsCompileTheMarksIn() {
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "HegaiProviderMarks") as? String,
                       "PROVIDER_MARKS", "PROVIDER_MARKS must be on outside STORE_BUILD")
    }

    func testProviderLogoAssetsShip() {
        XCTAssertNotNil(UIImage(named: "AgentClaude"))
        XCTAssertNotNil(UIImage(named: "AgentOpenAI"))
        XCTAssertNotNil(UIImage(named: "AgentOpenCode"))
    }

    func testRuntimeIconIsTheLogo() throws {
        for isCodex in [false, true] {
            let logo = try XCTUnwrap(UIImage(named: isCodex ? "AgentOpenAI" : "AgentClaude"))
            let box = CGSize(width: 17, height: 17)
            let expected = UIGraphicsImageRenderer(size: box).image { _ in
                logo.draw(in: CGRect(origin: .zero, size: box))
            }
            let got = SessionActivityIcon.mark(isCodex: isCodex, size: 17)
            XCTAssertEqual(got.pngData(), expected.withRenderingMode(.alwaysTemplate).pngData())
        }
    }
}
