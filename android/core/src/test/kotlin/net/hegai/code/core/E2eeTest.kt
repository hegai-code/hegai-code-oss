package net.hegai.code.core

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** Private machine, Android side (docs/E2EE.md). The vectors are shared with the agent (Node crypto) and the web (WebCrypto). */
class E2eeTest {
    private val vectors: JsonObject = listOf("../../shared/test/e2e-vectors.json", "../shared/test/e2e-vectors.json", "shared/test/e2e-vectors.json")
        .map(::File).first { it.exists() }.readText().let { Json.parseToJsonElement(it).jsonObject }
    private val key = E2ee.unhex(vectors.string("keyHex")!!)
    private val kid = vectors.string("kid")!!
    private val MARK = "SYNTHETIC-MARKER-7f3a"

    private class Ring(val entries: List<Triple<String, String, ByteArray>>) : E2eeKeys {
        override fun forKid(kid: String) = entries.firstOrNull { it.first == kid }?.third
        override fun latestFor(machineId: String) = entries.lastOrNull { it.second == machineId }?.let { RingKey(it.first, it.third) }
        override fun hasAny() = entries.isNotEmpty()
    }
    private fun ring(machine: String = "m") = Ring(listOf(Triple(kid, machine, key)))

    @Test fun `shared vector seals to the same bytes and opens`() {
        val value = vectors["value"]!!
        val bind = vectors.string("bind")!!
        val nonce = E2ee.unhex(vectors.string("nonceHex")!!)
        assertEquals(vectors["envelope"]!!.jsonObject, E2ee.seal(key, kid, value, bind, nonce))
        assertEquals(value, E2ee.open(key, vectors["envelope"]!!.jsonObject, bind))
        assertEquals(kid, E2ee.keyId(key))
    }
    @Test fun `a wrong binding or a damaged envelope does not open`() {
        val env = vectors["envelope"]!!.jsonObject
        listOf("m-2|a2c|stream|run-1", "m-1|c2a|stream|run-1", "m-1|a2c|stream|run-2", "m-1|a2c|run_status|run-1").forEach {
            assertTrue(it, runCatching { E2ee.open(key, env, it) }.isFailure)
        }
        assertTrue(runCatching { E2ee.open(ByteArray(32), env, vectors.string("bind")!!) }.isFailure)
        val c = env.string("c")!!
        val damaged = JsonObject(env + ("c" to JsonPrimitive((if (c[0] == 'A') 'B' else 'A') + c.drop(1))))
        assertTrue(runCatching { E2ee.open(key, damaged, vectors.string("bind")!!) }.isFailure)
    }
    @Test fun `pairing code of the vector parses to the vector key`() {
        val parsed = E2ee.parsePairingCode(vectors.string("pairingCode")!!)!!
        assertEquals("m-1", parsed.machineId)
        assertArrayEquals(key, E2ee.b64urlDecode(parsed.key))
        assertEquals("a.b", E2ee.parsePairingCode("  hcp1.a.b.${parsed.key}\n")?.machineId)
        listOf("", "hcp1.", "hcp1.m", "hcp1.m.short", "hcp2.m.${parsed.key}", "hcp1..${parsed.key}", "m.${parsed.key}", "hcp1.m.${parsed.key}=", "hcp1.m.${parsed.key.dropLast(1)}+").forEach {
            assertNull(it, E2ee.parsePairingCode(it))
        }
    }

    // ---- sealing a client frame -----------------------------------------------------------------------------
    private fun seal(frame: JsonObject, machine: String = "m") = E2ee.sealFrame(frame, machine, ring(machine), "ep1")
    private fun secretOf(env: JsonObject, bind: String, machine: String = "m") = E2ee.open(key, env, E2ee.withMachine(machine, bind)).jsonObject

