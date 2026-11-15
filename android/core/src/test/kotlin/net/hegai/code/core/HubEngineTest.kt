package net.hegai.code.core

import org.junit.Test
import org.junit.AfterClass
import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.*
import kotlinx.serialization.json.*

class HubEngineTest {
    companion object {
        private val outbound = mutableListOf<JsonObject>()
        @JvmStatic @AfterClass fun exportFrames() {
            System.getProperty("hegai.frames")?.let { path ->
                Files.createDirectories(Path.of(path).parent)
                Files.writeString(Path.of(path), JsonArray(outbound).toString())
            }
        }
    }
    private class Harness {
        var time = 1000L
        var transport = true
        val sent = mutableListOf<JsonObject>()
        val engine = HubEngine(send = { if (transport) { sent += it; outbound += it; true } else false }, now = { time })
        fun receive(text: String) = engine.receive(text)
        fun ready(active: Boolean = false, live: Boolean = false, access: String = "active") {
            engine.connecting(); engine.connected()
            receive("""{"type":"snapshot","viewer":{"userId":"me","email":"me@test","access":{"state":"$access"}},"machines":[{"machine":{"machineId":"m","name":"Mac"},"owner":{"userId":"me"},"online":true,"canControl":true,"sessions":[{"sessionId":"s","title":"Chat","cwd":"/work/repo","source":"codex","lastModified":10${if(live) ",\"livePid\":123" else ""}}]}],"activeRuns":${if(active) """[{"runId":"r","machineId":"m","sessionId":"s","state":"working"}]""" else "[]"}}""")
        }
        fun select(id: String = "s") { engine.select(Target("m", "/work/repo", id, "Chat", "codex")) }
        fun history(messages: String = "[]") {
            val id = sent.last { it.string("type") == "rpc_request" }.string("requestId")
            receive("""{"type":"rpc_response","requestId":"$id","ok":true,"result":{"messages":$messages}}""")
        }
        fun opened() { receive("""{"type":"opened","machineId":"m","sessionId":"s","runId":"r"}""") }
        fun stream(kind: String, text: String) { receive(frame("stream") { put("runId","r"); put("sessionId","s"); putJsonObject("event") { put("kind", kind); put("text", text) } }.toString()) }
    }
    @Test fun `task clock uses user input timestamp rather than working phase`() {
        val h = Harness(); h.ready(active = true); h.select(); h.history(); h.opened()
        h.time = 100_000
        fun activity(stamp: Long, phase: Long) = h.receive("""{"type":"activity","runs":[{"runId":"r","machineId":"m","sessionId":"s","state":"working","since":$phase,"taskStartedAt":$stamp}]}""")
        activity(10_000, 90_000)
        assertEquals(10_000L, h.engine.state.turnStartedAt)
        activity(10_000, 95_000)
        assertEquals(10_000L, h.engine.state.turnStartedAt)
        activity(98_000, 95_000)
        assertEquals(98_000L, h.engine.state.turnStartedAt)
    }
    @Test fun `viewing never opens a writer and history uses source`() {
        val h = Harness(); h.ready(); h.select(); h.history()
        assertEquals(listOf("hello", "rpc_request"), h.sent.map { it.string("type") })
        assertEquals("codex", h.sent.last().objectValue("params")?.string("source"))
    }
    @Test fun `live editor stays readonly and never takes over`() {
        val h = Harness(); h.ready(live = true); h.select(); h.history(); h.engine.editDraft("hello"); h.engine.submit()
        assertFalse(h.engine.state.canSend)
        assertTrue(h.sent.none { it.string("type") in listOf("open","takeover","input") })
        assertEquals("hello", h.engine.state.draft)
    }
    @Test fun `failed socket enqueue keeps draft`() {
        val h = Harness(); h.ready(); h.select(); h.history(); h.engine.editDraft("hello"); h.transport = false; h.engine.submit()
        assertEquals("hello", h.engine.state.draft)
        assertTrue(h.engine.state.live.isEmpty())
    }
    @Test fun `open refusal restores draft and removes optimistic turn`() {
        val h = Harness(); h.ready(); h.select(); h.history(); h.engine.editDraft("hello"); h.engine.submit()
        assertEquals("open", h.sent.last().string("type")); assertEquals("hello", h.sent.last().string("message"))
        h.receive("""{"type":"error","code":"machine_offline","message":"offline"}""")
        assertEquals("hello", h.engine.state.draft); assertTrue(h.engine.state.live.isEmpty())
    }
    @Test fun `resume refusal after opened restores first turn`() {
        val h = Harness(); h.ready(); h.select(); h.history(); h.engine.editDraft("hello"); h.engine.submit(); h.opened()
        h.receive("""{"type":"run_status","runId":"r","sessionId":"s","state":"yielded","code":"resume_refused"}""")
        assertEquals("hello", h.engine.state.draft); assertNull(h.engine.state.runId)
    }
    @Test fun `partials replaced by assistant final without doubling`() {
        val h = Harness(); h.ready(active = true); h.select(); h.history(); h.opened()
        h.stream("partial","Hello "); h.stream("partial","world"); h.stream("assistant","Hello world"); h.stream("result", "done")
        assertEquals(listOf("Hello world"), h.engine.state.messages.map { it.text }); assertFalse(h.engine.state.busy)
    }
    @Test fun `codex assistant without partial remains visible`() {
        val h = Harness(); h.ready(active = true); h.select(); h.history(); h.opened(); h.stream("assistant","Codex answer")
        assertEquals("Codex answer", h.engine.state.messages.single().text)
    }
    @Test fun `reconnect only reloads and subscribes never replays input`() {
        val h = Harness(); h.ready(active = true); h.select(); h.history(); h.opened(); h.stream("result", "done"); h.engine.editDraft("hello"); h.engine.submit()
        assertEquals("input", h.sent.last().string("type"))
        h.engine.disconnected(); assertNotNull(h.engine.state.uncertain)
        h.sent.clear(); h.ready(active = true); h.history(); h.opened()
        assertTrue(h.sent.none { it.string("type") in listOf("input","open","new_session","takeover") })
        h.engine.recoverUncertain(); assertEquals("hello", h.engine.state.draft)
    }
    @Test fun `late history cannot leak into next session`() {
        val h = Harness(); h.ready(); h.select()
        val old = h.sent.last().string("requestId")
        h.select("another")
        h.receive("""{"type":"rpc_response","requestId":"$old","ok":true,"result":{"messages":[{"uuid":"old","type":"user","blocks":[{"kind":"text","text":"wrong session"}]}]}}""")
        assertTrue(h.engine.state.messages.isEmpty()); assertTrue(h.engine.state.loadingHistory)
    }
    @Test fun `late referenced open cannot steal focus`() {
        val h = Harness(); h.ready(active=true); h.select(); h.history()
        val old = h.sent.last().string("ref")
        h.select("another")
        h.receive("""{"type":"opened","runId":"r","machineId":"m","sessionId":"s","ref":"$old"}""")
        assertEquals("another", h.engine.state.target?.sessionId); assertNull(h.engine.state.runId)
        assertEquals("unsubscribe",h.sent.last().string("type"))
    }
    @Test fun `access revoked clears all private client data`() {
        val h = Harness(); h.ready(); h.select(); h.history(); h.engine.editDraft("private")
        h.ready(access="suspended")
        assertFalse(h.engine.state.activeAccess); assertTrue(h.engine.state.machines.isEmpty()); assertTrue(h.engine.state.drafts.isEmpty()); assertNull(h.engine.state.target)
    }
    @Test fun `tool resolved on another client dismisses approval`() {
        val h = Harness(); h.ready(active=true); h.select(); h.history(); h.opened()
        h.receive("""{"type":"tool_request","runId":"r","sessionId":"s","requestId":"q","tool":"Bash","input":{"command":"pwd"}}""")
        assertNotNull(h.engine.state.approval)
        h.receive("""{"type":"tool_resolved","runId":"r","requestId":"q"}""")
        assertNull(h.engine.state.approval)
    }
    @Test fun `question answers use updatedInput and preserve question payload`() {
        val h=Harness();h.ready(active=true);h.select();h.history();h.opened()
        h.receive("""{"type":"tool_request","runId":"r","sessionId":"s","requestId":"q","tool":"AskUserQuestion","input":{"questions":[{"question":"Which?","options":[{"label":"A"}]}]}}""")
        h.engine.decide(true,mapOf("Which?" to "A"))
        val sent=h.sent.last();assertEquals("tool_decision",sent.string("type"))
        assertEquals("A",sent.objectValue("updatedInput")?.objectValue("answers")?.string("Which?"))
        assertNotNull(sent.objectValue("updatedInput")?.get("questions"))
    }
    @Test fun `history and outgoing timeouts release UI without resending`() {
        val h=Harness();h.ready();h.select();h.time+=31_000;h.engine.tick()
        assertFalse(h.engine.state.loadingHistory)
        h.engine.editDraft("hello");h.engine.submit();h.time+=31_000;h.engine.tick()
        assertFalse(h.engine.state.opening);assertNotNull(h.engine.state.uncertain)
        assertEquals(1,h.sent.count { it.string("type")=="open" })
    }
    @Test fun `owner rules do not attribute shared unowned sessions to machine owner`() {
        val m=Machine(MachineInfo("m","Mac"),owner=Owner("me"),shared=true)
        val s=Session("s","Chat")
        val state=HubState(viewer=Viewer("me","me@test"))
        assertFalse(state.isMine(m,s));assertTrue(state.isMine(m.copy(shared=false),s));assertFalse(state.isMine(m.copy(shared=false),s.copy(owner=Owner("other"))))
    }
    @Test fun `replay dedupe compares only overlapping suffix`() {
        val a=ChatLine("1","assistant","hello");val b=ChatLine("2","user","again")
        assertEquals(listOf(a,b,a.copy(id="3")),HubState(history=listOf(a,b),live=listOf(a.copy(id="3"))).messages)
        assertEquals(listOf(a,b),HubState(history=listOf(a,b),live=listOf(b.copy(id="4"))).messages)
    }
    @Test fun `history request keeps subscription and events received in flight`() {
        val h=Harness();h.ready(active=true);h.select();h.opened()
        assertEquals(listOf("hello","subscribe","rpc_request"), h.sent.map { it.string("type") })
        h.stream("assistant","Finished during history read")
        h.stream("result","done");h.history()
        assertEquals("Finished during history read",h.engine.state.messages.single().text)
    }
    @Test fun `new session recovers permanent id after disconnect before session started`() {
        val h=Harness();h.ready();h.engine.select(Target("m","/work/repo",source="codex"))
        h.engine.editDraft("start");h.engine.submit()
        assertEquals("new_session",h.sent.last().string("type"))
        h.receive("""{"type":"opened","machineId":"m","sessionId":"","runId":"r"}""")
        h.engine.disconnected();h.ready(active=true)
        assertEquals("s",h.engine.state.target?.sessionId)
        assertTrue(h.sent.any { it.string("type")=="subscribe" })
        assertEquals("m:s",h.engine.state.uncertain?.key)
    }
    @Test fun `stream does not confirm input but newly recorded user message does`() {
        val h=Harness();h.ready(active=true);h.select();h.history();h.opened();h.stream("result","done")
        h.engine.editDraft("new input");h.engine.submit();h.stream("partial","old output")
        assertNotNull(h.engine.state.pending)
        h.time+=6000;h.engine.tick()
        h.history("""[{"uuid":"fresh","type":"user","blocks":[{"kind":"text","text":"new input"}]}]""")
        assertNull(h.engine.state.pending)
    }
    @Test fun `an unconfirmed send clears itself once history shows the message`() {
        val h=Harness();h.ready(active=true);h.select();h.history();h.opened();h.stream("result","done")
        h.engine.editDraft("sent while leaving");h.engine.submit();h.engine.disconnected()
        assertNotNull(h.engine.state.uncertain)
        h.ready(active=true);h.history("""[{"uuid":"other","type":"user","blocks":[{"kind":"text","text":"something else"}]}]""")
        assertNotNull("a different message does not answer the question", h.engine.state.uncertain)
        h.engine.refresh();h.history("""[{"uuid":"fresh","type":"user","blocks":[{"kind":"text","text":"sent while leaving"}]}]""")
        assertNull(h.engine.state.uncertain)
        assertEquals("never re-sent", 1, h.sent.count { it.string("type") == "input" })
    }
    @Test fun `a finished turn re-reads history quietly and drops the superseded stream`() {
        val h=Harness();h.ready(active=true);h.select();h.history();h.opened()
        h.stream("assistant","done it");h.stream("tool_use","Read {\"file_path\":\"/a\"}")
        val tool=h.engine.state.live.last(); assertEquals("system", tool.role); assertEquals("Read", tool.blocks.single().name)
        h.stream("result","done")
        assertFalse("a convergence read never locks the composer", h.engine.state.loadingHistory)
        h.history("""[{"uuid":"a","type":"assistant","blocks":[{"kind":"text","text":"done it"},{"kind":"tool_use","id":"t","name":"Read","input":{}}]}]""")
        assertTrue(h.engine.state.live.isEmpty()); assertEquals(listOf("a"), h.engine.state.messages.map { it.id })
    }
    @Test fun `a stale history read cannot confirm a repeated message with an earlier copy`() {
        val h=Harness();h.ready(active=true);h.select();h.history();h.opened();h.stream("result","done")
        h.history("""[{"uuid":"n","type":"user","blocks":[{"kind":"text","text":"да"}]}]""")
        h.engine.editDraft("да");h.engine.submit()
        h.time+=6000;h.engine.tick()
        h.history("""[{"uuid":"n","type":"user","blocks":[{"kind":"text","text":"да"}]}]""")
        assertNotNull("the earlier «да» is not this one", h.engine.state.pending)
        h.time+=1000;h.engine.tick()
        h.history("""[{"uuid":"n","type":"user","blocks":[{"kind":"text","text":"да"}]},{"uuid":"n1","type":"user","blocks":[{"kind":"text","text":"да"}]}]""")
        assertNull(h.engine.state.pending)
    }
    @Test fun `a turn ending during a history read converges with one more read`() {
        val h=Harness();h.ready(active=true);h.select();h.opened()
        h.stream("assistant","final words"); h.stream("result","done")
        val before=h.sent.count { it.string("type")=="rpc_request" }
        h.history()
        assertEquals(before + 1, h.sent.count { it.string("type")=="rpc_request" })
        h.history("""[{"uuid":"a","type":"assistant","blocks":[{"kind":"text","text":"final words"}]}]""")
        assertTrue(h.engine.state.live.isEmpty())
    }
    @Test fun `pending survives process restoration without automatic delivery`() {
        val h=Harness();h.ready();h.select();h.history();h.engine.editDraft("keep me");h.engine.submit()
        val persisted=wireJson.encodeToString(Submission.serializer(),h.engine.state.pending!!)
        val restored=Harness();restored.engine.restoreOutgoing(wireJson.decodeFromString(Submission.serializer(),persisted))
        restored.ready();restored.select();restored.history()
        assertEquals("keep me",restored.engine.state.uncertain?.text)
        assertTrue(restored.sent.none { it.string("type")=="open" })
    }
    @Test fun `working run accepts steering input without starting another writer`() {
        val h=Harness();h.ready(active=true);h.select();h.history();h.opened();h.engine.editDraft("later");h.engine.submit();h.engine.interrupt()
        assertEquals("",h.engine.state.draft);assertEquals("interrupt",h.sent.last().string("type"))
        assertEquals(1,h.sent.count { it.string("type")=="input" })
        assertFalse(h.sent.any { it.string("type") in listOf("open", "takeover") })
    }
    @Test fun `new run can resubscribe before it has a permanent session id`() {
        val h=Harness();h.ready();h.engine.select(Target("m","/work/repo"));h.engine.editDraft("start");h.engine.submit()
        h.receive("""{"type":"opened","machineId":"m","sessionId":"","runId":"r"}""")
        h.engine.disconnected();h.engine.connected()
        h.receive("""{"type":"snapshot","viewer":{"userId":"me","email":"me@test","access":{"state":"active"}},"machines":[],"activeRuns":[{"runId":"r","machineId":"m","sessionId":"","state":"working"}]}""")
        assertEquals("subscribe",h.sent.last().string("type"))
        h.receive("""{"type":"session_started","runId":"r","sessionId":"permanent"}""")
        assertEquals("permanent",h.engine.state.target?.sessionId)
    }
    @Test fun `sign out is atomic and never republishes old account drafts`() {
        val observed=mutableListOf<HubState>()
        val engine=HubEngine(send={true},changed={observed+=it})
        engine.select(Target("m","/work/repo"));engine.editDraft("secret")
        observed.clear();engine.signOut()
        assertEquals(listOf(HubState()),observed)
    }
    @Test fun `unknown future fields and kinds do not break frame decoding`() {
        val h=Harness();h.ready();h.receive("""{"type":"future_message","value":42}""")
        assertNull(h.engine.state.error)
    }

