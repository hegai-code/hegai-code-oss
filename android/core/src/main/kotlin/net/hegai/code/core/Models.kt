package net.hegai.code.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

/** A deliberately small consumer of shared/src/{web-protocol,protocol,rpc}.ts. */
val wireJson = Json { ignoreUnknownKeys = true; coerceInputValues = true }

@Serializable data class Owner(val userId: String)
@Serializable data class Access(val state: String = "active")
@Serializable data class Workspace(val workspaceId: String, val name: String, val role: String = "member", val kind: String = "personal", val selfServe: Boolean = false)
// `email` is absent for an account without an address (Telegram-only sign-in).
// Required here failed the WHOLE snapshot decode for such a person.
@Serializable data class Viewer(
    val userId: String, val email: String? = null, val fullName: String? = null, val telegram: String? = null,
    val access: Access? = null, val workspace: Workspace? = null,
    val workspaces: List<Workspace> = emptyList(), val platformAdmin: Boolean = false,
)
@Serializable data class MachineInfo(
    val machineId: String, val name: String, val os: String = "",
    val permissionModes: List<String>? = null, val codexPermissionModes: List<String>? = null,
    /** The owner marked this machine private (docs/E2EE.md): its content crosses the hub only as ciphertext. */
    @kotlinx.serialization.SerialName("private") val isPrivate: Boolean = false,
    /** The agent process's random id; what a client seals is good for that process only. */
    val e2eEpoch: String? = null,
)
@Serializable data class Session(
    val sessionId: String, val title: String, val lastModified: Double = 0.0,
    val cwd: String? = null, val project: String? = null, val source: String = "claude",
    val liveStatus: String? = null, val stage: String? = null, val active: Boolean = false, val gitBranch: String? = null,
    val livePid: Long? = null, val owner: Owner? = null, val entrypoint: String? = null,
    // Stamped by the agent (probe prompt) or the hub (fleet spawn, 31.10.2026).
    @kotlinx.serialization.SerialName("automated") val wireAutomated: Boolean = false,
    val createdAt: Double? = null,
) {
    val automated: Boolean get() {
        if (wireAutomated) return true
        val path = cwd.orEmpty().replace('\\', '/').lowercase()
        return (entrypoint == "sdk-cli" && owner == null) || listOf("/tmp/", "/var/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/").any(path::startsWith) || path.contains("/appdata/local/temp/")
    }
}
@Serializable data class Machine(
    val machine: MachineInfo, val sessions: List<Session> = emptyList(),
    val online: Boolean = false, val canControl: Boolean = false, val canStart: Boolean = false,
    val owner: Owner? = null, val shared: Boolean = false, val kind: String = "personal",
    val stats: JsonObject? = null, val usage: JsonObject? = null, val codexUsage: JsonObject? = null,
    val runtimes: JsonObject? = null, val profile: JsonObject? = null,
)
@Serializable data class Run(
    val runId: String, val machineId: String, val sessionId: String,
    val state: String, val ownerUserId: String? = null, val title: String? = null, val machineName: String? = null, val pendingKind: String? = null, val since: Long = 0, val taskStartedAt: Long? = null,
)
@Serializable data class Block(
    val kind: String, val text: String? = null, val name: String? = null,
    val input: JsonElement? = null, val data: String? = null, val media_type: String? = null, val ref: String? = null,
    val generated: Boolean = false, val prompt: String? = null,
    val id: String? = null, val toolUseId: String? = null, val isError: Boolean? = null,
) {
    /** Tool calls, their results, thinking and raw command output: the runtime talking, never a person. */
    val mechanical: Boolean get() = kind == "tool_use" || kind == "tool_result" || kind == "thinking" || kind == "output"
    val weight: Int get() = (text?.length ?: 0) + (input?.toString()?.length ?: 0) + (name?.length ?: 0)
}
@Serializable data class HistoryMessage(val uuid: String, val type: String, val blocks: List<Block>, val ts: Double? = null)
@Serializable data class Snapshot(
    val machines: List<Machine>, val activeRuns: List<Run> = emptyList(), val viewer: Viewer? = null,
)