    @Test fun `input text blanks and the secret opens under the epoch binding`() {
        val f = frame("input") { put("runId", "r"); put("text", MARK); put("ref", "x") }
        val s = seal(f)
        assertFalse(s.toString().contains(MARK))
        assertEquals("", s.string("text")); assertEquals("r", s.string("runId")); assertEquals("x", s.string("ref"))
        val secret = secretOf(s["e2e"]!!.jsonObject, "c2a:ep1|turn|")
        assertEquals(MARK, secret.string("text")); assertEquals("input", secret.string("_k")); assertEquals("r", secret.string("_r"))
        // the light echo other screens show
        assertEquals(MARK, secretOf(s["turnE2e"]!!.jsonObject, E2ee.TURN_ECHO_BIND).string("text"))
        // a different epoch (a restarted agent) does not open it
        assertTrue(runCatching { secretOf(s["e2e"]!!.jsonObject, "c2a:ep2|turn|") }.isFailure)
    }
    @Test fun `open and new_session keep routing hints clear and seal the person's choices`() {
        val o = seal(frame("open") { put("machineId", "m"); put("sessionId", "s"); put("message", MARK); put("ref", "x") })
        assertNull(o["message"]); assertEquals("s", o.string("sessionId"))
        assertEquals(MARK, secretOf(o["e2e"]!!.jsonObject, "c2a:ep1|turn|").string("message"))
        val n = seal(frame("new_session") { put("machineId", "m"); put("cwd", "/w"); put("source", "claude"); put("message", MARK); put("model", "opus"); put("permissionMode", "plan") })
        assertEquals("/w", n.string("cwd")); assertEquals("opus", n.string("model"))
        val secret = secretOf(n["e2e"]!!.jsonObject, "c2a:ep1|turn|")
        assertEquals(setOf("message", "cwd", "model", "permissionMode", "_k"), secret.keys)
        assertEquals("new_session", secret.string("_k"))
    }
    @Test fun `tool_decision and set_permission_mode are sealed with their routing hint`() {
        val d = seal(frame("tool_decision") { put("runId", "r"); put("requestId", "q"); put("allow", true); put("updatedInput", buildJsonObject { put("answers", MARK) }) })
        assertEquals(JsonPrimitive(true), d["allow"]); assertNull(d["updatedInput"])
        val secret = secretOf(d["e2e"]!!.jsonObject, "c2a:ep1|tool_decision|q")
        assertEquals(JsonPrimitive(true), secret["allow"]); assertTrue(secret.toString().contains(MARK))
        val m = seal(frame("set_permission_mode") { put("runId", "r"); put("mode", "plan") })
        assertEquals("plan", m.string("mode"))
        assertEquals("plan", secretOf(m["e2e"]!!.jsonObject, "c2a:ep1|set_permission_mode|r").string("mode"))
    }
    @Test fun `sealed rpc request repeats its method and bound params and seals only content params`() {
        val f = frame("rpc_request") { put("requestId", "q"); put("machineId", "m"); put("method", "fs.write"); putJsonObject("params") { put("path", "/a"); put("content", MARK) } }
        val s = seal(f)
        val params = s["params"]!!.jsonObject
        assertEquals("/a", params.string("path")); assertNull(params["content"])
        val secret = secretOf(params["e2e"]!!.jsonObject, "c2a:ep1|rpc|q")
        assertEquals(MARK, secret.string("content")); assertEquals("fs.write", secret.string("_m"))
        assertEquals("/a", secret["_p"]!!.jsonObject.string("path"))
        val plain = frame("rpc_request") { put("requestId", "q"); put("machineId", "m"); put("method", "projects.list"); putJsonObject("params") {} }
        assertEquals(plain, seal(plain))
    }
    @Test fun `needsSeal skips frames with nothing to hide and sealing needs a key and an epoch`() {
        assertFalse(E2ee.needsSeal(frame("open") { put("machineId", "m"); put("sessionId", "s") }))
        assertFalse(E2ee.needsSeal(frame("subscribe") { put("runId", "r") }))
        assertTrue(E2ee.needsSeal(frame("input") { put("runId", "r"); put("text", "x") }))
        assertTrue(runCatching { E2ee.sealFrame(frame("input") { put("runId", "r"); put("text", "x") }, "other", ring("m"), "ep") }.isFailure)
        assertTrue(runCatching { E2ee.sealFrame(frame("input") { put("runId", "r"); put("text", "x") }, "m", ring("m"), null) }.isFailure)
    }

    // ---- opening what the agent sends -------------------------------------------------------------------------
    private fun envelope(secret: JsonElement, bind: String, machine: String = "m") = E2ee.seal(key, kid, secret, E2ee.withMachine(machine, bind))
    private fun open(frame: JsonObject, machine: String? = "m") = E2ee.openFrame(frame, ring(), { machine })

