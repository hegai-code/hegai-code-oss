package net.hegai.code.core

import org.junit.Assert.*
import org.junit.Test
import kotlinx.serialization.json.*

class ParityTest {
    private fun login(url: String = "https://t.me/hegai_login_bot?start=login_abc") = TelegramLogin("abc", url, "hegai_login_bot", "private", "42", 1000.0, 2.0)
    @Test fun `Telegram bot links reject arbitrary intents credentials and forged hosts`() {
        assertTrue(login().valid)
        listOf("tg://resolve?domain=x", "https://t.me.evil.test/hegai_login_bot", "https://evil.test@t.me/hegai_login_bot", "http://t.me/hegai_login_bot", "https://t.me:443/hegai_login_bot", "https://t.me/other_bot", "https://t.me/hegai_login_bot#x").forEach {
            assertFalse(it, login(it).valid)
        }
        assertFalse(login().copy(match = "").valid)
        assertFalse(login().copy(interval = Double.NaN).valid)
    }
    @Test fun `Telegram only viewer and unknown identity provider remain readable`() {
        val viewer = wireJson.decodeFromString<Viewer>("""{"userId":"tg:42","telegram":"@tester"}""")
        assertNull(viewer.email); assertEquals("@tester", viewer.telegram)
        val identities = wireJson.decodeFromString<Identities>("""{"identities":[{"provider":"future","subject":"x"}],"available":{"telegram":true}}""")
        assertEquals("future", identities.identities.single().name)
    }
    @Test fun `reports accept hub aliases only and strictly validate the id`() {
        val id = "0123456789abcdef0123456789abcdef"
        assertEquals(id, ReportLink.parse("https://claude.acme.test/w/reports/$id")?.id)
        listOf("https://code.acme.test.evil.test/w/reports/$id", "https://evil@code.acme.test/w/reports/$id", "http://code.acme.test/w/reports/$id", "https://code.acme.test/w/reports/../secrets", "https://code.acme.test:444/w/reports/$id").forEach { assertNull(it, ReportLink.parse(it)) }
    }
    @Test fun `report policy precedes scripts comments and forged heads`() {
        val html = "<!DOCTYPE html><!-- <head> --><script>bad()</script><html><head></head></html>"
        val hardened = ReportLink.hardened(html)
        assertTrue(hardened.startsWith("<!DOCTYPE html><meta http-equiv="))
        assertTrue(hardened.indexOf("connect-src 'none'") < hardened.indexOf("<script>"))
        assertTrue(ReportLink.hardened("<script>bad()</script>").startsWith("<meta "))
    }
    @Test fun `report dependencies map to fixed versions and cannot carry report data`() {
        val known = "https://cdn.jsdelivr.net/npm/chart.js"
        assertEquals("https://cdn.jsdelivr.net/npm/chart.js@4.4.8/dist/chart.umd.min.js", ReportLink.asset(known))
        listOf("$known?report=private", "$known/private", "$known#private", "https://unpkg.com/private", "https://cdn.jsdelivr.net/npm/other-package").forEach { assertNull(it, ReportLink.asset(it)) }
    }
    @Test fun `session owners can set stages without machine control`() {
        val machine = Machine(MachineInfo("m", "Shared"), canControl = false)
        val state = HubState(viewer = Viewer("me"))
        assertTrue(state.canSetStage(machine, Session("s", "Mine", owner = Owner("me"))))
        assertFalse(state.canSetStage(machine, Session("s", "Other", owner = Owner("other"))))
        assertFalse(HubState().canSetStage(machine, Session("s", "No owner")))
    }
    @Test fun `replay only merges confirmed turn ids and keeps unmatched pending echoes`() {
        val replay = listOf(ChatLine("wire1", "user", "да", turnId = "first"), ChatLine("a", "assistant", "doing"), ChatLine("wire2", "user", "да", turnId = "steer"))
        val echoes = listOf(ChatLine("sent:one", "user", "да"))
        val merged = finishReplay(replay, echoes)
        assertEquals(listOf("wire1", "a", "wire2", "sent:one"), merged.map { it.id }); assertNull(merged.last().turnId)
        val attached = ChatLine("sent:two", "user", "long full text", images = listOf(ImageInput("image/png", "AA==")), turnId = "t")
        val confirmed = finishReplay(listOf(ChatLine("wire", "user", "long", imageCount = 1, turnId = "t", truncated = true)), listOf(attached)).single()
        assertEquals("long full text", confirmed.text); assertEquals("AA==", confirmed.images.single().data)
    }
    @Test fun `generated image without prose survives history and renders as a spoken row`() {
        val lines = historyLines(listOf(HistoryMessage("p", "assistant", listOf(Block("image", ref = "gen:pic", generated = true)))))
        assertEquals(1, groupTranscript(lines, false, 0).filterIsInstance<SpokenItem>().size)
        assertTrue(historyCovers(lines, listOf(ChatLine("live", "assistant", "", imageRefs = listOf("gen:pic"), imageCount = 1))))
    }
    @Test fun `bad subagent row cannot blank valid siblings`() {
        val data = wireJson.parseToJsonElement("""{"agents":[{"id":"ok","kind":"Explore","description":"Inspect","status":"running","startedAt":1000},{"id":"bad","status":"running"}]}""").jsonObject
        assertEquals(listOf("ok"), parseSubagents(data).map { it.id })
    }
    @Test fun `late dictation preserves typing and replacements`() {
        assertEquals("prefix speech typed later", insertDictation("prefix", "prefix typed later", "speech"))
        assertEquals("replaced speech", insertDictation("old", "replaced", "speech"))
        assertEquals("speech", insertDictation("", "", "speech"))
    }
    @Test fun `AI consent blocks messages and approvals but permits stopping and reading`() {
        val sent = mutableListOf<JsonObject>()
        val engine = HubEngine(send = { sent += it; true }, allowAI = { false })
        engine.connected()
        engine.receive("""{"type":"snapshot","machines":[{"machine":{"machineId":"m","name":"Test"},"online":true,"canControl":true,"sessions":[{"sessionId":"s","title":"Chat","cwd":"/work"}]}],"activeRuns":[{"runId":"r","machineId":"m","sessionId":"s","state":"working"}]}""")
        engine.select(Target("m", "/work", "s"))
        val request = sent.last().string("requestId")
        engine.receive("""{"type":"rpc_response","requestId":"$request","ok":true,"result":{"messages":[]}}""")
        engine.editDraft("private"); engine.submit(); engine.interrupt()
        assertTrue(sent.any { it.string("type") == "rpc_request" }); assertTrue(sent.any { it.string("type") == "interrupt" })
        assertFalse(sent.any { it.string("type") == "input" }); assertEquals("private", engine.state.draft)
    }
}
