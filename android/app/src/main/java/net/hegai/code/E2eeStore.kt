package net.hegai.code

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.*
import net.hegai.code.core.E2ee
import net.hegai.code.core.E2eeKeys
import net.hegai.code.core.RingKey
import net.hegai.code.core.wireJson
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The key ring for private machines (docs/E2EE.md): one 256-bit content key per pairing code.
 *
 * Each key is encrypted by an AES key that lives in the Android Keystore (never leaves it); only that ciphertext is
 * stored, in the app's no-backup directory (not in backups, not in device transfer), bound to its key id and machine
 * as AAD so entries cannot be swapped. The pairing code itself is imported once and never kept as text. The
 * unwrapped keys are held in memory for the life of the process (the cipher needs them): a rooted or debugged
 * device can read them, as it could any app's memory; the threat model is the hub, not the phone (docs/E2EE.md).
 */
class E2eeStore private constructor(context: Context) {
    class PairingException(message: String) : Exception(message)

    private class Entry(val kid: String, val machineId: String, val key: ByteArray, val addedAt: Long)

    private val file = AtomicFile(File(context.noBackupFilesDir, "e2ee-ring.json"))
    private val entries = LinkedHashMap<String, Entry>()
    /** Rows that did not unwrap this time (a Keystore hiccup): kept verbatim and written back, so one failure cannot erase a machine's key. */
    private val orphans = mutableListOf<JsonObject>()
    private val _machines = MutableStateFlow<Set<String>>(emptySet())
    /** Machine ids this device holds a key for; changes whenever a key is added or forgotten. */
    val machines: StateFlow<Set<String>> = _machines.asStateFlow()

    val keys: E2eeKeys = object : E2eeKeys {
        override fun forKid(kid: String): ByteArray? = synchronized(this@E2eeStore) { entries[kid]?.key }
        override fun latestFor(machineId: String): RingKey? = synchronized(this@E2eeStore) {
            entries.values.filter { it.machineId == machineId }.maxByOrNull { it.addedAt }?.let { RingKey(it.kid, it.key) }
        }
        override fun hasAny(): Boolean = synchronized(this@E2eeStore) { entries.isNotEmpty() }
    }

    init { synchronized(this) { load(); publish() } }

    private fun wrapKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
        }.generateKey()
    }
    private fun aad(kid: String, machineId: String) = "e2ee-ring|$kid|$machineId".toByteArray(Charsets.UTF_8)

    private fun wrap(entry: Entry): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, wrapKey())
        cipher.updateAAD(aad(entry.kid, entry.machineId))
        return Base64.encodeToString(cipher.iv + cipher.doFinal(entry.key), Base64.NO_WRAP)
    }
    private fun unwrap(kid: String, machineId: String, sealed: String): ByteArray {
        val bytes = Base64.decode(sealed, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, wrapKey(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        cipher.updateAAD(aad(kid, machineId))
        return cipher.doFinal(bytes.copyOfRange(12, bytes.size))
    }

    private fun load() {
        val rows = runCatching { wireJson.parseToJsonElement(String(file.readFully(), Charsets.UTF_8)).jsonObject["keys"] as? JsonArray }.getOrNull() ?: return
        for (row in rows) {
            val ok = runCatching {
                val o = row.jsonObject
                val kid = o["kid"]!!.jsonPrimitive.content; val machineId = o["machineId"]!!.jsonPrimitive.content
                val key = unwrap(kid, machineId, o["sealed"]!!.jsonPrimitive.content)
                // An entry whose key does not hash to its id is damaged: never used (but kept as it was).
                if (key.size == 32 && E2ee.keyId(key) == kid) { entries[kid] = Entry(kid, machineId, key, o["addedAt"]?.jsonPrimitive?.longOrNull ?: 0L); true } else false
            }.getOrDefault(false)
            if (!ok) (row as? JsonObject)?.let(orphans::add)
        }
    }
    private fun persist() {
        val json = buildJsonObject {
            put("v", 1)
            putJsonArray("keys") { entries.values.forEach { e -> add(buildJsonObject {
                put("kid", e.kid); put("machineId", e.machineId); put("addedAt", e.addedAt); put("sealed", wrap(e))
            }) }; orphans.forEach { add(it) } }
        }
        val stream = file.startWrite()
        try { stream.write(json.toString().toByteArray(Charsets.UTF_8)); file.finishWrite(stream) }
        catch (e: Exception) { file.failWrite(stream); throw e }
    }
    private fun publish() { _machines.value = entries.values.map { it.machineId }.toSet() }

    fun has(machineId: String): Boolean = machineId in _machines.value

    /**
     * Pair this device with a private machine from the code the machine printed. [expectMachineId] (the machine the
     * person is looking at) refuses a code for another machine, so a wrong paste cannot silently pair the wrong one.
     * Throws [PairingException] with words for the person.
     */
    @Synchronized fun add(code: String, expectMachineId: String? = null): String {
        val parsed = E2ee.parsePairingCode(code)
            ?: throw PairingException("Это не код пары: он начинается с hcp1. и печатается командой --pair на машине.")
        if (expectMachineId != null && parsed.machineId != expectMachineId) throw PairingException("Код от другой машины.")
        val raw = try { E2ee.b64urlDecode(parsed.key) } catch (_: IllegalArgumentException) { throw PairingException("Ключ повреждён.") }
        if (raw.size != 32) throw PairingException("Ключ повреждён: неверная длина.")
        val kid = E2ee.keyId(raw)
        val previous = entries[kid]
        val dropped = orphans.filter { it["kid"]?.jsonPrimitive?.contentOrNull == kid }
        orphans.removeAll(dropped)
        entries[kid] = Entry(kid, parsed.machineId, raw, System.currentTimeMillis())
        try { persist() } catch (_: Exception) {
            // A key that cannot be stored is not kept: the person would believe it is paired and lose it on restart.
            if (previous != null) entries[kid] = previous else entries.remove(kid)
            orphans.addAll(dropped)
            throw PairingException("Не удалось сохранить ключ на телефоне.")
        }
        publish()
        return parsed.machineId
    }

    /** Forget every key of a machine: this device can no longer read it. */
    @Synchronized fun forget(machineId: String) {
        val gone = entries.values.filter { it.machineId == machineId }
        gone.forEach { entries.remove(it.kid) }
        val goneOrphans = orphans.filter { it["machineId"]?.jsonPrimitive?.contentOrNull == machineId }
        orphans.removeAll(goneOrphans)
        try { persist() } catch (_: Exception) { gone.forEach { entries[it.kid] = it }; orphans.addAll(goneOrphans); throw PairingException("Не удалось забыть ключ: хранилище недоступно.") }
        publish()
    }

    /** Sign-out of the app does NOT call this: keys belong to the device and the machine, not to a hub login. */
    @Synchronized fun clearAll() { entries.clear(); orphans.clear(); runCatching { file.delete() }; publish() }

    companion object {
        private const val ALIAS = "hegai-e2ee-ring"
        @Volatile private var instance: E2eeStore? = null
        /** One instance per process: two over the same file could each delete the other's in-flight write and lose a key. */
        fun get(context: Context): E2eeStore = instance ?: synchronized(this) { instance ?: E2eeStore(context.applicationContext).also { instance = it } }
    }
}