    @Test fun `stream event opens and a clear field next to the envelope does not survive`() {
        val secret = buildJsonObject { put("text", MARK); putJsonObject("data") { put("a", 1) } }
        val f = frame("stream") { put("runId", "r"); putJsonObject("event") { put("kind", "assistant"); put("code", "x"); put("text", "FORGED"); put("e2e", envelope(secret, "a2c|stream|r")) } }
        val o = open(f)
        val ev = o["event"]!!.jsonObject
        assertEquals(MARK, ev.string("text")); assertEquals("assistant", ev.string("kind")); assertNull(ev["e2e"]); assertEquals(1, ev["data"]!!.jsonObject["a"]!!.jsonPrimitive.int)
    }
    @Test fun `an envelope stays shut for another machine, another run or no machine`() {
        val f = frame("stream") { put("runId", "r"); putJsonObject("event") { put("kind", "assistant"); put("e2e", envelope(buildJsonObject { put("text", MARK) }, "a2c|stream|r")) } }
        assertEquals(f, open(f, "other"))
        assertEquals(f, open(f, null))
        val moved = JsonObject(f + ("runId" to JsonPrimitive("r2")))
        assertEquals(moved, open(moved))
    }
    @Test fun `tool_request and user_turn and run_status open`() {
        val t = open(frame("tool_request") { put("runId", "r"); put("requestId", "q"); put("tool", "Bash"); putJsonObject("input") {}
            put("e2e", envelope(buildJsonObject { putJsonObject("input") { put("command", MARK) }; put("title", "T") }, "a2c|tool_request|q")) })
        assertEquals(MARK, t["input"]!!.jsonObject.string("command")); assertEquals("T", t.string("title")); assertNull(t["e2e"])
        val u = open(frame("user_turn") { put("runId", "r"); put("text", ""); put("e2e", envelope(buildJsonObject { put("text", MARK); put("images", 2) }, E2ee.TURN_ECHO_BIND.removePrefix("c2a|").let { "c2a|turnecho|" })) })
        assertEquals(MARK, u.string("text")); assertEquals(2, u["images"]!!.jsonPrimitive.int)
        val r = open(frame("run_status") { put("runId", "r"); put("state", "error"); put("e2e", envelope(buildJsonObject { put("error", MARK) }, "a2c|run_status|r")) })
        assertEquals(MARK, r.string("error")); assertEquals("error", r.string("state"))
    }
    @Test fun `history messages open one by one and an unreadable one stays an envelope`() {
        val good = buildJsonObject { put("uuid", "u1"); put("type", "assistant"); putJsonArray("blocks") {}
            put("e2e", envelope(buildJsonObject { putJsonArray("blocks") { add(buildJsonObject { put("kind", "text"); put("text", MARK) }) }; put("ts", 5) }, "a2c|msg|u1")) }
        val bad = buildJsonObject { put("uuid", "u2"); put("type", "user"); put("e2e", envelope(buildJsonObject { put("blocks", JsonArray(emptyList())) }, "a2c|msg|OTHER")) }
        val o = open(frame("rpc_response") { put("requestId", "q"); put("ok", true); putJsonObject("result") { put("messages", JsonArray(listOf(good, bad))) } })
        val messages = o["result"]!!.jsonObject["messages"]!!.jsonArray
        assertEquals(MARK, messages[0].jsonObject["blocks"]!!.jsonArray[0].jsonObject.string("text")); assertEquals(5L, messages[0].jsonObject["ts"]!!.jsonPrimitive.long)
        assertNotNull(messages[1].jsonObject["e2e"])
        val lines = historyLines(wireJson.decodeFromJsonElement(JsonArray(messages.take(1))))
        assertEquals(MARK, lines.single().text)
    }
    @Test fun `rpc results and errors open`() {
        val ok = open(frame("rpc_response") { put("requestId", "q"); put("ok", true); putJsonObject("result") { put("e2e", envelope(buildJsonObject { put("content", MARK) }, "a2c|rpc|q")) } })
        assertEquals(MARK, ok["result"]!!.jsonObject.string("content"))
        val err = open(frame("rpc_response") { put("requestId", "q"); put("ok", false); put("error", E2ee.PLACEHOLDER); put("e2e", envelope(buildJsonObject { put("error", "no such file") }, "a2c|rpc|q")) })
        assertEquals("no such file", err.string("error")); assertNull(err["e2e"])
    }
    @Test fun `session summaries open title and place in every frame that lists them`() {
        fun summary(title: String = E2ee.PLACEHOLDER) = buildJsonObject { put("sessionId", "s"); put("title", title)
            put("titleE2e", envelope(JsonPrimitive(MARK), "a2c|title|s")); put("cwdE2e", envelope(buildJsonObject { put("cwd", "/w/x"); put("project", "x") }, "a2c|cwd|s")) }
        val snap = open(frame("snapshot") { putJsonArray("machines") { add(buildJsonObject { putJsonObject("machine") { put("machineId", "m") }; putJsonArray("sessions") { add(summary()) } }) } })
        val s = snap["machines"]!!.jsonArray[0].jsonObject["sessions"]!!.jsonArray[0].jsonObject
        assertEquals(MARK, s.string("title")); assertEquals("/w/x", s.string("cwd")); assertEquals("x", s.string("project")); assertNull(s["titleE2e"])
        val upd = open(frame("session_updates") { put("machineId", "m"); putJsonArray("sessions") { add(summary()) } })
        assertEquals(MARK, upd["sessions"]!!.jsonArray[0].jsonObject.string("title"))
        val other = open(frame("session_updates") { put("machineId", "z"); putJsonArray("sessions") { add(summary()) } })
        assertEquals(E2ee.PLACEHOLDER, other["sessions"]!!.jsonArray[0].jsonObject.string("title"))
    }
    @Test fun `clear content for a keyed run is recognised`() {
        assertTrue(E2ee.clearContentForKeyedRun(frame("stream") { put("runId", "r"); putJsonObject("event") { put("kind", "assistant"); put("text", "hi") } }))
        assertFalse(E2ee.clearContentForKeyedRun(frame("stream") { put("runId", "r"); putJsonObject("event") { put("kind", "turn_started"); put("code", "turn_started") } }))
        assertTrue(E2ee.clearContentForKeyedRun(frame("tool_request") { put("runId", "r"); put("title", "x") }))
        assertTrue(E2ee.clearContentForKeyedRun(frame("user_turn") { put("runId", "r"); put("text", "x") }))
        assertFalse(E2ee.clearContentForKeyedRun(frame("user_turn") { put("runId", "r"); put("text", ""); put("e2e", vectors["envelope"]!!) }))
    }
}

