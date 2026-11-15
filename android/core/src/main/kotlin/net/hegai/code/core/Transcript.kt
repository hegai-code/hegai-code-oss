package net.hegai.code.core

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit

/**
 * The transcript as ONE document — port of `groupHistory` / `groupLive` / `transcriptRows` /
 * `foldProgress` (ios/CCRemote/Features/Render/TranscriptGrouping.swift, TranscriptRows.swift),
 * themselves ports of web/src/render/Blocks.tsx.
 *
 * Between any two pieces of prose EVERYTHING mechanical (tool calls, their results, thinking,
 * long command output) folds away, however many messages it spans. All of an exchange's machinery
 * hangs on the LAST spoken row of that exchange as a gear «⚙ N»: the anchor moves down as the
 * answer grows, and before the first assistant word it sits on the person's own message.
 * After a turn finishes, an answer of three or more paragraphs keeps only the last one open;
 * the earlier ones fold into «Ход работы · N».
 */
sealed interface TranscriptItem { val id: String }

/** A spoken row. `cont` = the same speaker continuing on the same day: no speaker label. */
data class SpokenItem(
    override val id: String, val line: ChatLine, val text: String, val cont: Boolean,
    val activity: List<Block> = emptyList(),
) : TranscriptItem {
    val role: String get() = line.role
    /** Counts tool CALLS only — results and thinking are part of a call, not actions of their own. */
    val activityCount: Int get() = activity.count { it.kind == "tool_use" }
}
/** Machinery with no spoken row in its exchange to hang on (a transcript cut mid-turn). */
data class ActivityItem(override val id: String, val activity: List<Block>) : TranscriptItem {
    val activityCount: Int get() = activity.count { it.kind == "tool_use" }
}
/** A short visible status or error line. */
data class NoticeItem(override val id: String, val text: String, val error: Boolean) : TranscriptItem
data class DayItem(override val id: String, val label: String) : TranscriptItem
/** Earlier paragraphs of a finished answer, folded behind «Ход работы · N». */
data class FoldItem(override val id: String, val hidden: List<SpokenItem>) : TranscriptItem

private val months = listOf("янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек")

fun dayLabel(ms: Long, now: Long, zone: ZoneId): String {
    val then = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate()
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    val days = ChronoUnit.DAYS.between(then, today)
    if (days == 0L) return "сегодня"
    if (days == 1L) return "вчера"
    val label = "${then.dayOfMonth} ${months[then.monthValue - 1]}"
    return if (then.year == today.year) label else "$label ${then.year}"
}

/** A long status line (Codex echoes every command's stdout through `status`) is machinery;
 * a short one ("session resumed") stays visible. A ✓/○ plan is never folded. */
fun statusFolds(text: String): Boolean {
    val lines = text.split("\n")
    if (lines.all { it.trim().let { t -> t.isEmpty() || t.startsWith("✓") || t.startsWith("○") } }) return false
    val last = text.trim().substringAfterLast("\n")
    if (last == "→ completed" || last == "→ failed" || last == "→ interrupted") return true
    return text.length > 200 || lines.size > 3
}

/** The blocks a line contributes to the gear sheet when it is pure machinery. Lines from before
 * structured blocks existed (disk cache) carry only text — shown as raw output. */
private fun machinery(line: ChatLine): List<Block> =
    line.blocks.filter { it.mechanical }.ifEmpty { listOf(Block("output", text = line.text.ifBlank { line.details })) }
        .filter { it.kind == "tool_use" || !it.text.isNullOrBlank() || it.isError == true }

