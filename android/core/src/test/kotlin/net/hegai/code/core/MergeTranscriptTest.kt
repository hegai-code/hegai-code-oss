package net.hegai.code.core

import org.junit.Assert.*
import org.junit.Test

class MergeTranscriptTest {
    private fun line(i: Int, role: String = if (i % 2 == 0) "user" else "system") = ChatLine("h$i", role, "line $i")

    @Test fun suffixOverlapIsShownOnce() {
        val history = (0 until 10).map { line(it) }
        val live = (7 until 13).map { line(it).copy(id = "l$it") }
        assertEquals((0 until 13).map { "line $it" }, mergeTranscript(history, live).map { it.text })
    }

    @Test fun noOverlapKeepsBoth() {
        val history = listOf(line(0), line(1))
        val live = listOf(line(5).copy(id = "l5"))
        assertEquals(listOf("line 0", "line 1", "line 5"), mergeTranscript(history, live).map { it.text })
    }

    /** 0.2.2 allocated takeLast(n).zip(take(n)) for every n on every read: a long session froze the phone. */
    @Test fun longSessionMergesFastAndOncePerState() {
        val history = (0 until 2000).map { line(it) }
        val live = (0 until 2000).map { ChatLine("l$it", "system", "stream $it") }
        val state = HubState(history = history, live = live)
        val started = System.nanoTime()
        repeat(50) { mergeTranscript(history, live) }
        assertTrue("merge too slow", (System.nanoTime() - started) / 1_000_000 < 2_000)
        assertSame(state.messages, state.messages)
        assertEquals(4000, state.messages.size)
    }
}
