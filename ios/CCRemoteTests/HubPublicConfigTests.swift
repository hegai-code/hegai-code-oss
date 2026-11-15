import XCTest
import CCRemoteKit

/// Which sign-in the app draws for a hub, decided by `/api/public-config`.
/// The internal hub keeps Google / Apple / Telegram; a customer's hub gets
/// «Войти» and the hub's own page (`/native-signin`).
final class HubPublicConfigTests: XCTestCase {
    private func config(_ json: String) -> HubPublicConfig? {
        HubPublicConfig.decode(Data(json.utf8))
    }

    private let internalHub = """
    {"edition":"internal","brandName":"Hegai Code","publicUrl":"https://code.acme.test",
     "auth":{"local":false,"google":true,"telegram":true,"apple":true,"hegaiSso":false}}
    """
    private let externalHub = """
    {"edition":"external","brandName":"Acme Code","publicUrl":"https://code.acme.test",
     "auth":{"local":true,"google":false,"telegram":false,"apple":false,"hegaiSso":false,"oidc":{"name":"Acme SSO"}}}
    """

    func testTheInternalHubKeepsItsOwnButtons() {
        let c = config(internalHub)
        XCTAssertEqual(c?.edition, "internal")
        XCTAssertEqual(c?.usesHubSignInPage, false)
    }

    func testAnExternalHubUsesItsOwnPageEvenWithGoogleConfigured() {
        let c = config(externalHub)
        XCTAssertEqual(c?.brandName, "Acme Code")
        XCTAssertEqual(c?.auth.oidc?.name, "Acme SSO")
        XCTAssertEqual(c?.usesHubSignInPage, true)
        let withGoogle = config("""
        {"edition":"external","brandName":"A","auth":{"local":true,"google":true,"telegram":false,"apple":false,"hegaiSso":false}}
        """)
        XCTAssertEqual(withGoogle?.usesHubSignInPage, true)
    }

    func testAHubWithoutGoogleAndAppleButWithAPasswordOrOIDCUsesItsOwnPage() {
        let local = HubPublicConfig(edition: "internal", auth: .init(local: true))
        XCTAssertTrue(local.usesHubSignInPage)
        let oidc = HubPublicConfig(edition: "internal", auth: .init(oidc: .init(name: "SSO")))
        XCTAssertTrue(oidc.usesHubSignInPage)
        // nothing usable on the page: the usual buttons stay
        XCTAssertFalse(HubPublicConfig(edition: "internal", auth: .init(telegram: true)).usesHubSignInPage)
        XCTAssertFalse(HubPublicConfig(edition: "internal", auth: .init(local: true, google: true)).usesHubSignInPage)
        XCTAssertFalse(HubPublicConfig(edition: "internal", auth: .init(local: true, apple: true)).usesHubSignInPage)
    }

    func testAnAnswerThatIsNotAConfigDecidesNothing() {
        XCTAssertNil(config("<html>404</html>"))
        XCTAssertNil(config("{\"error\":\"not found\"}"))
        XCTAssertNil(config("{\"edition\":\"internal\"}"))
    }

    func testUrlsAreDerivedFromTheConfiguredHub() {
        XCTAssertEqual(HubPublicConfig.url(hubURL: "wss://code.acme.test/mobile/ui")?.absoluteString,
                       "https://code.acme.test/api/public-config")
        XCTAssertEqual(HubPublicConfig.url(hubURL: "ws://127.0.0.1:4319/ui")?.absoluteString,
                       "http://127.0.0.1:4319/api/public-config")
        XCTAssertEqual(HegaiAuth.hubSignInURL(hubURL: "wss://code.acme.test/mobile/ui")?.absoluteString,
                       "https://code.acme.test/native-signin?native=1")
        XCTAssertEqual(HegaiAuth.hubPageURL(hubURL: "wss://code.acme.test/mobile/ui", path: "/api/privacy").absoluteString,
                       "https://code.acme.test/api/privacy")
        XCTAssertEqual(HegaiAuth.hubPageURL(hubURL: "wss://code.acme.test/mobile/ui", path: "/api/support").absoluteString,
                       "https://code.acme.test/api/support")
        XCTAssertEqual(HegaiAuth.hubPageURL(hubURL: "", path: "/api/support").absoluteString,
                       "https://code.acme.test/api/support")
    }

