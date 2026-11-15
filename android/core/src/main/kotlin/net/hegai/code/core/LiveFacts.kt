package net.hegai.code.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable data class ImageGeneration(val id: String, val state: String, val startedAt: Double? = null,
    val prompt: String? = null, val ref: String? = null, val error: String? = null)
@Serializable data class BackgroundTask(val id: String, val type: String = "", val description: String = "", val since: Double = 0.0)
@Serializable data class Subagent(val id: String, val kind: String, val description: String, val status: String,
    val startedAt: Double, val toolUseId: String? = null, val endedAt: Double? = null,
    val toolUses: Int? = null, val tokens: Long? = null, val lastAction: String? = null,
    val recent: List<String> = emptyList(), val steps: List<String> = emptyList(), val activeAt: Double? = null,
    val summary: String? = null, val model: String? = null)

/** The rows are independently fallible: one future/invalid agent must not hide its siblings. */
fun parseSubagents(data: JsonObject?): List<Subagent> = (data?.get("agents") as? JsonArray).orEmpty().mapNotNull {
    runCatching { wireJson.decodeFromJsonElement<Subagent>(it) }.getOrNull()?.takeIf { a ->
        a.id.isNotBlank() && a.id.length <= 200 && a.status in listOf("running", "completed", "failed", "stopped") &&
            a.kind.length <= 80 && a.description.length <= 200 && a.recent.size <= 3 && a.steps.size <= 12
    }
}.take(32)

/** Subscription exhaustion is a notice, never a made-up measure of a model's context window. */
fun rateLimitWords(data: JsonObject?, text: String): String {
    val status = data?.string("status")
    val until = data?.get("resetsAt")?.jsonPrimitive?.doubleOrNull?.let { java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(java.util.Date((it * 1000).toLong())) }
    return text.takeIf { it.isNotBlank() } ?: ((if (status == "rejected") "Лимит подписки исчерпан" else "Подписка приближается к лимиту") + (until?.let { ". Сброс в $it" } ?: ""))
}

/** Only an authoritative turn id can merge echoes; identical content is ambiguous. */
fun finishReplay(lines: List<ChatLine>, echoes: List<ChatLine>): List<ChatLine> {
    val byTurn = echoes.filter { it.turnId != null }.associateBy { it.turnId }
    return lines.map { turn ->
        byTurn[turn.turnId]?.copy(files = turn.files) ?: turn
    } + echoes.filter { it.turnId == null && it.id.startsWith("sent:") && lines.none { line -> line.id == it.id } }
}

/** Preserve typing that arrived after recording began; place speech at its original draft anchor. */
fun insertDictation(base: String, current: String, speech: String): String {
    fun join(a: String, b: String): String = if (a.isEmpty()) b else if (b.isEmpty()) a else a + (if (a.last().isWhitespace() || b.first().isWhitespace()) "" else " ") + b
    return if (current.startsWith(base)) join(join(base, speech), current.drop(base.length)) else join(current, speech)
}