    @Test fun `image only turn is confirmed through canonical image ref history`() {
        val h = Harness(); h.ready(); h.select(); h.history()
        h.engine.addImages(listOf(ImageInput("image/png", "YQ=="))); h.engine.submit(); h.opened()
        assertEquals("", h.engine.state.pending?.text)
        h.time += 6000; h.engine.tick()
        h.history("""[{"uuid":"photo","type":"user","blocks":[{"kind":"image","ref":"image-1"}]}]""")
        assertNull(h.engine.state.pending)
        assertEquals("user", h.engine.state.history.single().role)
        assertEquals("", h.engine.state.history.single().text)
        assertEquals(listOf("image-1"), h.engine.state.history.single().imageRefs)
    }
    @Test fun `explicit takeover closes mirror and ignores its late replacement`() {
        val h = Harness(); h.ready(live = true); h.select(); h.history()
        val mirror = h.sent.first { it.string("type") == "mirror_open" }.string("mirrorId")
        h.engine.editDraft("continue"); h.engine.submit(takeover = true)
        assertEquals("takeover", h.sent.last().string("type")); h.opened()
        assertEquals("mirror_close", h.sent.last().string("type"))
        h.stream("assistant", "new reply")
        h.receive("""{"type":"mirror_data","mirrorId":"$mirror","replace":true,"messages":[]}""")
        assertEquals("new reply", h.engine.state.live.last().text)
    }
    @Test fun `generic rpc timeout and disconnect reject exactly once`() {
        val h = Harness(); h.ready(); val outcomes = mutableListOf<Result<JsonObject>>()
        val id = h.engine.request("rpc_request", buildJsonObject {
            put("machineId", "m"); put("method", "projects.list"); put("params", buildJsonObject {})
        }) { outcomes += it }
        h.time += 31_000; h.engine.tick(); h.engine.disconnected()
        h.receive("""{"type":"rpc_response","requestId":"$id","ok":true,"result":{}}""")
        assertEquals(1, outcomes.size); assertTrue(outcomes.single().isFailure)
    }
    @Test fun `correlated memory requests and run settings follow canonical shapes`() {
        val h = Harness(); h.ready(active = true); h.select(); h.history(); h.opened()
        h.engine.setOptions(RunOptions("gpt-5.5", "high", "plan")); h.engine.compact()
        h.receive("""{"type":"run_settings","runId":"r","sessionId":"s","model":"gpt-5.5","activeModel":"gpt-5.5","effort":"high","activeEffort":"max"}""")
        assertEquals("max", h.engine.state.runSettings?.string("activeEffort"))
        listOf("memory_list", "memory_read", "memory_delete").forEach { type ->
            val body = buildJsonObject { if (type != "memory_list") { put("scope", "project"); put("scopeKey", "repo"); put("path", "note.md") } }
            h.engine.request(type, body) {}
        }
        h.engine.request("enrich_request", buildJsonObject { put("machineId", "m"); put("sessionId", "s"); put("uuid", "reply"); put("text", "Next?") }) {}
        h.engine.command("register_push", buildJsonObject { put("deviceToken", "test-fcm"); put("platform", "android") })
        h.engine.command("unregister_push", buildJsonObject { put("deviceToken", "test-fcm"); put("platform", "android") })
        h.engine.endSession()
        assertTrue(h.sent.any { it.string("type") == "end_session" })
    }
    @Test fun `new session options and images survive a rejection`() {
        val h = Harness(); h.ready(); h.engine.select(Target("m", "/work/repo"))
        h.engine.setOptions(RunOptions("claude-opus-5-5", "high", "plan"))
        val photo = ImageInput("image/jpeg", "YQ==")
        h.engine.addImages(listOf(photo)); h.engine.editDraft("inspect"); h.engine.submit()
        val frame = h.sent.last(); assertEquals("plan", frame.string("permissionMode")); assertNotNull(frame["images"])
        h.receive("""{"type":"error","message":"rejected"}""")
        assertEquals("inspect", h.engine.state.draft); assertEquals(listOf(photo), h.engine.state.images)
    }
    @Test fun `checkpoint failure prevents network mutation`() {
        val sent = mutableListOf<JsonObject>()
        var allow = true
        val engine = HubEngine(send = { sent += it; true }, checkpoint = { allow })
        engine.connected(); engine.receive("""{"type":"snapshot","machines":[{"machine":{"machineId":"m","name":"Mac"},"online":true,"canControl":true}]}""")
        engine.select(Target("m", "/work/repo")); engine.editDraft("must survive")
        allow = false; engine.submit()
        assertTrue(sent.none { it.string("type") == "new_session" }); assertEquals("must survive", engine.state.draft)
    }
    @Test fun `offline cache can be read without making a writer`() {
        val h = Harness(); val target = Target("m", "/work/repo", "s")
        val line = ChatLine("m1", "assistant", "cached reply")
        h.engine.restoreOffline(Viewer("me", "me@test"), AccountCache(target = target,
            conversations = mapOf(target.key to ConversationCache(target, listOf(line)))))
        assertEquals("cached reply", h.engine.state.messages.single().text)
        h.engine.editDraft("offline draft"); h.engine.submit(); assertTrue(h.sent.isEmpty())
    }
    @Test fun `recovery preserves both outgoing and newly attached images over limit`() {
        val h = Harness(); h.ready(); h.select(); h.history()
        val old = List(4) { ImageInput("image/png", "YQ==") }
        h.engine.addImages(old); h.engine.submit(); h.opened()
        val fresh = ImageInput("image/png", "Yg==")
        h.engine.addImages(listOf(fresh)); h.engine.disconnected(); h.engine.recoverUncertain()
        assertEquals(old, h.engine.state.uncertain?.images)
        assertEquals(listOf(fresh), h.engine.state.images)
        h.engine.removeImage(0); h.engine.recoverUncertain()
        assertNull(h.engine.state.uncertain); assertEquals(old, h.engine.state.images)
    }
    @Test fun `snapshot changing workspace cannot carry offline drafts or history`() {
        val h = Harness(); val target = Target("m", "/work/repo", "s")
        val viewer = wireJson.decodeFromJsonElement<Viewer>(buildJsonObject {
            put("userId", "me"); put("email", "me@test")
            putJsonObject("workspace") { put("workspaceId", "old"); put("name", "Old"); put("kind", "personal"); put("role", "owner") }
        })
        h.engine.restoreOffline(viewer, AccountCache(target = target, drafts = mapOf(target.key to "private")))
        h.ready()
        assertTrue(h.engine.state.drafts.isEmpty()); assertNull(h.engine.state.target)
    }
    @Test fun `share import uses captured target even when another session is selected`() {
        val h = Harness(); h.ready(); h.select(); h.history()
        val target = h.engine.state.target!!
        h.select("other")
        assertTrue(h.engine.importShare(target.key, "shared", listOf(ImageInput("image/png", "YQ=="))))
        assertEquals("shared", h.engine.state.drafts[target.key]); assertEquals("", h.engine.state.draft)
        assertEquals(1, h.engine.state.attachments[target.key]?.size); assertTrue(h.engine.state.images.isEmpty())
    }
    @Test fun `question sends stable keys arrays and plan sends selected permission mode`() {
        val h = Harness(); h.ready(active = true); h.select(); h.history(); h.opened()
        h.receive("""{"type":"tool_request","runId":"r","requestId":"q","tool":"AskUserQuestion","input":{"questions":[{"id":"pick","question":"Choose","multiSelect":true,"options":[{"label":"A"},{"label":"B"}]}]}}""")
        h.engine.decideStructured(true, buildJsonObject { put("pick", JsonArray(listOf(JsonPrimitive("A"), JsonPrimitive("B")))) })
        assertEquals(2, h.sent.last().objectValue("updatedInput")?.objectValue("answers")?.get("pick")?.jsonArray?.size)
        h.receive("""{"type":"tool_request","runId":"r","requestId":"plan","tool":"ExitPlanMode","input":{"plan":"Do this"}}""")
        h.engine.decideStructured(true, permissionMode = "acceptEdits")
        assertEquals("acceptEdits", h.sent.last().string("permissionMode"))
    }

