package net.hegai.code.core

import kotlinx.serialization.json.*
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Private machine, the Android side of the envelope (docs/E2EE.md). A line-for-line port of the
 * client half of shared/src/e2e.ts (traversal: which fields of which frames are content) and
 * web/src/e2ee/crypto.ts (cipher): AES-256-GCM, 96-bit random nonce, AAD `kid|machineId|dir|kind|id`.
 * `shared/test/e2e-vectors.json` is checked in [E2eeTest]. Pure JVM (javax.crypto): no Android types.
 *
 * Android is a CLIENT: it opens agent-to-client envelopes (`a2c`) and seals client-to-agent (`c2a`) ones.
 */
data class RingKey(val kid: String, val key: ByteArray)

/** What the frame helpers need from a key ring. */
interface E2eeKeys {
    /** The key a ciphertext with this `kid` needs, if this device holds it. */
    fun forKid(kid: String): ByteArray?
    /** The newest key paired with this machine, to seal with. */
    fun latestFor(machineId: String): RingKey?
    /** Whether this device holds a key for ANY machine. */
    fun hasAny(): Boolean
    fun has(machineId: String): Boolean = latestFor(machineId) != null

    object None : E2eeKeys {
        override fun forKid(kid: String): ByteArray? = null
        override fun latestFor(machineId: String): RingKey? = null
        override fun hasAny(): Boolean = false
    }
}

data class PairingCode(val machineId: String, val key: String)

object E2ee {
    const val PLACEHOLDER = "Зашифровано"
    const val NO_KEY_HINT = "Эта машина зашифрована — введите код пары, чтобы работать в ней."
    private val random = SecureRandom()

    // ---- keys and pairing code -------------------------------------------------------------------------

    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
    fun unhex(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    /** First 8 bytes of SHA-256(K), hex - the key id sent in clear. */
    fun keyId(key: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(key).copyOf(8))

    private val b64url = Regex("^[A-Za-z0-9_-]+$")

    fun b64urlDecode(s: String): ByteArray = Base64.getUrlDecoder().decode(s)

    /** Null for anything that is not a well-formed code. machineId may itself contain dots, so the key is the LAST segment. */
    fun parsePairingCode(code: String): PairingCode? {
        val s = code.trim()
        if (!s.startsWith("hcp1.")) return null
        val rest = s.removePrefix("hcp1.")
        val dot = rest.lastIndexOf('.')
        if (dot <= 0) return null
        val machineId = rest.substring(0, dot)
        val key = rest.substring(dot + 1)
        // 32 bytes -> 43 base64url chars without padding.
        if (!b64url.matches(key) || key.length != 43) return null
        return PairingCode(machineId, key)
    }

    // ---- bindings --------------------------------------------------------------------------------------

    fun bindTag(dir: String, kind: String, id: String) = "$dir|$kind|$id"
    fun withMachine(machineId: String, bind: String) = "$machineId|$bind"
    fun aadFor(kid: String, bind: String) = "$kid|$bind"
    val TURN_ECHO_BIND = bindTag("c2a", "turnecho", "")

    // ---- cipher ----------------------------------------------------------------------------------------

    /** Seal a JSON value bound to `bind` (`dir|kind|id`). `nonce` is for test vectors only. */
    fun seal(key: ByteArray, kid: String, value: JsonElement, bind: String, nonce: ByteArray = ByteArray(12).also(random::nextBytes)): JsonObject {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aadFor(kid, bind).toByteArray(Charsets.UTF_8))
        val body = cipher.doFinal(value.toString().toByteArray(Charsets.UTF_8))
        val b64 = Base64.getEncoder()
        return buildJsonObject {
            put("e2e", 1); put("kid", kid)
            put("n", b64.encodeToString(nonce)); put("c", b64.encodeToString(body))
        }
    }