/** Frames sealed by the REAL agent-side traversal (shared/src/e2e.ts) and Node crypto with the vector key, machine `m-1`
 *  (generated once; see the commit message): Kotlin must open them to exactly what the agent put in. */
class E2eeAgentFramesTest {
    private val key = ByteArray(32) { it.toByte() }
    private val keys = object : E2eeKeys {
        override fun forKid(kid: String) = key.takeIf { E2ee.keyId(it) == kid }
        override fun latestFor(machineId: String) = RingKey(E2ee.keyId(key), key)
        override fun hasAny() = true
    }
    private val frames = Json.parseToJsonElement(javaClass.getResource("/e2e-agent-frames.json")!!.readText()).jsonArray.map { it.jsonObject }
    private fun opened(i: Int) = E2ee.openFrame(frames[i], keys) { "m-1" }

    @Test fun `stream`() {
        val ev = opened(0)["event"]!!.jsonObject
        assertEquals("привет «мир»   ✓", ev.string("text")); assertEquals("x", ev.string("code"))
        assertEquals(1.5, ev["data"]!!.jsonObject["n"]!!.jsonPrimitive.double, 0.0); assertEquals(12345678901L, ev["data"]!!.jsonObject["big"]!!.jsonPrimitive.long)
        assertEquals(3, ev["raw"]!!.jsonObject["a"]!!.jsonArray.size); assertNull(ev["e2e"])
    }
    @Test fun `tool request`() {
        val o = opened(1)
        assertEquals("ls \"x\"", o["input"]!!.jsonObject.string("command")); assertEquals("T", o.string("title")); assertNull(o["e2e"])
    }
    @Test fun `history page`() {
        val lines = historyLines(wireJson.decodeFromJsonElement(opened(2)["result"]!!.jsonObject["messages"]!!))
        assertEquals("ответ", lines.single().text); assertEquals(1700000000000L, lines.single().ts)
    }
    @Test fun `whole rpc result and error`() {
        assertEquals("a", opened(3)["result"]!!.jsonObject["entries"]!!.jsonArray[0].jsonObject.string("name"))
        val err = opened(4); assertEquals("no such file: /x", err.string("error")); assertNull(err["e2e"])
    }
    @Test fun `fatal run error`() = assertEquals("boom", opened(5).string("error"))
    @Test fun `session summary`() {
        val s = opened(6)["sessions"]!!.jsonArray[0].jsonObject
        assertEquals("Секретный заголовок", s.string("title")); assertEquals("/w/p", s.string("cwd")); assertEquals("main", s.string("gitBranch"))
    }
}

