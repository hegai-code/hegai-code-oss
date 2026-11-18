import XCTest
import CCRemoteKit

/// Server codes (QR / pasted / `ccremote://connect`) → the canonical hub address.
final class HubLinkTests: XCTestCase {
    private let acme = "wss://code.acme.com/mobile/ui"

    func testConnectLink() {
        XCTAssertEqual(HubLink.parse("ccremote://connect?hub=https%3A%2F%2Fcode.acme.com"), acme)
        XCTAssertEqual(HubLink.parse("ccremote://connect?hub=https://code.acme.com:8443"),
                       "wss://code.acme.com:8443/mobile/ui")
    }

    func testConnectLinkWithoutHubParamIsRejected() {
        XCTAssertNil(HubLink.parse("ccremote://connect"))
        XCTAssertNil(HubLink.parse("ccremote://connect?other=1"))
        XCTAssertNil(HubLink.parse("ccremote://connect?hub="))
    }

    func testOtherCcremoteHostsAreRejected() {
        XCTAssertNil(HubLink.parse("ccremote://auth?session=abc"))
        XCTAssertNil(HubLink.parse("ccremote://share"))
    }

    func testAppPageFromTheHubQr() {
        XCTAssertEqual(HubLink.parse("https://code.acme.com/app"), acme)
        XCTAssertEqual(HubLink.parse("https://code.acme.com/app/"), acme)
        XCTAssertEqual(HubLink.parse("code.acme.com/app"), acme)
    }

    func testBareHostAndOrigin() {
        XCTAssertEqual(HubLink.parse("code.acme.com"), acme)
        XCTAssertEqual(HubLink.parse("  https://code.acme.com/  "), acme)
        XCTAssertEqual(HubLink.parse("code.acme.com:8443"), "wss://code.acme.com:8443/mobile/ui")
    }

    func testLegacyWss() {
        XCTAssertEqual(HubLink.parse("wss://code.acme.com/mobile/ui"), acme)
    }

    func testGarbageIsRejected() {
        for bad in ["", "   ", "hello world", "https://", "https://code.acme.com/other", "https://u:p@code.acme.com",
                    "https://code.acme.com/app?x=1"] {
            XCTAssertNil(HubLink.parse(bad), bad)
        }
    }

    func testPlainHttpOnlyForLoopback() {
        XCTAssertNil(HubLink.parse("http://code.acme.com/app"))
        XCTAssertNil(HubLink.parse("ccremote://connect?hub=http%3A%2F%2Fcode.acme.com"))
        XCTAssertEqual(HubLink.parse("http://localhost:3000/app"), "ws://localhost:3000/mobile/ui")
    }

    func testOtherSchemesAreRejected() {
        for bad in ["javascript:alert(1)", "file:///etc/passwd", "mailto:a@b.com", "ftp://code.acme.com",
                    "data:text/html,hi"] {
            XCTAssertNil(HubLink.parse(bad), bad)
        }
    }

    func testConnectURLRoundTrips() {
        let url = HubLink.connectURL(hub: acme)
        XCTAssertEqual(url?.absoluteString, "ccremote://connect?hub=https%3A%2F%2Fcode.acme.com")
        XCTAssertEqual(HubLink.parse(url?.absoluteString ?? ""), acme)
        let port = HubLink.connectURL(hub: "wss://code.acme.com:8443/mobile/ui")
        XCTAssertEqual(HubLink.parse(port?.absoluteString ?? ""), "wss://code.acme.com:8443/mobile/ui")
    }
}
