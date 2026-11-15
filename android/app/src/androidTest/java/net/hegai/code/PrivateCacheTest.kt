package net.hegai.code

import androidx.test.platform.app.InstrumentationRegistry
import net.hegai.code.core.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.security.MessageDigest
import java.util.UUID

class PrivateCacheTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    @Test fun notificationConsentIsAccountScopedAndRevocationTakesEffect() {
        val vault = SessionVault(context, "ai-consent")
        val before = vault.read()
        val user = "consent-test:${UUID.randomUUID()}"
        val key = MessageDigest.getInstance("SHA-256").digest(user.toByteArray()).joinToString("") { "%02x".format(it) }
        try {
            vault.clear()
            assertFalse(hasAIConsent(context, user))
            vault.write("{\"$key\":\"2026-09-26\"}")
            assertTrue(hasAIConsent(context, user))
            assertFalse(hasAIConsent(context, "$user:other"))
            vault.clear()
            assertFalse(hasAIConsent(context, user))
        } finally { if (before == null) vault.clear() else vault.write(before) }
    }
    private fun file(scope: String): File {
        val name = MessageDigest.getInstance("SHA-256").digest(scope.toByteArray()).joinToString("") { "%02x".format(it) }
        return File(context.noBackupFilesDir, "conversations/$name")
    }
    @Test fun cacheIsEncryptedBoundToScopeAndSurvivesNewInstance() {
        val a = "test:${UUID.randomUUID()}:a"; val b = "$a:b"
        val cache = PrivateCache(context)
        try {
            val value = AccountCache(drafts = mapOf("s" to "private-test-draft"), outgoing = Submission("s", "sent", "r", 1))
            cache.write(a, value)
            assertFalse(file(a).readBytes().toString(Charsets.ISO_8859_1).contains("private-test-draft"))
            assertEquals(value, PrivateCache(context).read(a))
            file(a).copyTo(file(b))
            assertNull(cache.read(b))
        } finally { cache.remove(a); cache.remove(b) }
    }
    @Test fun delayedStaleWriteCannotOverwriteDurableOutgoing() {
        val scope = "test:${UUID.randomUUID()}"
        val cache = PrivateCache(context)
        var revision = 1
        val old = AccountCache(drafts = mapOf("s" to "old"))
        val prepared = AccountCache(outgoing = Submission("s", "new send", "r", 1))
        try {
            val oldRevision = revision
            revision++
            cache.write(scope, prepared) { revision == 2 }
            cache.write(scope, old) { revision == oldRevision }
            assertEquals(prepared, cache.read(scope))
        } finally { cache.remove(scope) }
    }
    @Test fun corruptedCiphertextNeverRestoresPartialAccount() {
        val scope = "test:${UUID.randomUUID()}"; val cache = PrivateCache(context)
        try {
            cache.write(scope, AccountCache(drafts = mapOf("s" to "draft")))
            val bytes = file(scope).readBytes(); bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte()
            file(scope).writeBytes(bytes)
            assertNull(cache.read(scope))
        } finally { cache.remove(scope) }
    }
}