    @Test fun `first activity transition after snapshot notifies only its owner`() {
        val h = Harness(); h.ready()
        h.receive("""{"type":"snapshot","viewer":{"userId":"me","email":"me@test"},"machines":[],"activeRuns":[{"runId":"a","machineId":"m","sessionId":"a","state":"working","ownerUserId":"me"}]}""")
        h.receive("""{"type":"activity","runs":[{"runId":"a","machineId":"m","sessionId":"a","state":"idle","ownerUserId":"me"},{"runId":"b","machineId":"m","sessionId":"b","state":"error","ownerUserId":"other"}]}""")
        assertEquals(1, h.engine.state.notices.size)
        assertEquals("a", h.engine.state.notices.single().run.runId)
        h.engine.markNoticesRead(); assertFalse(h.engine.state.notices.single().unread)
    }

    @Test fun `session patches replace entire entries remove stale pids and sort`() {
        val h = Harness(); h.ready(live = true); h.select(); h.history()
        h.receive("""{"type":"session_updates","machineId":"m","sessions":[{"sessionId":"s","title":"Updated","cwd":"/work/repo","source":"codex","lastModified":20},{"sessionId":"new","title":"New","lastModified":30}]}""")
        assertEquals(listOf("new", "s"), h.engine.state.machines.single().sessions.map { it.sessionId })
        assertNull(h.engine.state.session?.livePid)
        h.receive("""{"type":"session_updates","machineId":"m","sessions":[],"removed":["s"]}""")
        assertNull(h.engine.state.session)
    }
    @Test fun `machine delta adds a new machine without changing viewer or runs`() {
        val h = Harness(); h.ready(active = true)
        h.receive("""{"type":"machine_sessions","machine":{"machine":{"machineId":"second","name":"Second"},"online":true,"sessions":[]}}""")
        assertEquals(listOf("m", "second"), h.engine.state.machines.map { it.machine.machineId })
        assertEquals("me", h.engine.state.viewer?.userId); assertEquals("r", h.engine.state.runs.single().runId)
    }
    @Test fun `remote user turns retain ordering and duplicate turn ids are ignored`() {
        val h = Harness(); h.ready(active = true); h.select(); h.history(); h.opened()
        val turn = """{"type":"user_turn","runId":"r","sessionId":"s","turnId":"t","text":"from desktop","images":2,"ts":1000}"""
        h.receive(turn); h.stream("assistant", "answer"); h.receive(turn)
        assertEquals(listOf("from desktop", "answer"), h.engine.state.messages.map { it.text })
        assertEquals(2, h.engine.state.messages.first().imageCount)
        h.receive(turn.replace("\"r\"", "\"other\"")); assertEquals(2, h.engine.state.messages.size)
    }
    @Test fun `hub acceptance keeps full local text and attachment bytes`() {
        val h = Harness(); h.ready(active = true); h.select(); h.history(); h.opened()
        h.engine.editDraft("a long message"); h.engine.addImages(listOf(ImageInput("image/png", "AA=="))); h.engine.submit()
        h.receive("""{"type":"user_turn","runId":"r","sessionId":"s","turnId":"ours","ref":"${h.engine.state.pending!!.ref}","text":"a long","truncated":true,"images":1}""")
        assertNull(h.engine.state.pending); assertEquals("a long message", h.engine.state.live.single().text)
        assertEquals("AA==", h.engine.state.live.single().images.single().data)
    }
    @Test fun `continue and quick reply preserve an unrelated draft and images`() {
        val h = Harness(); h.ready(active = true); h.select(); h.history(); h.opened(); h.stream("assistant", "done"); h.stream("result", "")
        h.history(); h.engine.editDraft("my next question"); h.engine.addImages(listOf(ImageInput("image/png", "AA==")))
        h.engine.continueTurn()
        assertEquals("Продолжай", h.sent.last().string("text")); assertNull(h.sent.last()["images"])
        assertEquals("my next question", h.engine.state.draft); assertEquals(1, h.engine.state.images.size)
        h.receive("""{"type":"error","code":"rejected","message":"no"}""")
        assertEquals("my next question", h.engine.state.draft); assertEquals(1, h.engine.state.images.size)
        h.engine.submit(continuation = true); assertTrue(h.engine.state.pending?.continuation == true)
        h.engine.disconnected(); h.engine.recoverUncertain()
        assertNull(h.engine.state.uncertain); assertEquals("my next question", h.engine.state.draft)
    }
    @Test fun `input during replay matches its authoritative ack and preserves full text`() {
        val h = Harness(); h.ready(active = true); h.select(); h.history(); h.opened()
        h.stream("assistant", "old partial"); h.opened()
        h.engine.editDraft("new full steer"); h.engine.submit()
        h.receive("""{"type":"user_turn","runId":"r","sessionId":"s","turnId":"new-turn","ref":"${h.engine.state.pending!!.ref}","text":"new full","truncated":true,"images":0}""")
        assertNull(h.engine.state.pending)
        h.time += 200; h.engine.tick()
        assertEquals("new full steer", h.engine.state.live.single().text)
        assertEquals("new-turn", h.engine.state.live.single().turnId)
    }
    @Test fun `old identical replay echo cannot acknowledge a newer send`() {
        val h = Harness(); h.ready(active = true); h.select(); h.history(); h.opened()
        h.engine.editDraft("yes"); h.engine.submit()
        h.stream("partial", "still working"); h.engine.refresh()
        h.history("""[{"uuid":"old","type":"user","blocks":[{"kind":"text","text":"yes"}]}]""")
        assertNull(h.engine.state.pending)
        h.opened(); h.engine.editDraft("yes"); h.engine.submit()
        val current = h.engine.state.pending!!
        h.receive("""{"type":"user_turn","runId":"r","sessionId":"s","turnId":"old-turn","text":"yes","images":0}""")
        assertEquals(current, h.engine.state.pending)
        h.engine.disconnected()
        assertEquals(current, h.engine.state.uncertain)
        assertNull(wireJson.decodeFromString<Submission>("""{"key":"m:s","text":"legacy","ref":"r","deadline":1}""").echoId)
    }
    @Test fun `stale identical replay never acknowledges or consumes a fresh echo`() {
        val h = Harness(); h.ready(active = true); h.select(); h.history(); h.opened()
        h.engine.editDraft("repeat"); h.engine.addImages(listOf(ImageInput("image/png", "NEW="))); h.engine.submit()
        val pending = h.engine.state.pending!!
        h.receive("""{"type":"user_turn","runId":"r","sessionId":"s","turnId":"older","text":"repeat","images":1}""")
        assertEquals(pending, h.engine.state.pending)
        assertNull(h.engine.state.live.first { it.id == pending.echoId }.turnId)
    }
    @Test fun `identical replay in either order cannot steal bytes or acceptance from a send`() {
        for (ackFirst in listOf(false, true)) {
            val h = Harness(); h.ready(active = true); h.select(); h.history(); h.opened()
            val paneRef = h.sent.first { it.string("type") == "subscribe" }.string("ref")!!
            h.stream("partial", "old work"); h.opened()
            h.engine.editDraft("same"); h.engine.addImages(listOf(ImageInput("image/png", "NEW="))); h.engine.submit()
            val pending = h.engine.state.pending!!
            val old = """{"type":"user_turn","runId":"r","sessionId":"s","turnId":"old","ref":"$paneRef","text":"same","images":1}"""
            val ack = """{"type":"user_turn","runId":"r","sessionId":"s","turnId":"new","ref":"${pending.ref}","text":"same","images":1}"""
            if (ackFirst) { h.receive(ack); h.receive(old) }
            else { h.receive(old); assertEquals(pending, h.engine.state.pending); h.time += 200; h.engine.tick(); h.receive(ack) }
            h.time += 200; h.engine.tick()
            assertNull(h.engine.state.pending)
            assertEquals(2, h.engine.state.live.size)
            assertEquals("NEW=", h.engine.state.live.single { it.turnId == "new" }.images.single().data)
            assertTrue(h.engine.state.live.single { it.turnId == "old" }.images.isEmpty())
        }
    }
    @Test fun `each submission uses a fresh ref and stale replies after navigation are ignored`() {
        val h = Harness(); h.ready(active = true); h.select(); h.history(); h.opened()
        h.engine.editDraft("same"); h.engine.submit(); val first = h.engine.state.pending!!
        h.receive("""{"type":"user_turn","runId":"r","sessionId":"s","turnId":"one","ref":"${first.ref}","text":"same"}""")
        h.engine.editDraft("same"); h.engine.submit(); val second = h.engine.state.pending!!
        assertNotEquals(first.ref, second.ref)
        h.receive("""{"type":"error","ref":"${first.ref}","message":"late error"}""")
        assertEquals(second, h.engine.state.pending); assertNull(h.engine.state.error)
        h.receive("""{"type":"error","ref":"${second.ref}","message":"current rejection"}""")
        assertNull(h.engine.state.pending); assertEquals("same", h.engine.state.draft)
        h.select("another"); h.history()
        h.receive("""{"type":"opened","runId":"r","machineId":"m","sessionId":"s","ref":"${second.ref}"}""")
        assertNull(h.engine.state.runId); assertEquals("unsubscribe", h.sent.last().string("type"))
    }
    @Test fun `fresh ref acknowledges open takeover and idless new session`() {
        for (type in listOf("open", "takeover", "new_session")) {
            val h = Harness(); h.ready(live = type == "takeover")
            if (type == "new_session") h.engine.select(Target("m", "/work/repo")) else { h.select(); h.history() }
            h.engine.editDraft("start"); h.engine.submit(takeover = type == "takeover")
            val pending = h.engine.state.pending!!; assertEquals(type, h.sent.last().string("type"))
            val session = if (type == "new_session") "" else "s"
            h.receive("""{"type":"opened","machineId":"m","sessionId":"$session","runId":"r","ref":"${pending.ref}"}""")
            h.receive("""{"type":"user_turn","runId":"r","sessionId":"$session","turnId":"fresh","ref":"${pending.ref}","text":"start"}""")
            assertNull(h.engine.state.pending); assertEquals("fresh", h.engine.state.live.single().turnId)
            // The same command's trailing direct activity frame must survive its acceptance.
            h.receive("""{"type":"activity","ref":"${pending.ref}","runs":[{"runId":"r","machineId":"m","sessionId":"$session","state":"working"}]}""")
            assertTrue(h.engine.state.busy)
        }
    }
    @Test fun `legacy outgoing cache never trusts the pane ref as acceptance`() {
        val h = Harness(); h.ready(active = true); h.select(); h.history(); h.opened()
        val paneRef = h.sent.first { it.string("type") == "subscribe" }.string("ref")!!
        val legacy = wireJson.decodeFromString<Submission>("""{"key":"m:s","text":"same","ref":"$paneRef","deadline":1,"echoId":"sent:legacy"}""")
        assertFalse(legacy.correlated); h.engine.restoreOutgoing(legacy)
        h.receive("""{"type":"user_turn","runId":"r","sessionId":"s","turnId":"old","ref":"$paneRef","text":"same"}""")
        assertEquals(legacy, h.engine.state.uncertain)
    }
    @Test fun `dropped image cannot be acknowledged as delivered with its text`() {
        val h = Harness(); h.ready(active = true); h.select(); h.history(); h.opened()
        val image = ImageInput("image/png", "recoverable")
        h.engine.editDraft("keep image"); h.engine.addImages(listOf(image)); h.engine.submit()
        val pending = h.engine.state.pending!!
        h.receive("""{"type":"error","ref":"${pending.ref}","code":"attachments_dropped","message":"Image was dropped"}""")
        h.receive("""{"type":"user_turn","runId":"r","sessionId":"s","turnId":"text-only","ref":"${pending.ref}","text":"keep image","images":0}""")
        assertEquals(pending, h.engine.state.pending); assertEquals("Image was dropped", h.engine.state.error)
        h.time += 31_000; h.engine.tick(); h.engine.recoverUncertain()
        assertEquals(listOf(image), h.engine.state.images); assertEquals("keep image", h.engine.state.draft)
    }
    @Test fun `dropped image warning cannot detach a newly created idless run`() {
        val h = Harness(); h.ready(); h.engine.select(Target("m", "/work/repo", source = "codex"))
        h.engine.editDraft("keep new chat"); h.engine.addImages(listOf(ImageInput("image/png", "recoverable"))); h.engine.submit()
        val pending = h.engine.state.pending!!
        h.receive("""{"type":"error","ref":"${pending.ref}","code":"attachments_dropped","message":"Image was dropped"}""")
        assertTrue(h.engine.state.opening)
        h.receive("""{"type":"opened","machineId":"m","sessionId":"","runId":"r","ref":"${pending.ref}"}""")
        h.receive("""{"type":"user_turn","runId":"r","sessionId":"","turnId":"text-only","ref":"${pending.ref}","text":"keep new chat"}""")
        assertEquals("r", h.engine.state.runId); assertFalse(h.engine.state.opening)
        assertEquals(pending, h.engine.state.pending); assertEquals("Image was dropped", h.engine.state.error)
        assertTrue(h.sent.none { it.string("type") == "unsubscribe" })
        h.receive("""{"type":"session_started","runId":"r","sessionId":"created"}""")
        assertEquals("created", h.engine.state.target?.sessionId); assertEquals("m:created", h.engine.state.pending?.key)
    }
    @Test fun `session idle with background tasks stays busy until result`() {
        val h = Harness(); h.ready(active = true); h.select(); h.history(); h.opened()
        h.receive("""{"type":"stream","runId":"r","event":{"kind":"status","code":"background_tasks","data":{"tasks":[{"id":"bg","description":"build","since":1000}]}}}""")
        h.receive("""{"type":"stream","runId":"r","event":{"kind":"status","code":"session_state","data":{"state":"idle"}}}""")
        assertTrue(h.engine.state.busy); assertTrue(h.engine.state.turnIdle); assertFalse(h.engine.state.turnFinished)
        h.stream("result", ""); assertFalse(h.engine.state.busy); assertTrue(h.engine.state.turnFinished)
    }
    @Test fun `compaction stays pending until explicit done or timeout`() {
        val h = Harness(); h.ready(active = true); h.select(); h.history(); h.opened(); h.stream("result", ""); h.history()
        h.engine.compact(); assertEquals("requested", h.engine.state.compaction); assertFalse(h.engine.state.canSend)
        h.receive("""{"type":"stream","runId":"r","event":{"kind":"status","code":"compact_started"}}""")
        h.time += 120_000; h.engine.tick(); assertEquals("running", h.engine.state.compaction)
        h.receive("""{"type":"stream","runId":"r","event":{"kind":"status","code":"compact_done"}}""")
        assertEquals("completed", h.engine.state.compaction); assertTrue(h.engine.state.canSend)
    }
    @Test fun `generated picture updates one row and cannot regress to started`() {
        val h = Harness(); h.ready(active = true); h.select(); h.history(); h.opened()
        fun image(status: String) = h.receive("""{"type":"stream","runId":"r","event":{"kind":"status","code":"image_gen","data":{"id":"pic","state":"$status","ref":"gen:pic"}}}""")
        image("started"); image("done"); image("started")
        assertEquals(1, h.engine.state.live.size); assertEquals("done", h.engine.state.live.single().generation?.state)
        assertFalse(historyCovers(emptyList(), h.engine.state.live))
        assertEquals(1, groupTranscript(h.engine.state.live, false, 0).filterIsInstance<SpokenItem>().size)
    }
    @Test fun `read marks are monotonic shared and visible marks are throttled`() {
        val h = Harness(); h.ready(active = true); h.select(); h.history(); h.opened()
        h.receive("""{"type":"activity","runs":[{"runId":"r","machineId":"m","sessionId":"s","ownerUserId":"me","state":"idle","since":1000}]}""")
        assertTrue(h.engine.state.unread("m", "s"))
        h.engine.markVisible(); h.engine.markVisible(); assertEquals(1, h.sent.count { it.string("type") == "session_read" })
        h.receive("""{"type":"session_reads","reads":[{"machineId":"m","sessionId":"s","at":2000}]}""")
        h.receive("""{"type":"session_reads","reads":[{"machineId":"m","sessionId":"s","at":500}]}""")
        assertFalse(h.engine.state.unread("m", "s"))
        h.engine.statsInterest(true); h.engine.statsInterest(false); h.engine.setStage("m", "s", "testing"); h.engine.setStage("m", "s", null)
        h.receive("""{"type":"session_stage","machineId":"m","sessionId":"s","stage":"testing"}"""); assertEquals("testing", h.engine.state.session?.stage)
        h.receive("""{"type":"session_stage","machineId":"m","sessionId":"s"}"""); assertNull(h.engine.state.session?.stage)
    }
}
