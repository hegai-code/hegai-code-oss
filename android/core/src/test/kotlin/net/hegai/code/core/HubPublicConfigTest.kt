package net.hegai.code.core

import org.junit.Assert.*
import org.junit.Test

/** Which sign-in the app draws for a hub, from `/api/public-config`. */
class HubPublicConfigTest {
    private val internalHub = """{"edition":"internal","brandName":"Hegai Code","publicUrl":"https://code.acme.test",
        "auth":{"local":false,"google":true,"telegram":true,"apple":true,"hegaiSso":false}}"""
    private val externalHub = """{"edition":"external","brandName":"Acme Code","publicUrl":"https://code.acme.test",
        "auth":{"local":true,"google":false,"telegram":false,"apple":false,"hegaiSso":false,"oidc":{"name":"Acme SSO"}}}"""

    @Test fun theInternalHubKeepsGoogleAndTelegram() {
        val config = HubPublicConfig.parse(internalHub)!!
        assertFalse(config.usesHubSignInPage)
        assertTrue(config.google && config.telegram)
    }

    @Test fun aCustomerHubUsesItsOwnPage() {
        val config = HubPublicConfig.parse(externalHub)!!
        assertEquals("Acme Code", config.brandName)
        assertEquals("Acme SSO", config.oidcName)
        assertTrue(config.usesHubSignInPage)
        // even if the customer also configured Google, the one page lists everything
        assertTrue(HubPublicConfig.parse(externalHub.replace("\"google\":false", "\"google\":true"))!!.usesHubSignInPage)
    }

    @Test fun anyHubWithoutGoogleButWithAPasswordOrOidcUsesItsOwnPage() {
        fun config(auth: String) = HubPublicConfig.parse("""{"edition":"internal","brandName":"x","auth":$auth}""")!!
        assertTrue(config("""{"local":true,"google":false,"apple":false}""").usesHubSignInPage)
        assertTrue(config("""{"oidc":{"name":"SSO"}}""").usesHubSignInPage)
        assertFalse(config("""{"telegram":true}""").usesHubSignInPage)
        assertFalse(config("""{"local":true,"google":true}""").usesHubSignInPage)
        assertTrue(config("""{"local":true,"apple":true}""").usesHubSignInPage) // Android has no Apple sign-in
    }

    @Test fun anAnswerThatIsNotAConfigDecidesNothing() {
        assertNull(HubPublicConfig.parse("<html>404</html>"))
        assertNull(HubPublicConfig.parse("""{"error":"not found"}"""))
        assertNull(HubPublicConfig.parse("""{"edition":"internal"}"""))
        assertNull(HubPublicConfig.parse(""))
    }

    @Test fun derivesItsUrlsFromTheBase() {
        assertEquals("https://hub.acme.io:8443/api/public-config", HubUrl.publicConfig("https://hub.acme.io:8443"))
        assertEquals("https://hub.acme.io/native-signin", HubUrl.nativeSignIn("https://hub.acme.io"))
    }

    @Test fun appleDoesNotCountOnAndroid() {
        val appleOnly = """{"edition":"internal","brandName":"Hegai Code","auth":{"local":true,"google":false,"telegram":false,"apple":true,"hegaiSso":false}}"""
        assertTrue(HubPublicConfig.parse(appleOnly)!!.usesHubSignInPage)
    }
}
