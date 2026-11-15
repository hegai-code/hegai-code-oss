package net.hegai.code.core

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId

/** Port of ios/CCRemoteTests/TranscriptGroupingTests.swift plus the gear/fold rules of TranscriptRows.swift. */
class TranscriptGroupingTest {
    private val moscow = ZoneId.of("Europe/Moscow")
    private fun ms(y: Int, m: Int, d: Int, h: Int, min: Int) = LocalDateTime.of(y, m, d, h, min).atZone(moscow).toInstant().toEpochMilli().toDouble()
    private val now = ms(2026, 9, 25, 15, 0).toLong()

    private fun text(t: String) = Block("text", text = t)
    private fun tool(name: String = "Read") = Block("tool_use", name = name, input = buildJsonObject { put("file_path", "/a") }, id = "t")
    private fun result(t: String = "ok") = Block("tool_result", text = t, toolUseId = "t")
    private fun user(id: String, t: String, ts: Double? = null) = HistoryMessage(id, "user", listOf(text(t)), ts)
    private fun assistant(id: String, vararg blocks: Block, ts: Double? = null) = HistoryMessage(id, "assistant", blocks.toList(), ts)
    private fun results(id: String) = HistoryMessage(id, "user", listOf(result()))

    private fun group(vararg history: HistoryMessage, busy: Boolean = false, live: List<ChatLine> = emptyList()) =
        groupTranscript(historyLines(history.toList()) + live, busy, now, moscow)
    /** "u"/"a" spoken (+ = cont, ⚙N = gear), "act" orphan, "day", "fold", "!" error, "i" notice. */
    private fun shape(items: List<TranscriptItem>) = items.map {
        when (it) {
            is SpokenItem -> (if (it.role == "user") "u" else "a") + (if (it.cont) "+" else "") + (if (it.activity.isNotEmpty()) "⚙${it.activityCount}" else "")
            is ActivityItem -> "act"
            is DayItem -> "day"
            is FoldItem -> "fold${it.hidden.size}"
            is NoticeItem -> if (it.error) "!" else "i"
        }
    }