/** The engine on a private machine: fail closed on send, open on receive (the web's useCentral rules). */
class E2eeEngineTest {
    private val key = ByteArray(32) { it.toByte() }
    private val kid = E2ee.keyId(key)
    private class Keys : E2eeKeys {
        var held: Map<String, ByteArray> = emptyMap()
        override fun forKid(kid: String) = held.values.firstOrNull { E2ee.keyId(it) == kid }
        override fun latestFor(machineId: String) = held[machineId]?.let { RingKey(E2ee.keyId(it), it) }
        override fun hasAny() = held.isNotEmpty()
    }
    private class H(val keys: Keys) {
        val sent = mutableListOf<JsonObject>()
        val needed = mutableListOf<String>()
        val engine = HubEngine(send = { sent += it; true }, keys = keys, needKey = { needed += it })
        fun receive(f: JsonObject) = engine.receive(f.toString())
    }
    private fun env(secret: JsonElement, bind: String, machine: String = "m") = E2ee.seal(key, kid, secret, E2ee.withMachine(machine, bind))
    private fun snapshot(isPrivate: Boolean = true, epoch: String? = "EP") = frame("snapshot") {
        putJsonObject("viewer") { put("userId", "me") }
        putJsonArray("machines") { add(buildJsonObject {
            putJsonObject("machine") { put("machineId", "m"); put("name", "Box"); if (isPrivate) put("private", true); epoch?.let { put("e2eEpoch", it) } }
            put("online", true); put("canControl", true); putJsonObject("owner") { put("userId", "me") }
            putJsonArray("sessions") { add(buildJsonObject { put("sessionId", "s"); put("title", E2ee.PLACEHOLDER); put("lastModified", 1)
                put("titleE2e", env(JsonPrimitive("Тайный чат"), "a2c|title|s")); put("cwdE2e", env(buildJsonObject { put("cwd", "/w/p") }, "a2c|cwd|s")) }) }
        }) }
        putJsonArray("activeRuns") {}
    }
    private fun answerHistory(h: H) {
        val id = h.sent.last { it.string("type") == "rpc_request" }.string("requestId")!!
        h.receive(frame("rpc_response") { put("requestId", id); put("ok", true); putJsonObject("result") { put("messages", JsonArray(emptyList())) } })
    }
    private fun ready(h: H) {
        h.engine.connecting(); h.engine.connected(); h.receive(snapshot())
        h.engine.keysChanged(h.keys.held.keys)
    }
    private val tgt = Target("m", "/w/p", "s", "Тайный чат", "claude")