    func testSameHubIgnoresThePathAndNothingElse() {
        XCTAssertTrue(HegaiAuth.sameHub("wss://code.acme.test/mobile/ui", "wss://CODE.acme.test/ui"))
        XCTAssertTrue(HegaiAuth.sameHub("wss://code.acme.test:443/ui", "wss://code.acme.test/ui"))
        XCTAssertFalse(HegaiAuth.sameHub("wss://code.acme.test/ui", "wss://code.acme.test/ui"))
        XCTAssertFalse(HegaiAuth.sameHub("wss://code.acme.test/ui", "wss://code.acme.test:8443/ui"))
        XCTAssertFalse(HegaiAuth.sameHub("wss://code.acme.test/ui", "ws://code.acme.test/ui"))
    }

    func testSavingAHubNeedsNoToken() {
        let plan = HubSwitchPlan.make(currentHub: "wss://code.acme.test/mobile/ui", currentToken: "",
                                      draftHub: "  hub.acme.io ", draftToken: "")
        XCTAssertEqual(plan, HubSwitchPlan(hub: "wss://hub.acme.io/mobile/ui", token: "", switching: true))
    }

    func testUnusableHubAddressesAreRefused() {
        for bad in ["", "   ", "wss://", "wss:///ui", "http://hub.acme.io", "ws://hub.acme.io/mobile/ui",
                    "wss://hub.acme.io/ui", "https://hub.acme.io/x", "https://hub.acme.io?a=1", "https://hub.acme.io/#f",
                    "https://u:p@hub.acme.io", "ftp://hub.acme.io", "hub acme.io", "hub.acme.io:99999"] {
            XCTAssertNil(HubSwitchPlan.make(currentHub: "", currentToken: "", draftHub: bad, draftToken: "t"), bad)
            XCTAssertNil(HubSwitchPlan.normalizedHub(bad), bad)
        }
    }

    func testSwitchingDropsTheInheritedToken() {
        let plan = HubSwitchPlan.make(currentHub: "wss://code.acme.test/mobile/ui", currentToken: "old",
                                      draftHub: "wss://hub.acme.io/mobile/ui", draftToken: " old ")
        XCTAssertEqual(plan?.token, "")
        XCTAssertEqual(plan?.switching, true)
    }

    func testSwitchingKeepsATokenTypedForTheNewHub() {
        let plan = HubSwitchPlan.make(currentHub: "wss://code.acme.test/mobile/ui", currentToken: "old",
                                      draftHub: "wss://hub.acme.io/mobile/ui", draftToken: "fresh")
        XCTAssertEqual(plan?.token, "fresh")
        XCTAssertEqual(plan?.switching, true)
    }

    func testSameHubKeepsTheToken() {
        let plan = HubSwitchPlan.make(currentHub: "wss://code.acme.test/mobile/ui", currentToken: "tok",
                                      draftHub: "https://CODE.acme.test", draftToken: "tok")
        XCTAssertEqual(plan?.token, "tok")
        XCTAssertEqual(plan?.switching, false)
    }

    func testNormalizedHubCanonicalForms() {
        let want = "wss://hub.acme.io/mobile/ui"
        for ok in ["hub.acme.io", "HUB.acme.io.", "https://hub.acme.io", "https://hub.acme.io/", "wss://hub.acme.io",
                   "wss://hub.acme.io/mobile/ui", "https://hub.acme.io:443", " https://hub.acme.io/mobile/ui/ "] {
            XCTAssertEqual(HubSwitchPlan.normalizedHub(ok), want, ok)
        }
        XCTAssertEqual(HubSwitchPlan.normalizedHub("hub.acme.io:8443"), "wss://hub.acme.io:8443/mobile/ui")
        XCTAssertEqual(HubSwitchPlan.normalizedHub("http://localhost:8080"), "ws://localhost:8080/mobile/ui")
        XCTAssertEqual(HubSwitchPlan.normalizedHub("ws://127.0.0.1:3000/mobile/ui"), "ws://127.0.0.1:3000/mobile/ui")
        XCTAssertEqual(HubSwitchPlan.label("wss://hub.acme.io:8443/mobile/ui"), "hub.acme.io:8443")
    }

    func testHealthBody() {
        XCTAssertTrue(HubSwitchPlan.isHealthy(Data(#"{"ok":true,"v":1}"#.utf8)))
        XCTAssertFalse(HubSwitchPlan.isHealthy(Data(#"{"ok":false}"#.utf8)))
        XCTAssertFalse(HubSwitchPlan.isHealthy(Data("<html>".utf8)))
    }
}
