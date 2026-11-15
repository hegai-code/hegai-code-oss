package net.hegai.code

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import net.hegai.code.core.*
import kotlinx.serialization.encodeToString
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Private, encrypted, atomic account/workspace storage. Never Android backup. */
class PrivateCache(context: Context) {
    private val root = File(context.noBackupFilesDir, "conversations").apply { mkdirs() }
    private fun hash(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("hegai-conversations", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("hegai-conversations", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    @Synchronized fun read(scope: String): AccountCache? = runCatching {
        val bytes = AtomicFile(File(root, hash(scope))).readFully()
        require(bytes.size in 13..32_000_000)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        cipher.updateAAD(scope.toByteArray())
        wireJson.decodeFromString<AccountCache>(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size))))
    }.getOrNull()
    @Synchronized fun write(scope: String, value: AccountCache, current: () -> Boolean = { true }) {
        if (!current()) return
        val plain = wireJson.encodeToString(value).toByteArray()
        require(plain.size <= 30_000_000) { "Кэш слишком большой" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key()); cipher.updateAAD(scope.toByteArray())
        val file = AtomicFile(File(root, hash(scope)))
        val stream = file.startWrite()
        try { stream.write(cipher.iv); stream.write(cipher.doFinal(plain)); file.finishWrite(stream) }
        catch (e: Exception) { file.failWrite(stream); throw e }
    }
    @Synchronized fun remove(scope: String) { AtomicFile(File(root, hash(scope))).delete() }
    @Synchronized fun clear() { root.listFiles()?.forEach { it.delete() } }
}