    @Test fun `same speaker continues`() {
        assertEquals(listOf("a", "a+"), shape(group(assistant("a", text("one")), assistant("b", text("two")))))
    }
    @Test fun `user breaks the chain`() {
        assertEquals(listOf("a", "u", "a"), shape(group(assistant("a", text("one")), user("u", "hi"), assistant("b", text("two")))))
    }
    @Test fun `all machinery of an exchange hangs on its last spoken row`() {
        val items = group(user("u", "do it"), assistant("a1", text("looking"), tool()), results("r1"),
            assistant("a2", tool("Edit")), results("r2"), assistant("a3", text("done")))
        assertEquals(listOf("u", "a", "a+⚙2"), shape(items))
        val last = items.last() as SpokenItem
        assertEquals(listOf("tool_use", "tool_result", "tool_use", "tool_result"), last.activity.map { it.kind })
    }
    @Test fun `before the first answer the gear sits on the person's message`() {
        assertEquals(listOf("u⚙1"), shape(group(user("u", "go"), assistant("a", tool()), results("r"))))
    }
    @Test fun `text tools text inside one message splits and continues`() {
        val items = group(user("u", "q"), assistant("a", text("first"), tool(), text("second")))
        assertEquals(listOf("u", "a", "a+⚙1"), shape(items))
        assertEquals(listOf("u", "a", "a-p1"), items.map { it.id })
    }
    @Test fun `machinery with nothing spoken is an orphan gear`() {
        assertEquals(listOf("act", "u"), shape(group(assistant("a", tool()), results("r"), user("u", "next"))))
    }
    @Test fun `finished answer of three paragraphs folds all but the last`() {
        val items = group(user("u", "q"), assistant("a1", text("one"), tool()), assistant("a2", text("two"), tool()), assistant("a3", text("three")))
        assertEquals(listOf("u", "fold2", "a+⚙2"), shape(items))
    }
    @Test fun `the working tail turn never folds`() {
        val items = group(user("u", "q"), assistant("a1", text("one"), tool()), assistant("a2", text("two"), tool()), assistant("a3", text("three")), busy = true)
        assertEquals(listOf("u", "a", "a+", "a+⚙2"), shape(items))
    }
    @Test fun `an earlier finished turn folds even while the tail works`() {
        val items = group(user("u", "q"), assistant("a1", text("one"), tool()), assistant("a2", text("two"), tool()), assistant("a3", text("three")),
            user("u2", "more"), assistant("b", text("working")), busy = true)
        assertEquals(listOf("u", "fold2", "a+⚙2", "u", "a"), shape(items))
    }
    @Test fun `two paragraphs never fold and no activity never folds`() {
        assertEquals(listOf("u", "a", "a+⚙1"), shape(group(user("u", "q"), assistant("a1", text("one"), tool()), assistant("a2", text("two")))))
        assertEquals(listOf("u", "a", "a+", "a+"), shape(group(user("u", "q"), assistant("a1", text("1")), assistant("a2", text("2")), assistant("a3", text("3")))))
    }
    @Test fun `midnight breaks the chain and draws a divider`() {
        val items = group(assistant("a", text("late"), ts = ms(2026, 9, 23, 23, 50)), assistant("b", text("early"), ts = ms(2026, 9, 24, 0, 10)))
        assertEquals(listOf("day", "a", "day", "a"), shape(items))
        assertEquals(listOf("23 сен", "вчера"), items.filterIsInstance<DayItem>().map { it.label })
    }
    @Test fun `untimed turns merge and do not forget the day`() {
        val items = group(assistant("a", text("1"), ts = ms(2026, 9, 25, 10, 0)), assistant("b", text("2")), assistant("c", text("3"), ts = ms(2026, 9, 25, 11, 0)))
        assertEquals(listOf("day", "a", "a+", "a+"), shape(items))
        assertEquals("сегодня", (items[0] as DayItem).label)
    }
    @Test fun `system turns drop and a compaction is a quiet notice`() {
        val items = group(assistant("a", text("1")), HistoryMessage("s", "system", listOf(Block("compact_boundary"))), HistoryMessage("h", "system", listOf(text("hook"))))
        assertEquals(listOf("a", "i"), shape(items))
    }
    @Test fun `harness noise is stripped and an all-noise turn is skipped`() {
        val items = group(user("u", "<system-reminder>x</system-reminder>"), assistant("a", text("hi")))
        assertEquals(listOf("a"), shape(items))
    }
    @Test fun `codex envelopes are stripped and an emptied cached turn draws nothing`() {
        assertEquals("", stripHarnessNoise("<codex_internal_context source=\"goal\">x</codex_internal_context>\n<turn_aborted>\ny\n</turn_aborted>"))
        val cached = ChatLine("c", "user", "<goal_context>\nkeep going\n</goal_context>")
        assertEquals(listOf("a"), shape(groupTranscript(listOf(ChatLine("a0", "assistant", "hi"), cached), busy = false, now = now, zone = moscow)))
    }
    @Test fun `an empty failed result still counts as machinery`() {
        val items = group(user("u", "q"), assistant("a", tool()), HistoryMessage("r", "user", listOf(Block("tool_result", text = "", isError = true))))
        assertEquals(2, (items.single() as SpokenItem).activity.size)
    }