fun groupTranscript(lines: List<ChatLine>, busy: Boolean, now: Long, zone: ZoneId = ZoneId.systemDefault()): List<TranscriptItem> {
    val out = mutableListOf<TranscriptItem>()
    var activity = mutableListOf<Block>()
    var anchor: Int? = null
    var orphanSeq = 0
    var lastSpeaker: String? = null
    var day: LocalDate? = null

    fun flushExchange() {
        if (activity.isNotEmpty()) {
            val at = anchor
            if (at != null) out[at] = (out[at] as SpokenItem).copy(activity = activity.toList())
            else out += ActivityItem("activity-${orphanSeq++}-${out.size}", activity.toList())
        }
        activity = mutableListOf(); anchor = null
    }
    /** A calendar-day change draws a divider and ends the exchange; an untimed line neither moves nor forgets the day. */
    fun dayMark(line: ChatLine, id: String): Boolean {
        val ts = line.ts ?: return false
        val key = Instant.ofEpochMilli(ts).atZone(zone).toLocalDate()
        if (key == day) return false
        day = key
        flushExchange()
        out += DayItem("day-$id", dayLabel(ts, now, zone))
        return true
    }
    fun speak(line: ChatLine, id: String, text: String) {
        val newDay = dayMark(line, id)
        out += SpokenItem(id, line, text, cont = line.role == lastSpeaker && !newDay)
        lastSpeaker = line.role
        anchor = out.lastIndex
    }

    for (line in lines) {
        when (line.role) {
            "user" -> {
                // A person's turn renders whole and opens a new exchange. A turn that was nothing but
                // harness plumbing says nothing — and, having said nothing, does not break the chain.
                val text = stripHarnessNoise(line.text)
                if (text.isBlank() && line.imageCount == 0 && line.images.isEmpty()) continue
                flushExchange()
                speak(line, line.id, text)
            }
            "assistant" -> {
                val texts = line.blocks.filter { it.kind == "text" || it.mechanical }
                if (texts.isEmpty()) {
                    val text = stripHarnessNoise(line.text)
                    if (text.isNotBlank() || line.streaming || line.imageCount > 0 || line.generation != null) speak(line, line.id, text)
                    if (line.details.isNotBlank()) activity += Block("output", text = line.details)
                } else {
                    // tools → text → tools inside one message: each prose piece is its own row.
                    var piece = 0
                    val prose = StringBuilder()
                    fun flushProse() {
                        if (prose.isEmpty()) return
                        speak(line.copy(images = emptyList(), imageRefs = emptyList(), imageCount = 0), if (piece == 0) line.id else "${line.id}-p$piece", prose.toString())
                        piece++; prose.clear()
                    }
                    texts.forEach { block ->
                        if (block.kind == "text") { if (prose.isNotEmpty()) prose.append("\n\n"); prose.append(block.text.orEmpty()) }
                        else { flushProse(); activity += block }
                    }
                    flushProse()
                    val at = anchor
                    if (at != null && out[at] is SpokenItem) out[at] = (out[at] as SpokenItem).let { it.copy(line = it.line.copy(images = line.images, imageRefs = line.imageRefs, imageCount = line.imageCount)) }
                }
            }
            "system" -> activity += machinery(line)
            "error" -> { flushExchange(); out += NoticeItem(line.id, line.text, error = true); lastSpeaker = null }
            "notice" -> out += NoticeItem(line.id, line.text, error = false)
        }
    }
    flushExchange()
    return uniqueIds(foldProgress(out, busy))
}

/** LazyColumn keys must be unique or Compose crashes. History and a mirror/replay tail can carry the
 * same uuid when their overlap is not a clean suffix; the second copy gets a stable suffix. */
private fun uniqueIds(rows: List<TranscriptItem>): List<TranscriptItem> {
    val seen = HashMap<String, Int>()
    return rows.map { row ->
        val n = seen.merge(row.id, 1, Int::plus)!!
        if (n == 1) row else when (row) {
            is SpokenItem -> row.copy(id = "${row.id}#$n")
            is ActivityItem -> row.copy(id = "${row.id}#$n")
            is NoticeItem -> row.copy(id = "${row.id}#$n")
            is DayItem -> row.copy(id = "${row.id}#$n")
            is FoldItem -> row.copy(id = "${row.id}#$n")
        }
    }
}

/** An answer of 3+ paragraphs whose last paragraph carries the work: keep only that one open.
 * The tail turn stays whole while the run is still working. */
private fun foldProgress(rows: List<TranscriptItem>, busy: Boolean): List<TranscriptItem> {
    val result = mutableListOf<TranscriptItem>()
    val turn = mutableListOf<TranscriptItem>()
    fun assistant(row: TranscriptItem) = row is SpokenItem && row.role == "assistant"
    fun flush(tail: Boolean) {
        val prose = turn.filter(::assistant).map { it as SpokenItem }
        val last = prose.lastOrNull()
        if ((!tail || !busy) && prose.size >= 3 && last != null && last.activity.isNotEmpty()) {
            val hidden = prose.dropLast(1)
            val hiddenIds = hidden.map { it.id }.toSet()
            var emitted = false
            turn.forEach { row ->
                if (row.id in hiddenIds) {
                    if (!emitted) { result += FoldItem("fold-${hidden[0].id}", hidden); emitted = true }
                } else result += row
            }
        } else result += turn
        turn.clear()
    }
    rows.forEach { row ->
        val boundary = row is DayItem || (row is SpokenItem && row.role == "user") || (row is NoticeItem && row.error)
        if (boundary) { flush(tail = false); result += row } else turn += row
    }
    flush(tail = true)
    return result
}

/** «N действий» with the Russian plural. */
fun actionCount(n: Int): String {
    val word = when {
        n % 100 in 11..14 -> "действий"
        n % 10 == 1 -> "действие"
        n % 10 in 2..4 -> "действия"
        else -> "действий"
    }
    return "$n $word"
}

/** Colour role of a tool — what its call does to the world. Mirrors `ToolSquare` in ios ToolViews.swift. */
enum class ToolEffect { READ, ACT, OTHER }
private val readTools = Regex("read|glob|grep|^ls$|search|web|fetch|todo|plan|question", RegexOption.IGNORE_CASE)
private val actTools = Regex("edit|write|notebook|bash|terminal|kill|monitor|exec|shell|agent|task|workflow|skill", RegexOption.IGNORE_CASE)
fun toolEffect(name: String?): ToolEffect = when {
    name == null -> ToolEffect.OTHER
    readTools.containsMatchIn(name) -> ToolEffect.READ
    actTools.containsMatchIn(name) -> ToolEffect.ACT
    else -> ToolEffect.OTHER
}