@Serializable data class Target(
    val machineId: String, val cwd: String, val sessionId: String? = null,
    val title: String = "Новый чат", val source: String = "claude",
    /** Client-local start choice (`OpenCode.AGENT`); never sent on the wire. Absent in older saved state. */
    val agent: String? = null,
) {
    val key: String get() = "$machineId:${sessionId ?: "new:$cwd:$source${if (agent != null) ":$agent" else ""}"}"
    val project: String get() = cwd.replace('\\', '/').trimEnd('/').substringAfterLast('/').ifBlank { "Проект" }
}
@Serializable data class ImageInput(val media_type: String, val data: String)
/** One transcript line. `role`: user / assistant — spoken; system — machinery only (tool calls,
 * results, thinking, long command output), shown folded; notice — a short visible status;
 * error — a visible failure that ends a turn. `blocks` keep the structure the gear sheet renders. */
@Serializable data class ChatLine(val id: String, val role: String, val text: String, val streaming: Boolean = false,
    val images: List<ImageInput> = emptyList(), val details: String = "", val imageRefs: List<String> = emptyList(), val imageCount: Int = images.size,
    val blocks: List<Block> = emptyList(), val ts: Long? = null,
    val turnId: String? = null, val truncated: Boolean = false, val files: List<String> = emptyList(),
    val generation: ImageGeneration? = null) {
    val spoken: Boolean get() = role == "user" || role == "assistant"
    val weight: Int get() = text.length + details.length + blocks.sumOf { it.weight }
}
@Serializable data class RunOptions(val model: String? = null, val effort: String? = null,
    val permissionMode: String? = null, val ultracode: Boolean = false)
@Serializable data class ModelChoice(val id: String, val name: String? = null, val resolved: String? = null,
    val efforts: List<String>? = null, val supportsEffort: Boolean? = null)
@Serializable data class ConversationCache(val target: Target, val messages: List<ChatLine>)
@Serializable data class TitleRecord(val base: String, val title: String, val manual: Boolean = false)
@Serializable data class Notice(val id: String, val run: Run, val at: Long, val unread: Boolean = true)
@Serializable data class AccountCache(val machines: List<Machine> = emptyList(),
    val drafts: Map<String, String> = emptyMap(), val attachments: Map<String, List<ImageInput>> = emptyMap(),
    val outgoing: Submission? = null, val conversations: Map<String, ConversationCache> = emptyMap(),
    val target: Target? = null, val titles: Map<String, TitleRecord> = emptyMap(), val notices: List<Notice> = emptyList(), val favorites: Set<String> = emptySet())