    // ---- live tail
    private fun line(role: String, text: String, vararg blocks: Block) = ChatLine(text.hashCode().toString() + role, role, text, blocks = blocks.toList())
    @Test fun `live tool lines between paragraphs do not break and errors do`() {
        val live = listOf(line("user", "go"), line("assistant", "a"), line("system", "Read {}", tool()),
            line("assistant", "b"), line("error", "boom"), line("assistant", "c"))
        assertEquals(listOf("u", "a", "a+⚙1", "!", "a"), shape(groupTranscript(live, busy = false, now = now, zone = moscow)))
    }
    @Test fun `old cached machinery without blocks is raw output`() {
        val items = groupTranscript(listOf(line("user", "q"), line("system", "Bash: ls")), busy = false, now = now, zone = moscow)
        val gear = (items.single() as SpokenItem).activity.single()
        assertEquals("output", gear.kind); assertEquals("Bash: ls", gear.text)
    }
    @Test fun `ids are stable while the tail grows`() {
        val one = group(user("u", "q"), assistant("a", text("x"), tool()), busy = true).map { it.id }
        val two = group(user("u", "q"), assistant("a", text("x"), tool()), results("r"), assistant("b", tool()), busy = true).map { it.id }
        assertEquals(one, two)
    }
    @Test fun `duplicate line ids never produce duplicate keys`() {
        val a = ChatLine("x", "assistant", "one"); val b = ChatLine("x", "user", "two"); val c = ChatLine("x", "assistant", "three")
        val ids = groupTranscript(listOf(a, b, c), busy = false, now = now, zone = moscow).map { it.id }
        assertEquals(ids.size, ids.toSet().size)
    }
    @Test fun `plural and effects`() {
        assertEquals(listOf("1 действие", "3 действия", "5 действий", "11 действий", "22 действия"), listOf(1, 3, 5, 11, 22).map(::actionCount))
        assertEquals(ToolEffect.READ, toolEffect("Grep")); assertEquals(ToolEffect.ACT, toolEffect("Bash")); assertEquals(ToolEffect.OTHER, toolEffect("Foo"))
    }
    @Test fun `long status folds and a plan does not`() {
        assertTrue(statusFolds("x".repeat(201))); assertTrue(statusFolds("ls\n→ completed"))
        assertFalse(statusFolds("✓ one\n○ two\n○ three\n○ four")); assertFalse(statusFolds("session resumed"))
    }

    // ---- stream vs file
    @Test fun `mid-turn history read is shown once from the stream`() {
        val history = historyLines(listOf(user("u", "q"), assistant("a", text("first"), tool())))
        val live = listOf(ChatLine("l1", "assistant", "first"), ChatLine("l2", "system", "Read {}", blocks = listOf(tool())), ChatLine("l3", "assistant", "second"))
        assertEquals(listOf("q", "first", "Read {}", "second"), HubState(history = history, live = live).messages.map { it.text })
    }
    @Test fun `our own sent turn replaces its partial copy in history`() {
        val history = historyLines(listOf(user("u0", "old"), assistant("a0", text("ok")), user("u1", "new"), assistant("a1", tool())))
        val live = listOf(ChatLine("sent", "user", "new"), ChatLine("l2", "system", "Read {}", blocks = listOf(tool())))
        assertEquals(listOf("u0", "a0", "sent", "l2"), HubState(history = history, live = live).messages.map { it.id })
    }
    @Test fun `a repeated short reply never hides the previous answer`() {
        val history = historyLines(listOf(user("u0", "да"), assistant("a0", text("Сделал X"))))
        val live = listOf(ChatLine("sent", "user", "да"))
        assertEquals(listOf("u0", "a0", "sent"), HubState(history = history, live = live).messages.map { it.id })
    }
    @Test fun `a failed turn keeps its error on screen`() {
        val history = historyLines(listOf(user("u", "q")))
        assertFalse(historyCovers(history, listOf(ChatLine("s", "user", "q"), ChatLine("e", "error", "лимит исчерпан"))))
    }
    @Test fun `history covers the stream only when every settled spoken line is in it`() {
        val history = historyLines(listOf(user("u", "q"), assistant("a", text("answer"))))
        assertTrue(historyCovers(history, listOf(ChatLine("s", "user", "q"), ChatLine("t", "system", "Read {}"), ChatLine("l", "assistant", "answer"))))
        assertFalse(historyCovers(history, listOf(ChatLine("l", "assistant", "answer"), ChatLine("m", "assistant", "later"))))
        assertFalse(historyCovers(history, listOf(ChatLine("l", "assistant", "answer", streaming = true))))
    }
}