    @Test fun `without a key the machine is locked, nothing is sent and the pairing is asked for`() {
        val h = H(Keys()); ready(h)
        assertEquals(E2ee.PLACEHOLDER, h.engine.state.machines[0].sessions[0].title)
        h.engine.select(tgt)
        assertTrue(h.engine.state.locked); assertNotNull(h.engine.state.readOnlyReason)
        // the history read carries only a clear path, no content: it goes, so the placeholders show
        val before = h.sent.size
        h.engine.editDraft("секрет"); h.engine.submit()
        assertEquals(before, h.sent.size)
        assertTrue(h.sent.none { it.toString().contains("секрет") })
        // a direct send of content is refused too, whatever the UI did
        assertFalse(h.engine.command("input", buildJsonObject { put("runId", "r"); put("text", "секрет") }))
    }
    @Test fun `a hub that says not private does not make a keyed device type in the clear`() {
        val h = H(Keys().also { it.held = mapOf("m" to key) })
        h.engine.connecting(); h.engine.connected(); h.receive(snapshot(isPrivate = false)); h.engine.keysChanged(setOf("m"))
        h.engine.select(tgt); answerHistory(h); h.receive(frame("opened") { put("machineId", "m"); put("sessionId", "s"); put("runId", "r") })
        h.sent.clear(); h.engine.editDraft("секрет"); h.engine.submit()
        val input = h.sent.single { it.string("type") == "input" }
        assertFalse(input.toString().contains("секрет")); assertNotNull(input["e2e"])
    }
    @Test fun `with a key a message is sealed for the machine and its epoch`() {
        val h = H(Keys().also { it.held = mapOf("m" to key) }); ready(h)
        assertEquals("Тайный чат", h.engine.state.machines[0].sessions[0].title); assertEquals("/w/p", h.engine.state.machines[0].sessions[0].cwd)
        assertFalse(h.engine.state.locked)
        h.engine.select(tgt); answerHistory(h); h.sent.clear()
        h.engine.editDraft("секрет"); h.engine.submit()
        val sent = h.sent.single { it.string("type") == "open" }
        assertFalse(sent.toString().contains("секрет")); assertEquals("s", sent.string("sessionId"))
        assertEquals("секрет", E2ee.open(key, sent["e2e"]!!.jsonObject, "m|c2a:EP|turn|").jsonObject.string("message"))
        // the sealed turn is answered by `opened` for the machine this client asked
        h.receive(frame("opened") { put("machineId", "m"); put("sessionId", "s"); put("runId", "r"); put("ref", sent.string("ref")!!) })
        assertEquals("r", h.engine.state.runId)
    }
    @Test fun `no epoch yet fails closed`() {
        val h = H(Keys().also { it.held = mapOf("m" to key) })
        h.engine.connecting(); h.engine.connected(); h.receive(snapshot(epoch = null)); h.engine.keysChanged(setOf("m"))
        h.engine.select(tgt); answerHistory(h); h.sent.clear(); h.engine.editDraft("секрет"); h.engine.submit()
        assertTrue(h.sent.none { it.string("type") in setOf("open", "input") })
        assertTrue(h.engine.state.error!!.contains("не отправлено") || h.engine.state.error!!.contains("зашифр"))
        assertEquals("секрет", h.engine.state.draft)
    }
    @Test fun `stream and history open, a clear stream for a keyed run is dropped`() {
        val h = H(Keys().also { it.held = mapOf("m" to key) }); ready(h)
        h.engine.select(tgt)
        val rpc = h.sent.last { it.string("type") == "rpc_request" }
        val msg = buildJsonObject { put("uuid", "u1"); put("type", "assistant"); putJsonArray("blocks") {}
            put("e2e", env(buildJsonObject { putJsonArray("blocks") { add(buildJsonObject { put("kind", "text"); put("text", "из истории") }) } }, "a2c|msg|u1")) }
        h.receive(frame("rpc_response") { put("requestId", rpc.string("requestId")!!); put("ok", true); putJsonObject("result") { put("messages", JsonArray(listOf(msg))) } })
        assertEquals("из истории", h.engine.state.history.single().text)
        h.receive(frame("opened") { put("machineId", "m"); put("sessionId", "s"); put("runId", "r") })
        h.receive(frame("stream") { put("runId", "r"); putJsonObject("event") { put("kind", "assistant"); put("e2e", env(buildJsonObject { put("text", "ответ") }, "a2c|stream|r")) } })
        assertEquals("ответ", h.engine.state.live.last().text)
        h.receive(frame("stream") { put("runId", "r"); putJsonObject("event") { put("kind", "assistant"); put("text", "ПОДДЕЛКА") } })
        assertTrue(h.engine.state.live.none { it.text == "ПОДДЕЛКА" })
        h.receive(frame("tool_request") { put("runId", "r"); put("requestId", "q"); put("tool", "Bash"); put("title", "ПОДДЕЛКА"); putJsonObject("input") { put("c", "x") } })
        assertNull(h.engine.state.approval)
        h.receive(frame("tool_request") { put("runId", "r"); put("requestId", "q"); put("tool", "Bash"); putJsonObject("input") {}
            put("e2e", env(buildJsonObject { putJsonObject("input") { put("command", "ls") }; put("title", "T") }, "a2c|tool_request|q")) })
        assertEquals("ls", h.engine.state.approval!!.input.string("command"))
        // the decision goes back sealed
        h.sent.clear(); h.engine.decide(true)
        val d = h.sent.single { it.string("type") == "tool_decision" }
        assertEquals(JsonPrimitive(true), d["allow"]); assertNotNull(d["e2e"])
    }
    @Test fun `an answer from another machine to an open is dropped`() {
        val h = H(Keys().also { it.held = mapOf("m" to key) }); ready(h); h.engine.select(tgt); answerHistory(h); h.sent.clear()
        h.engine.editDraft("x"); h.engine.submit()
        val ref = h.sent.single { it.string("type") == "open" }.string("ref")!!
        h.receive(frame("opened") { put("machineId", "other"); put("sessionId", "s"); put("runId", "r"); put("ref", ref) })
        assertNull(h.engine.state.runId)
        assertEquals("Хаб ответил за другую машину — ответ отброшен.", h.engine.state.error)
        // the pendingOpen branch itself answered: the frame never reached the generic «not mine» path that unsubscribes
        assertTrue(h.sent.none { it.string("type") == "unsubscribe" })
    }
    private fun openRun(h: H) { h.engine.select(tgt); answerHistory(h); h.receive(frame("opened") { put("machineId", "m"); put("sessionId", "s"); put("runId", "r") }) }
    @Test fun `a tool request on a keyed run whose envelope is missing or damaged is dropped, never a card`() {
        val h = H(Keys().also { it.held = mapOf("m" to key) }); ready(h); openRun(h)
        val request = { put: JsonObjectBuilder.() -> Unit -> frame("tool_request") { put("runId", "r"); put("requestId", "q"); put("tool", "Bash"); putJsonObject("input") {}; put() } }
        h.receive(request {})
        assertNull(h.engine.state.approval); assertNotNull(h.engine.state.error)
        h.engine.dismissError()
        val good = env(buildJsonObject { putJsonObject("input") { put("command", "ls") } }, "a2c|tool_request|q")
        val damaged = JsonObject(good + ("c" to JsonPrimitive("AAAA" + good.string("c")!!.drop(4))))
        h.receive(request { put("e2e", damaged) })
        assertNull(h.engine.state.approval); assertNotNull(h.engine.state.error)
        h.receive(request { put("e2e", good) })
        assertEquals("ls", h.engine.state.approval!!.input.string("command"))
    }
    private fun request(vararg extra: Pair<String, JsonElement>) = frame("tool_request") { put("runId", "r"); put("requestId", "q"); put("tool", "Bash"); putJsonObject("input") {}; extra.forEach { put(it.first, it.second) } }
    @Test fun `run_active without a run list still attributes the run to the open machine`() {
        val h = H(Keys().also { it.held = mapOf("m" to key) }); ready(h); h.engine.select(tgt); answerHistory(h)
        h.receive(frame("error") { put("code", "run_active"); put("runId", "r"); put("message", "x") })
        h.engine.dismissError()
        h.receive(request())
        assertNull(h.engine.state.approval); assertNotNull(h.engine.state.error)
    }
    @Test fun `a private machine with an empty ring never shows an unreadable approval`() {
        val h = H(Keys()); ready(h); h.engine.select(tgt); answerHistory(h)
        h.receive(frame("opened") { put("machineId", "m"); put("sessionId", "s"); put("runId", "r") })
        h.receive(request())
        assertNull(h.engine.state.approval); assertNotNull(h.engine.state.error)
        h.engine.dismissError()
        h.receive(request("e2e" to env(buildJsonObject { putJsonObject("input") { put("command", "ls") } }, "a2c|tool_request|q")))
        assertNull(h.engine.state.approval)
    }
    @Test fun `forgetting the key clears subagents and background tasks too`() {
        val keys = Keys().also { it.held = mapOf("m" to key) }; val h = H(keys); ready(h); openRun(h)
        h.receive(frame("stream") { put("runId", "r"); putJsonObject("event") { put("kind", "system"); put("code", "background_tasks")
            put("e2e", env(buildJsonObject { putJsonObject("data") { putJsonArray("tasks") { add(buildJsonObject { put("id", "t"); put("description", "секретная задача") }) } } }, "a2c|stream|r")) } })
        assertTrue(h.engine.state.background.isNotEmpty())
        keys.held = emptyMap(); h.engine.keysChanged(emptySet())
        assertTrue(h.engine.state.background.isEmpty()); assertTrue(h.engine.state.subagents.isEmpty())
        assertFalse(h.engine.state.toString().contains("секретная"))
    }
    @Test fun `a clear rpc answer for a keyed machine is refused at once, a sealed one and models list pass`() {
        val h = H(Keys().also { it.held = mapOf("m" to key) }); ready(h); h.engine.select(tgt)
        // history: a clear page is a forgery
        val id = h.sent.last { it.string("type") == "rpc_request" }.string("requestId")!!
        h.receive(frame("rpc_response") { put("requestId", id); put("ok", true); putJsonObject("result") { putJsonArray("messages") { add(buildJsonObject { put("uuid", "u"); put("type", "assistant")
            putJsonArray("blocks") { add(buildJsonObject { put("kind", "text"); put("text", "ПОДДЕЛКА") }) } }) } } })
        assertTrue(h.engine.state.history.isEmpty()); assertFalse(h.engine.state.loadingHistory); assertNotNull(h.engine.state.error)
        // a pending request is rejected, not left to time out
        var failure: Throwable? = null
        val rid = h.engine.request("rpc_request", buildJsonObject { put("machineId", "m"); put("method", "fs.read"); putJsonObject("params") { put("path", "/a") } }) { failure = it.exceptionOrNull() }!!
        h.receive(frame("rpc_response") { put("requestId", rid); put("ok", true); putJsonObject("result") { put("content", "ПОДДЕЛКА") } })
        assertNotNull(failure)
        // a sealed result passes; so does models.list in the clear
        var ok: Result<JsonObject>? = null
        val rid2 = h.engine.request("rpc_request", buildJsonObject { put("machineId", "m"); put("method", "fs.read"); putJsonObject("params") { put("path", "/a") } }) { ok = it }!!
        h.receive(frame("rpc_response") { put("requestId", rid2); put("ok", true); putJsonObject("result") { put("e2e", env(buildJsonObject { put("content", "настоящее") }, "a2c|rpc|$rid2")) } })
        assertEquals("настоящее", ok!!.getOrThrow()["result"]!!.jsonObject.string("content"))
        var models: Result<JsonObject>? = null
        val rid3 = h.engine.request("rpc_request", buildJsonObject { put("machineId", "m"); put("method", "models.list"); putJsonObject("params") {} }) { models = it }!!
        h.receive(frame("rpc_response") { put("requestId", rid3); put("ok", true); putJsonObject("result") { putJsonArray("models") {} } })
        assertTrue(models!!.isSuccess)
    }
    @Test fun `a live mirror never tells the hub a private folder`() {
        val keys = Keys().also { it.held = mapOf("m" to key) }; val h = H(keys)
        h.engine.connecting(); h.engine.connected()
        h.receive(JsonObject(snapshot() + ("machines" to JsonArray(snapshot()["machines"]!!.jsonArray.map { m ->
            val o = m.jsonObject
            JsonObject(o + ("sessions" to JsonArray(listOf(JsonObject(o["sessions"]!!.jsonArray[0].jsonObject + ("livePid" to JsonPrimitive(7))))))) }))))
        h.engine.keysChanged(setOf("m")); h.engine.select(tgt)
        val mirror = h.sent.single { it.string("type") == "mirror_open" }
        assertEquals("", mirror.string("cwd")); assertFalse(mirror.toString().contains("/w/p"))
    }
    @Test fun `forgetting the key scrubs what it decrypted at once`() {
        val keys = Keys().also { it.held = mapOf("m" to key) }; val h = H(keys); ready(h); openRun(h)
        h.receive(frame("stream") { put("runId", "r"); putJsonObject("event") { put("kind", "assistant"); put("e2e", env(buildJsonObject { put("text", "тайна") }, "a2c|stream|r")) } })
        assertTrue(h.engine.state.live.any { it.text == "тайна" })
        keys.held = emptyMap(); h.engine.keysChanged(emptySet())
        val st = h.engine.state
        assertTrue(st.locked); assertTrue(st.live.isEmpty()); assertTrue(st.history.isEmpty()); assertNull(st.approval)
        assertEquals(E2ee.PLACEHOLDER, st.machines[0].sessions[0].title); assertNull(st.machines[0].sessions[0].cwd)
        assertEquals(E2ee.PLACEHOLDER, st.target!!.title); assertEquals("", st.target!!.cwd)
        assertFalse(st.toString().contains("тайна")); assertFalse(st.toString().contains("/w/p"))
    }
    @Test fun `suggestions are never asked from the hub for a private machine`() {
        val h = H(Keys().also { it.held = mapOf("m" to key) }); ready(h)
        var failure: Throwable? = null
        h.engine.request("enrich_request", buildJsonObject { put("machineId", "m"); put("text", "t") }) { failure = it.exceptionOrNull() }
        assertNotNull(failure); assertTrue(h.sent.none { it.string("type") == "enrich_request" })
    }
    @Test fun `forgetting the key locks the machine again`() {
        val keys = Keys().also { it.held = mapOf("m" to key) }; val h = H(keys); ready(h); h.engine.select(tgt)
        assertFalse(h.engine.state.locked)
        keys.held = emptyMap(); h.engine.keysChanged(emptySet())
        assertTrue(h.engine.state.locked)
    }
}