    /** Open an envelope made for `bind`; throws on a wrong key, binding or tampering. */
    fun open(key: ByteArray, env: JsonObject, bind: String): JsonElement {
        val b64 = Base64.getDecoder()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, b64.decode(env.string("n")!!)))
        cipher.updateAAD(aadFor(env.string("kid").orEmpty(), bind).toByteArray(Charsets.UTF_8))
        val plain = cipher.doFinal(b64.decode(env.string("c")!!))
        return Json.parseToJsonElement(String(plain, Charsets.UTF_8))
    }

    /** The envelope shape the agent's zod schema accepts, else null. */
    fun envelopeOf(v: JsonElement?): JsonObject? {
        val o = v as? JsonObject ?: return null
        val e2e = o["e2e"] as? JsonPrimitive ?: return null
        if (e2e.isString || e2e.doubleOrNull != 1.0) return null
        val kid = o.string("kid"); val n = o.string("n"); val c = o.string("c")
        if (kid.isNullOrEmpty() || kid.length > 64 || n.isNullOrEmpty() || n.length > 64 || c.isNullOrEmpty()) return null
        return o
    }

    // ---- which fields are content (shared/src/e2e.ts) -----------------------------------------------------

    private class Spec(val take: List<String>, val at: String? = null, val blank: Map<String, JsonElement> = emptyMap(), val routing: List<String> = emptyList())

    private val emptyObj = JsonObject(emptyMap())
    private val FRAME_SPECS: Map<String, Spec> = mapOf(
        "stream" to Spec(listOf("text", "raw", "data"), at = "event"),
        "tool_request" to Spec(listOf("input", "title"), blank = mapOf("input" to emptyObj)),
        "tool_decision" to Spec(listOf("allow", "permissionMode", "updatedInput", "message"), routing = listOf("allow")),
        "input" to Spec(listOf("text", "images", "files"), blank = mapOf("text" to JsonPrimitive(""))),
        "open" to Spec(listOf("message", "images", "files")),
        "new_session" to Spec(listOf("message", "images", "files", "cwd", "model", "effort", "permissionMode"), routing = listOf("cwd", "model", "effort", "permissionMode")),
        "set_permission_mode" to Spec(listOf("mode"), routing = listOf("mode")),
        "takeover" to Spec(listOf("message", "images", "files")),
        "resume" to Spec(listOf("message", "images", "files")),
        "user_turn" to Spec(listOf("text", "images", "files"), blank = mapOf("text" to JsonPrimitive(""))),
        "run_status" to Spec(listOf("error")),
        "term_data" to Spec(listOf("data"), blank = mapOf("data" to JsonPrimitive(""))),
        "term_input" to Spec(listOf("data"), blank = mapOf("data" to JsonPrimitive(""))),
    )
    private val MESSAGE_SPEC = Spec(listOf("blocks", "ts", "model"), blank = mapOf("blocks" to JsonArray(emptyList())))

    /** RPC methods whose params carry content (everything else - cwd, path, ids - stays clear: the hub gates on them). */
    val RPC_SEALED_PARAMS: Map<String, List<String>> = mapOf(
        "fs.write" to listOf("content"),
        "fs.upload.chunk" to listOf("data"),
        "git.commit" to listOf("message"),
        "git.pr.create" to listOf("title", "body"),
        "session.rename" to listOf("title"),
        "runtime.login.input" to listOf("code"),
    )
    /** Clear rpc params that tell WHAT a sealed request does to WHERE; repeated inside the secret. */
    private val RPC_BOUND_PARAMS = listOf("cwd", "path", "dir", "name", "uploadId", "from", "to", "sessionId")

    private val TURN_TYPES = setOf("input", "open", "new_session", "takeover", "resume")
    private val META_TYPES = TURN_TYPES + setOf("tool_decision", "set_permission_mode")
    /** The turn types whose light `turnE2e` echo the hub forwards to other screens (no `resume`: only the hub makes it). */
    private val ECHO_TYPES = setOf("input", "open", "new_session", "takeover")

    private fun str(v: JsonElement?): String = (v as? JsonPrimitive)?.takeIf { it.isString }?.content ?: ""
    private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    /** The `dir|kind|id` binding of a frame's envelope. Same function on agent and web, so same string. */
    fun frameBind(dir: String, frame: JsonObject, epoch: String? = null): String {
        val type = str(frame["type"])
        if (type == "user_turn") return TURN_ECHO_BIND
        val d = if (dir == "c2a" && !epoch.isNullOrEmpty()) "c2a:$epoch" else dir
        if (type in TURN_TYPES) return bindTag(d, "turn", "")
        return when (type) {
            "stream", "run_status", "set_permission_mode" -> bindTag(d, type, str(frame["runId"]))
            "tool_request", "tool_decision" -> bindTag(d, type, str(frame["requestId"]))
            "term_data", "term_input" -> bindTag(d, type, str(frame["termId"]))
            "rpc_request", "rpc_response" -> bindTag(d, "rpc", str(frame["requestId"]))
            else -> bindTag(d, type, "")
        }
    }

    private fun messageBind(m: JsonObject) = bindTag("a2c", "msg", str(m["uuid"]))

    // ---- sealing (client to agent) ----------------------------------------------------------------------

    private class Taken(val secret: JsonObject, val holder: JsonObject)

    /** Lift `spec.take` out of `holder` into a secret; leave `spec.blank` behind. */
    private fun takeFrom(holder: JsonObject, spec: Spec): Taken? {
        val secret = linkedMapOf<String, JsonElement>()
        for (k in spec.take) holder[k]?.let { secret[k] = it }
        if (secret.isEmpty()) return null
        val next = LinkedHashMap(holder)
        for (k in spec.take) if (k !in spec.routing) next.remove(k)
        for ((k, v) in spec.blank) if (k in secret) next[k] = v
        return Taken(JsonObject(secret), JsonObject(next))
    }

    /** Put an opened secret back. EVERY content field is first dropped from the holder: what a hub left in the
     *  clear next to an envelope must not survive; a field the secret lacks goes back to its clear-side blank. */
    private fun putInto(holder: JsonObject, secret: JsonElement, spec: Spec): JsonObject {
        val next = LinkedHashMap(holder)
        next.remove("e2e")
        for (k in spec.take) next.remove(k)
        val s = secret as? JsonObject ?: emptyObj
        for (k in spec.take) s[k]?.let { next[k] = it }
        for ((k, v) in spec.blank) if (k !in s) next[k] = v
        return JsonObject(next)
    }

    /**
     * Seal an outgoing frame: content fields replaced by their clear-side blanks plus an `e2e` envelope made by
     * [sealer] (called once per secret with the secret and its `dir|kind|id` binding). Mirrors `collectSeal`
     * for the frames a client sends. A frame with nothing to seal comes back unchanged and never calls [sealer].
     */
    fun sealWith(frame: JsonObject, epoch: String?, sealer: (secret: JsonObject, bind: String) -> JsonObject): JsonObject {
        val type = frame["type"] as? JsonPrimitive
        val typeName = type?.takeIf { it.isString }?.content ?: ""
        val bind = frameBind("c2a", frame, epoch)
        if (typeName == "rpc_request") {
            val fields = RPC_SEALED_PARAMS[str(frame["method"])] ?: return frame
            val params = frame["params"] as? JsonObject ?: return frame
            val taken = takeFrom(params, Spec(fields)) ?: return frame
            val bound = LinkedHashMap<String, JsonElement>()
            for (k in RPC_BOUND_PARAMS) params[k]?.let { bound[k] = it }
            val secret = JsonObject(taken.secret + mapOf("_m" to JsonPrimitive(str(frame["method"])), "_p" to JsonObject(bound)))
            val env = sealer(secret, bind)
            return JsonObject(frame + ("params" to JsonObject(taken.holder + ("e2e" to env))))
        }
        val spec = FRAME_SPECS[typeName] ?: return frame
        fun sealHolder(holder: JsonObject): JsonObject? {
            val taken = takeFrom(holder, spec) ?: return null
            var secret: Map<String, JsonElement> = taken.secret
            if (typeName in META_TYPES) {
                val meta = linkedMapOf<String, JsonElement>("_k" to JsonPrimitive(typeName))
                (frame["runId"] as? JsonPrimitive)?.takeIf { it.isString }?.let { meta["_r"] = it }
                (frame["sessionId"] as? JsonPrimitive)?.takeIf { it.isString }?.let { meta["_s"] = it }
                secret = secret + meta
            }
            return JsonObject(taken.holder + ("e2e" to sealer(JsonObject(secret), bind)))
        }
        if (spec.at != null) {
            val inner = frame[spec.at] as? JsonObject ?: return frame
            val sealed = sealHolder(inner) ?: return frame
            return JsonObject(frame + (spec.at to sealed))
        }
        return sealHolder(frame) ?: frame
    }

    /** What a turn frame says, for the light `turnE2e` echo other screens show (never the attachment bytes). */
    private fun turnSecret(frame: JsonObject): JsonObject? {
        val text = frame.string("text") ?: frame.string("message") ?: ""
        val images = (frame["images"] as? JsonArray)?.size ?: 0
        val files = (frame["files"] as? JsonArray)?.mapNotNull { (it as? JsonObject)?.get("name")?.let { n -> (n as? JsonPrimitive)?.content } }
            ?.filter { it.isNotEmpty() }.orEmpty()
        if (text.isEmpty() && images == 0 && files.isEmpty()) return null
        return buildJsonObject {
            put("text", text)
            if (images > 0) put("images", images)
            if (files.isNotEmpty()) put("files", JsonArray(files.map(::JsonPrimitive)))
        }
    }

    fun isContentFrame(type: String?): Boolean = type in setOf("input", "open", "new_session", "takeover", "tool_decision", "set_permission_mode", "term_input", "rpc_request")

    private val DUMMY = buildJsonObject { put("e2e", 1); put("kid", "k"); put("n", "n"); put("c", "c") }
    private fun secretsOf(frame: JsonObject): List<JsonObject> {
        val out = mutableListOf<JsonObject>()
        sealWith(frame, null) { secret, _ -> out += secret; DUMMY }
        return out
    }
    /** Whether this outgoing frame actually carries something to seal. A bare `open`, `projects.list` or a history
     *  page has nothing secret in it: it goes as is, so a device without the key still subscribes. */
    fun needsSeal(frame: JsonObject): Boolean {
        val type = str(frame["type"])
        if (!isContentFrame(type)) return false
        if (type == "term_input") return true
        if (type in ECHO_TYPES && turnSecret(frame) != null) return true
        return secretsOf(frame).isNotEmpty()
    }
    private val ROUTING_ONLY = setOf("cwd", "model", "effort", "permissionMode", "allow", "mode", "_k", "_r", "_s", "_m", "_p")
    /** Whether sealing this frame hides something the person wrote (text, files, a command, an answer's text), as
     *  opposed to a frame sealed only because it addresses a keyed machine (a mode switch, a bare approval). */
    fun hasRealContent(frame: JsonObject): Boolean {
        val type = str(frame["type"])
        if (!isContentFrame(type)) return false
        if (type == "term_input") return true
        return secretsOf(frame).any { s -> s.keys.any { it !in ROUTING_ONLY } }
    }

    /** Seal [frame] for [machineId] with the newest key. Throws when there is no key or no epoch (fail closed). */
    fun sealFrame(frame: JsonObject, machineId: String, keys: E2eeKeys, epoch: String?): JsonObject {
        val k = keys.latestFor(machineId) ?: error("no key for this machine")
        if (epoch.isNullOrEmpty()) error("the machine has not announced its epoch yet")
        val typeName = str(frame["type"])
        var out = sealWith(frame, epoch) { secret, bind -> seal(k.key, k.kid, secret, withMachine(machineId, bind)) }
        if (typeName in ECHO_TYPES) turnSecret(frame)?.let {
            out = JsonObject(out + ("turnE2e" to seal(k.key, k.kid, it, withMachine(machineId, TURN_ECHO_BIND))))
        }
        return out
    }

    // ---- opening (agent to client) -----------------------------------------------------------------------

    private fun tryOpen(keys: E2eeKeys, machineId: String, env: JsonObject, bind: String): JsonElement? {
        val key = keys.forKid(env.string("kid").orEmpty()) ?: return null
        return try { open(key, env, withMachine(machineId, bind)) } catch (_: Exception) { null }
    }

    private fun openMessages(messages: JsonArray, machineId: String, keys: E2eeKeys): JsonArray = JsonArray(messages.map { m ->
        val obj = m as? JsonObject ?: return@map m
        val env = envelopeOf(obj["e2e"]) ?: return@map m
        val secret = tryOpen(keys, machineId, env, messageBind(obj)) ?: return@map m
        putInto(obj, secret, MESSAGE_SPEC)
    })

    /**
     * A frame from the hub with every envelope this device can open opened. An envelope it cannot open (no key,
     * wrong key, made for another machine) stays where it was, so the UI can say «нужен ключ». Envelopes are bound
     * to a machine id: they open only under the machine this client itself puts the frame on ([machineOf] is its own
     * bookkeeping, never a field the hub chose; null = unknown, the envelope stays shut).
     */
    fun openFrame(frame: JsonObject, keys: E2eeKeys, machineOf: (JsonObject) -> String?): JsonObject {
        openSummaries(frame, keys)?.let { return it }
        val type = str(frame["type"])
        val bind = frameBind("a2c", frame)
        fun machine(): String? = machineOf(frame)
        when (type) {
            "rpc_response" -> {
                val result = frame["result"] as? JsonObject
                val resultEnv = envelopeOf(result?.get("e2e"))
                val errorEnv = envelopeOf(frame["e2e"])
                val hasMessages = result?.get("messages") is JsonArray
                if (resultEnv == null && errorEnv == null && !hasMessages) return frame
                val machineId = machine() ?: return frame
                var out = frame
                if (resultEnv != null) tryOpen(keys, machineId, resultEnv, bind)?.let { out = JsonObject(out + ("result" to it)) }
                else if (hasMessages) {
                    out = JsonObject(out + ("result" to JsonObject(result!! + ("messages" to openMessages(result["messages"] as JsonArray, machineId, keys)))))
                }
                if (errorEnv != null) tryOpen(keys, machineId, errorEnv, bind)?.let { secret ->
                    val next = LinkedHashMap(out)
                    (secret as? JsonObject)?.get("error")?.let { e -> if (e is JsonPrimitive && e.isString) next["error"] = e }
                    next.remove("e2e")
                    out = JsonObject(next)
                }
                return out
            }
            "session_sync_chunk", "mirror_data" -> {
                val messages = frame["messages"] as? JsonArray ?: return frame
                if (messages.none { envelopeOf((it as? JsonObject)?.get("e2e")) != null }) return frame
                val machineId = machine() ?: return frame
                return JsonObject(frame + ("messages" to openMessages(messages, machineId, keys)))
            }
        }
        val spec = FRAME_SPECS[type] ?: return frame
        fun openHolder(holder: JsonObject): JsonObject? {
            val env = envelopeOf(holder["e2e"]) ?: return null
            val machineId = machine() ?: return null
            val secret = tryOpen(keys, machineId, env, bind) ?: return null
            return putInto(holder, secret, spec)
        }
        if (spec.at != null) {
            val inner = frame[spec.at] as? JsonObject ?: return frame
            val opened = openHolder(inner) ?: return frame
            return JsonObject(frame + (spec.at to opened))
        }
        return openHolder(frame) ?: frame
    }

    private fun openSummary(s: JsonObject, machineId: String?, keys: E2eeKeys): JsonObject {
        if (s["titleE2e"] == null && s["cwdE2e"] == null) return s
        if (machineId == null) return s
        var out: JsonObject = s
        val sid = str(s["sessionId"])
        envelopeOf(s["titleE2e"])?.let { env ->
            tryOpen(keys, machineId, env, bindTag("a2c", "title", sid))?.let { secret ->
                val next = LinkedHashMap(out)
                if (secret is JsonPrimitive && secret.isString) next["title"] = secret
                next.remove("titleE2e"); out = JsonObject(next)
            }
        }
        envelopeOf(s["cwdE2e"])?.let { env ->
            tryOpen(keys, machineId, env, bindTag("a2c", "cwd", sid))?.let { secret ->
                val next = LinkedHashMap(out)
                if (secret is JsonObject) for (k in listOf("cwd", "project", "gitBranch")) {
                    val v = secret[k]; if (v is JsonPrimitive && v.isString) next[k] = v
                }
                next.remove("cwdE2e"); out = JsonObject(next)
            }
        }
        return out
    }

    /** Frames that list session summaries: titles and folders arrive sealed apart. Null = not such a frame. */
    private fun openSummaries(f: JsonObject, keys: E2eeKeys): JsonObject? {
        fun any(list: JsonArray?) = list?.any { val o = it as? JsonObject; o != null && (o["titleE2e"] != null || o["cwdE2e"] != null) } == true
        fun open(list: JsonArray?, machineId: String?) = JsonArray(list.orEmpty().map { (it as? JsonObject)?.let { s -> openSummary(s, machineId, keys) } ?: it })
        return when (str(f["type"])) {
            "snapshot" -> {
                val machines = f["machines"] as? JsonArray ?: return null
                val has = machines.any { any((it as? JsonObject)?.get("sessions") as? JsonArray) }
                if (!has) return f
                JsonObject(f + ("machines" to JsonArray(machines.map { m ->
                    val mo = m as? JsonObject ?: return@map m
                    val id = ((mo["machine"] as? JsonObject)?.get("machineId") as? JsonPrimitive)?.takeIf { it.isString }?.content
                    JsonObject(mo + ("sessions" to open(mo["sessions"] as? JsonArray, id)))
                })))
            }
            "machine_sessions" -> {
                val machine = f["machine"] as? JsonObject ?: return f
                val sessions = machine["sessions"] as? JsonArray
                if (!any(sessions)) return f
                val id = ((machine["machine"] as? JsonObject)?.get("machineId") as? JsonPrimitive)?.takeIf { it.isString }?.content
                JsonObject(f + ("machine" to JsonObject(machine + ("sessions" to open(sessions, id)))))
            }
            "session_updates" -> {
                val sessions = f["sessions"] as? JsonArray
                if (!any(sessions)) return f
                JsonObject(f + ("sessions" to open(sessions, str(f["machineId"]).ifEmpty { null })))
            }
            else -> null
        }
    }

    private val RPC_CLEAR_RESULT = setOf("models.list")
    private val RPC_MESSAGE_RESULT = setOf("session.messages", "session.subagent")
    /** True when an `ok` rpc_response carries content in the clear that the agent of a keyed machine would have sealed
     *  (mirror of `clearRpcContent` in shared/src/e2e.ts): the hub's own invention, never shown. */
    fun clearRpcContent(method: String, frame: JsonObject): Boolean {
        if ((frame["ok"] as? JsonPrimitive)?.booleanOrNull != true) return false
        val result = frame["result"] ?: return false
        if (method in RPC_CLEAR_RESULT) return false
        if (result is JsonObject && result.size == 1 && (result["ok"] as? JsonPrimitive)?.booleanOrNull == true) return false
        if (method in RPC_MESSAGE_RESULT && result is JsonObject && result["messages"] is JsonArray) {
            return (result["messages"] as JsonArray).any { m ->
                val o = m as? JsonObject ?: return@any false
                if (o["e2e"] !is JsonObject) return@any MESSAGE_SPEC.take.any { o[it] != null }
                val blocks = o["blocks"]
                o["ts"] != null || o["model"] != null || (blocks != null && !(blocks is JsonArray && blocks.isEmpty()))
            }
        }
        return !(result is JsonObject && envelopeOf(result["e2e"]) != null && result.size == 1)
    }

    /** A clear frame about a run of a machine whose key is in the ring is the hub's own invention (it cannot read the
     *  real one): it is dropped, never shown. [keyed]: this device holds the machine's key. */
    fun clearContentForKeyedRun(msg: JsonObject): Boolean {
        fun nonEmpty(v: JsonElement?) = v != null && v !is JsonNull && !(v is JsonPrimitive && v.isString && v.content.isEmpty())
        return when (str(msg["type"])) {
            "stream" -> {
                val ev = msg["event"] as? JsonObject ?: return false
                ev["e2e"] == null && (nonEmpty(ev["text"]) || ev["raw"] != null || ev["data"] != null)
            }
            "tool_request" -> msg["e2e"] == null && (nonEmpty(msg["title"]) || (msg["input"] as? JsonObject)?.isNotEmpty() == true)
            "user_turn" -> msg["e2e"] == null && (nonEmpty(msg["text"]) || msg["images"] != null || (msg["files"] as? JsonArray)?.isNotEmpty() == true)
            else -> false
        }
    }
}