data class Approval(val runId: String, val requestId: String, val tool: String, val input: JsonObject, val title: String?) {
    val questions: List<JsonObject> get() = (input["questions"] as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()
    val isQuestion: Boolean get() = tool == "AskUserQuestion" || questions.isNotEmpty()
}
/** `before`: how many identical person turns were already on screen when this one was sent — a stale
 * history read cannot then pass an earlier «да» off as this one. -1 = saved by an older build. */
@Serializable data class Submission(val key: String, val text: String, val ref: String, val deadline: Long, val previousIds: Set<String> = emptySet(), val images: List<ImageInput> = emptyList(), val before: Int = -1, val continuation: Boolean = false, val echoId: String? = null, val correlated: Boolean = false)
@Serializable data class DraftBundle(val drafts: Map<String, String>, val outgoing: Submission?)
enum class Connection { DISCONNECTED, CONNECTING, SYNCING, READY }
data class HubState(
    val connection: Connection = Connection.DISCONNECTED,
    val viewer: Viewer? = null, val machines: List<Machine> = emptyList(), val runs: List<Run> = emptyList(),
    val target: Target? = null, val runId: String? = null,
    val history: List<ChatLine> = emptyList(), val live: List<ChatLine> = emptyList(),
    val loadingHistory: Boolean = false, val busy: Boolean = false,
    val drafts: Map<String, String> = emptyMap(), val approval: Approval? = null,
    val error: String? = null, val opening: Boolean = false,
    val uncertain: Submission? = null, val pending: Submission? = null,
    val attachments: Map<String, List<ImageInput>> = emptyMap(),
    val options: RunOptions = RunOptions(), val runSettings: JsonObject? = null,
    val contextUsage: JsonObject? = null, val mirrored: Boolean = false,
    val turnStartedAt: Long? = null, val turnTokens: Long? = null,
    val historyLimit: Int = 1000,
    val quickReplies: List<JsonObject> = emptyList(),
    val titles: Map<String, TitleRecord> = emptyMap(),
    val notices: List<Notice> = emptyList(),
    val favorites: Set<String> = emptySet(),
    val reads: Map<String, Double> = emptyMap(),
    val turnIdle: Boolean = false, val turnFinished: Boolean = false,
    val background: List<BackgroundTask> = emptyList(), val subagents: List<Subagent> = emptyList(),
    val compaction: String = "idle", val rateLimit: String? = null,
    /** Machine ids this device holds a content key for (private machines, docs/E2EE.md). */
    val keyed: Set<String> = emptySet(),
) {
    /** A private machine whose key this device lacks: its content is shut, nothing can be sent into it. */
    fun locked(machineId: String?): Boolean = machineId != null && machineId !in keyed && machines.any { it.machine.machineId == machineId && it.machine.isPrivate }
    val locked: Boolean get() = locked(target?.machineId)
    /** A private machine, or one this device holds a key for: its content is never written to the phone's cache nor sent to hub-side AI. */
    fun sealedMachine(machineId: String?): Boolean = machineId != null && (machineId in keyed || machines.any { it.machine.machineId == machineId && it.machine.isPrivate })
    val privateTarget: Boolean get() = sealedMachine(target?.machineId)
    val activeAccess: Boolean get() = viewer?.access?.state.let { it == null || it == "active" }
    fun canSetStage(machine: Machine, session: Session): Boolean = activeAccess &&
        (machine.canControl || viewer?.userId?.let { it == session.owner?.userId } == true)
    fun titleFor(machineId: String, session: Session): String = (titles["$machineId:${session.sessionId}"]?.takeIf { it.base == session.title }?.title ?: session.title).let(::shown)
    val displayTitle: String get() = target?.let { shown(titles[it.key]?.takeIf { record -> record.base == (session?.title ?: it.title) }?.title ?: it.title) } ?: "Hegai Code"
    val images: List<ImageInput> get() = attachments[target?.key].orEmpty()
    val draft: String get() = drafts[target?.key].orEmpty()
    val machine: Machine? get() = machines.firstOrNull { it.machine.machineId == target?.machineId }
    val session: Session? get() = machine?.sessions?.firstOrNull { it.sessionId == target?.sessionId }
    val readOnlyReason: String? get() = when {
        !activeAccess -> "Доступ пока не открыт"
        target == null -> "Выберите проект"
        locked -> "Машина зашифрована. Введите код пары, чтобы читать и писать"
        machine?.online != true -> "Машина не в сети. История доступна для чтения"
        machine?.canControl != true && (machine?.canStart != true || (session != null && !isMine(machine!!, session!!))) -> "Сессия доступна только для чтения"
        session?.livePid != null && runId == null -> "Сессия открыта в редакторе. Завершите её там, чтобы продолжить здесь"
        else -> null
    }
    val canTakeover: Boolean get() = connection == Connection.READY && activeAccess &&
        machine?.online == true && machine?.canControl == true && session?.livePid != null && runId == null &&
        !opening && !loadingHistory && uncertain == null && pending == null
    val canSend: Boolean get() = compaction !in listOf("requested", "running") && connection == Connection.READY && readOnlyReason == null && !opening && uncertain == null && !loadingHistory && pending == null && approval == null
    fun unread(machineId: String, sessionId: String): Boolean = runs.any {
        it.machineId == machineId && it.sessionId == sessionId && it.state in listOf("idle", "error", "needs_attention") &&
            it.ownerUserId == viewer?.userId && it.since > 0 && (reads["$machineId:$sessionId"] ?: 0.0) < it.since
    }
    fun isMine(machine: Machine, session: Session): Boolean {
        val owner = session.owner?.userId ?: runs.firstOrNull {
            it.machineId == machine.machine.machineId && it.sessionId == session.sessionId
        }?.ownerUserId
        if (owner != null) return owner == viewer?.userId
        if (machine.shared || machine.kind == "sandbox") return false
        return machine.owner == null || machine.owner.userId == viewer?.userId
    }
    /** Subscription replay repeats the current turn; overlap is a suffix, never a global text dedupe.
     * A history read taken mid-turn already holds part of that turn: it is shown once, from the stream.
     * Computed once per state: every reader (transcript, cache, send) used to redo it, and the old
     * search allocated `takeLast(n).zip(take(n))` for every n — ~2M pairs per call on a long session. */
    val messages: List<ChatLine> by lazy(LazyThreadSafetyMode.PUBLICATION) { mergeTranscript(history, live) }
}

/** What a title shows: the sealed placeholder reads as «Зашифрованная сессия» (docs/E2EE.md, Clients). */
fun shown(title: String): String = if (title == E2ee.PLACEHOLDER) "Зашифрованная сессия" else title

/** History plus the part of the live tail history does not already end with. */
fun mergeTranscript(history: List<ChatLine>, live: List<ChatLine>): List<ChatLine> {
    val base = replayedTurnStart(history, live)?.let { history.subList(0, it) } ?: history
    if (live.isEmpty()) return base
    val same = { a: ChatLine, b: ChatLine -> a.role == b.role && a.text == b.text && a.imageCount == b.imageCount && a.imageRefs == b.imageRefs && a.generation?.id == b.generation?.id }
    // Longest n with base's last n == live's first n. Only offsets whose first line already matches are
    // compared in full, and nothing is allocated, so a normal session is linear.
    val max = minOf(base.size, live.size)
    val overlap = (max downTo 1).firstOrNull { n ->
        val from = base.size - n
        same(base[from], live[0]) && (1 until n).all { same(base[from + it], live[it]) }
    } ?: 0
    return base + live.subList(overlap, live.size)
}

fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

/** How to show a person from a hub payload: full name, else the address, else a
 *  short id. Accounts without an address exist (Telegram-only sign-in), so a
 *  label must never be built from `email` alone. Mirrors `displayName` in web/src/lib.ts. */
fun personName(person: JsonObject): String =
    person.string("fullName")?.trim()?.takeIf { it.isNotEmpty() }
        ?: person.string("email")?.trim()?.takeIf { it.isNotEmpty() }
        ?: person.string("userId")?.let { "Участник ${it.take(6)}" }
        ?: "Без имени"
fun JsonObject.objectValue(key: String): JsonObject? = this[key] as? JsonObject
fun frame(type: String, body: JsonObjectBuilder.() -> Unit = {}): JsonObject = buildJsonObject { put("type", type); body() }
private val harnessNoise = Regex(listOf("task-notification", "system-reminder", "local-command-stdout",
    "local-command-caveat", "command-name", "command-message", "command-args",
    // Codex's own envelopes (not yet stripped by the agent): goal context, interruption notes, environment.
    "codex_internal_context", "goal_context", "turn_aborted", "environment_context", "user_instructions",
).joinToString("|") { "<$it(?:\\s[^>]*)?>[\\s\\S]*?</$it>" })
/** Harness plumbing the CLI injects into a turn's text — addressed to the model, never to a reader.
 * Mirrors `stripHarnessNoise` in agent/src/history.ts and ios MessageView.swift, plus Codex envelopes. */
fun stripHarnessNoise(text: String): String = if ('<' !in text) text else text.replace(harnessNoise, "").trim()

/** Drop what renders as an empty box; keep the structure for the gear sheet. */
private fun cleanBlocks(blocks: List<Block>): List<Block> = blocks.mapNotNull { block ->
    when (block.kind) {
        "text" -> stripHarnessNoise(block.text.orEmpty()).takeIf { it.isNotBlank() }?.let { block.copy(text = it) }
        "thinking" -> block.takeIf { !it.text.isNullOrBlank() }
        // An empty result that failed still matters — the error is the signal.
        "tool_result" -> block.takeIf { !it.text.isNullOrBlank() || it.isError == true }
        "image" -> block.copy(data = null)
        else -> block
    }
}

fun historyLines(messages: List<HistoryMessage>): List<ChatLine> = messages.mapNotNull { message ->
    val ts = message.ts?.toLong()
    if (message.type == "system") {
        // Hook output and CLI caveats are not conversation; a compaction is a quiet seam.
        return@mapNotNull if (message.blocks.any { it.kind == "compact_boundary" }) ChatLine(message.uuid, "notice", "Контекст сжат", ts = ts) else null
    }
    val blocks = cleanBlocks(message.blocks)
    if (blocks.isEmpty()) return@mapNotNull null
    val prose = blocks.filter { it.kind == "text" }.mapNotNull { it.text }.joinToString("\n\n")
    val details = blocks.filter { it.kind != "text" }.joinToString("\n") {
        when (it.kind) {
            "tool_use" -> "${it.name ?: "Инструмент"}: ${it.input ?: ""}"
            "image" -> "[Изображение]"
            else -> it.text.orEmpty()
        }
    }
    val images = message.blocks.filter { it.kind == "image" && it.data != null && it.media_type != null }
        .map { ImageInput(it.media_type!!, it.data!!) }
    val hasImages = blocks.any { it.kind == "image" }
    val text = prose.ifBlank { if (hasImages) "" else details }
    if (text.isBlank() && !hasImages && blocks.none { it.mechanical }) null else ChatLine(message.uuid,
        if (prose.isBlank() && !hasImages) "system" else message.type, text, images = images,
        details = if (prose.isNotBlank()) details else "", imageRefs = blocks.mapNotNull { if (it.kind == "image") it.ref else null },
        imageCount = blocks.count { it.kind == "image" }, blocks = blocks, ts = ts)
}

/** Where history's copy of the turn the stream is replaying begins — port of `replayedTurnStart`
 * (ios TranscriptGrouping.swift). Anchors on the live tail's first settled spoken line:
 *  - an assistant line: search only the current turn of history (after the last thing a person said);
 *  - our own sent line: the history copy of that same message, when nothing a person said follows it.
 * No match drops nothing: a visible duplicate until convergence beats a paragraph that disappears. */
fun replayedTurnStart(history: List<ChatLine>, live: List<ChatLine>): Int? {
    if (history.isEmpty()) return null
    val head = live.firstOrNull { it.spoken } ?: return null
    if (head.streaming) return null
    val said = { line: ChatLine -> line.role == "user" && (line.text.isNotBlank() || line.imageCount > 0) }
    val text = stripHarnessNoise(head.text).trim()
    if (head.role == "user") {
        if (text.isEmpty() && head.imageCount == 0) return null
        val index = history.indexOfLast { said(it) && stripHarnessNoise(it.text).trim() == text && it.imageCount == head.imageCount }
        // Nothing after it: the plain suffix overlap below already shows it once, from history.
        if (index < 0 || index == history.lastIndex || history.drop(index + 1).any(said)) return null
        // A short repeat («да», «продолжай») matches an OLDER turn too: accept the anchor only when the
        // stream already replays what history wrote after it — otherwise the previous answer would vanish.
        val next = history.drop(index + 1).firstOrNull { it.role == "assistant" && it.text.isNotBlank() }
        if (next != null) {
            val written = stripHarnessNoise(next.text).trim()
            if (live.none { it.role == "assistant" && stripHarnessNoise(it.text).trim().let { s -> s == written || written.startsWith(s) && s.isNotEmpty() } }) return null
        }
        return index
    }
    if (text.isEmpty()) return null
    val turnStart = history.indexOfLast(said) + 1
    return (turnStart until history.size).firstOrNull { i ->
        history[i].role == "assistant" && stripHarnessNoise(history[i].text).trim().let { it == text || it.startsWith(text) }
    }
}

/** True when history already holds every settled spoken line of the live tail — the stream is superseded. */
fun historyCovers(history: List<ChatLine>, live: List<ChatLine>): Boolean {
    val spoken = history.filter { it.spoken }.flatMap { line ->
        listOf(stripHarnessNoise(line.text).trim()) + line.blocks.filter { it.kind == "text" }.map { stripHarnessNoise(it.text.orEmpty()).trim() }
    }.toSet()
    // An error or a status notice exists only in the stream — the file never records why a turn failed.
    val refs = history.flatMap { it.imageRefs }.toSet()
    return live.none { it.streaming || it.role == "error" || it.role == "notice" || it.generation?.state in listOf("started", "failed") || it.imageRefs.any { ref -> ref !in refs } } && live.filter { it.spoken && it.text.isNotBlank() }.all { stripHarnessNoise(it.text).trim() in spoken }
}
