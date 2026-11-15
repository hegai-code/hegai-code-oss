package net.hegai.code.core

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import java.util.UUID

/** Serial state machine. The Android adapter calls every method on the main thread.
 * There is no retry queue for mutations: reconnect can ONLY reload and subscribe. */
class HubEngine(
    send: (JsonObject) -> Boolean,
    private val changed: (HubState) -> Unit = {},
    private val now: () -> Long = System::currentTimeMillis,
    private val checkpoint: (HubState) -> Boolean = { true },
    private val allowAI: () -> Boolean = { true },
    /** Private machines (docs/E2EE.md): the device's key ring. Without keys nothing is opened and nothing sealed. */
    private val keys: E2eeKeys = E2eeKeys.None,
    /** A content frame was refused because the machine's key is missing: the app offers the pairing dialog. */
    private val needKey: (machineId: String) -> Unit = {},
) {
    /** The only door to the socket. Every outgoing frame passes [send], which seals what is content for a private machine. */
    private val rawSend = send
    /** Why the last [send] refused (encryption), for the message the caller shows instead of «нет соединения». */
    private var sendFailure: String? = null
    /** run -> machine, learned only from what THIS client asked for (its own open, answered by `opened` for the same
     *  machine) or from the hub's run list; envelopes open only under the machine the client itself attributes a frame to. */
    private val runMachine = mutableMapOf<String, String>()
    private val pendingOpen = mutableMapOf<String, String>()
    private val rpcMachine = mutableMapOf<String, String>()
    private val rpcMethod = mutableMapOf<String, String>()
    private val mirrorMachine = mutableMapOf<String, String>()
    /** Machine ids this device holds a key for; every published state carries it (HubState.keyed). */
    private var keyedSet: Set<String> = emptySet()
    var state = HubState()
        private set(value) { field = if (value.keyed == keyedSet) value else value.copy(keyed = keyedSet); changed(field) }
    private var notificationSeeded = false
    private var previousRunStates = emptyMap<String, String>()
    private var ref = newId()
    private var lastSendRef: String? = null
    private var historyRequest: String? = null
    private var historyDeadline = 0L
    private var historyQuiet = false
    /** A turn ended while another history read was in flight: that read predates the end — read again. */
    private var convergeAgain = false
    private var compactionDeadline = 0L
    private var lastReadKey: String? = null
    private var lastReadAt = 0L
    private var replay: List<ChatLine>? = null
    private var replayDeadline = 0L
    private var replayEchoes: List<ChatLine> = emptyList()
    private var liveLines: List<ChatLine>
        get() = replay ?: state.live
        set(value) { if (replay != null) { replay = value; replayDeadline = now() + 150 } else state = state.copy(live = value) }
    private fun commitReplay() {
        val lines = replay ?: return
        replay = null
        val merged = finishReplay(lines, replayEchoes)
        replayEchoes = emptyList()
        state = state.copy(live = merged.takeLast(2000))
    }
    // ---- Private machines (docs/E2EE.md): web/src/useCentral.ts is the reference ---------------------------------
    /** Every machine a run could be for - the same attribution [sealTarget] uses. */
    private fun runCandidates(runId: String?): Set<String> {
        if (runId == null) return emptySet()
        val out = linkedSetOf<String>()
        runMachine[runId]?.let(out::add)
        if (runId == state.runId) state.target?.machineId?.let(out::add)
        state.runs.firstOrNull { it.runId == runId }?.machineId?.let(out::add)
        return out
    }
    private fun machineOfRun(runId: String?): String? = runCandidates(runId).firstOrNull()
    private fun isPrivate(machineId: String?) = machineId != null && state.machines.any { it.machine.machineId == machineId && it.machine.isPrivate }

    /** The keys changed (a code was paired or a key forgotten): what is sealed and opened from now on follows them. */
    fun keysChanged(machineIds: Set<String>) {
        val removed = keyedSet - machineIds
        keyedSet = machineIds
        if (removed.isNotEmpty()) scrub(removed)
        state = state
    }
    /** A key was forgotten: what it decrypted leaves the screen now (the locked state shows), not on the next reconnect. */
    private fun scrub(machineIds: Set<String>) {
        commitReplay(); replay = null; replayEchoes = emptyList()
        val here = state.target?.machineId in machineIds
        state = state.copy(
            machines = state.machines.map { m ->
                if (m.machine.machineId !in machineIds) m
                else m.copy(sessions = m.sessions.map { it.copy(title = E2ee.PLACEHOLDER, cwd = null, project = null, gitBranch = null) })
            },
            titles = state.titles.filterKeys { k -> machineIds.none { k.startsWith("$it:") } },
            history = if (here) emptyList() else state.history, live = if (here) emptyList() else state.live,
            approval = if (here) null else state.approval, subagents = if (here) emptyList() else state.subagents,
            background = if (here) emptyList() else state.background, quickReplies = if (here) emptyList() else state.quickReplies,
            target = state.target?.takeIf { here }?.copy(title = E2ee.PLACEHOLDER, cwd = "") ?: state.target,
            pending = if (here) null else state.pending, uncertain = if (here) null else state.uncertain,
        )
    }

    private sealed interface Seal { data class For(val machineId: String) : Seal; data object Unresolved : Seal; data object Conflict : Seal }
    /** Whether a content frame must be sealed, and for which machine. The key ring decides, not the hub: a hub that
     *  says "not private" must not make a device that holds the key type into the machine in the clear. */
    private fun sealTarget(msg: JsonObject): Seal? {
        if (!E2ee.needsSeal(msg)) return null
        val candidates = linkedSetOf<String>()
        msg.string("machineId")?.takeIf { it.isNotEmpty() }?.let(candidates::add)
        val runId = msg.string("runId")
        if (runId != null) {
            runMachine[runId]?.let(candidates::add)
            if (runId == state.runId) state.target?.machineId?.let(candidates::add)
            state.runs.firstOrNull { it.runId == runId }?.machineId?.let(candidates::add)
        }
        val held = candidates.filter(keys::has)
        if (held.size > 1) return Seal.Conflict
        if (held.size == 1) return Seal.For(held[0])
        candidates.firstOrNull(::isPrivate)?.let { return Seal.For(it) }
        // No candidate says "private". With no candidate at all, only a frame that really carries the person's words is held back.
        if (candidates.isEmpty() && (keys.hasAny() || state.machines.any { it.machine.isPrivate }) && E2ee.hasRealContent(msg)) return Seal.Unresolved
        return null
    }

    private fun send(msg: JsonObject): Boolean {
        sendFailure = null
        val type = msg.string("type")
        when (type) {
            "rpc_request" -> { val id = msg.string("requestId"); val machine = msg.string("machineId")
                if (id != null && machine != null) { if (rpcMachine.size > 5000) { rpcMachine.clear(); rpcMethod.clear() }; rpcMachine[id] = machine; rpcMethod[id] = msg.string("method").orEmpty() } }
            "mirror_open" -> { val id = msg.string("mirrorId"); val machine = msg.string("machineId"); if (id != null && machine != null) mirrorMachine[id] = machine }
            "open", "new_session", "takeover" -> { val ref = msg.string("ref"); val machine = msg.string("machineId"); if (ref != null && machine != null) pendingOpen[ref] = machine }
        }
        val found = sealTarget(msg)
        if (found == null) return rawSend(msg)
        when (found) {
            Seal.Unresolved -> { sendFailure = "Не удалось определить машину для зашифрованной отправки — сообщение не отправлено."; return false }
            Seal.Conflict -> { sendFailure = "Хаб указал две зашифрованные машины для одного сообщения — оно не отправлено."; return false }
            is Seal.For -> {
                if (!keys.has(found.machineId)) { sendFailure = E2ee.NO_KEY_HINT; needKey(found.machineId); return false }
                val epoch = state.machines.firstOrNull { it.machine.machineId == found.machineId }?.machine?.e2eEpoch
                val sealed = try { E2ee.sealFrame(msg, found.machineId, keys, epoch) }
                catch (_: Exception) { sendFailure = "Не удалось зашифровать сообщение — оно не отправлено."; return false }
                return rawSend(sealed)
            }
        }
    }

    /** A frame from the hub with every envelope this device can open opened; null = dropped (see below). */
    private fun openIncoming(message: JsonObject): JsonObject? {
        val candidates = runCandidates(message.string("runId"))
        val sealedRun = candidates.any { keys.has(it) || isPrivate(it) }
        // An approval for a keyed or private machine is shown only if its envelope opened: a hub that strips or damages it
        // would otherwise get an empty card approved, and the agent would run a command the person never saw.
        // Decided before anything else, so an empty ring or a run id learned from an error does not skip it.
        val isRequest = message.string("type") == "tool_request"
        if (!keys.hasAny()) return if (isRequest && sealedRun) refuseRequest() else message
        // A machine whose key this device holds speaks to it only sealed: clear assistant text, tool prompts or user
        // turns for such a run are the hub's own invention (it cannot read the real ones) - dropped, never shown.
        if (candidates.any(keys::has) && E2ee.clearContentForKeyedRun(message)) return null
        // A clear answer to an rpc for a keyed machine is the hub's invention (the agent would have sealed it): the caller is refused at once.
        if (message.string("type") == "rpc_response") {
            val id = message.string("requestId")
            val machine = rpcMachine[id]
            if (id != null && machine != null && keys.has(machine) && E2ee.clearRpcContent(rpcMethod[id].orEmpty(), message)) {
                rpcMachine.remove(id); rpcMethod.remove(id)
                val why = "Ответ машины пришёл незашифрованным — он отброшен."
                if (id == historyRequest) { historyRequest = null; state = state.copy(loadingHistory = false, error = why) }
                else requests.remove(id)?.done?.invoke(Result.failure(IllegalStateException(why)))
                return null
            }
        }
        val opened = E2ee.openFrame(message, keys) { f ->
            when (f.string("type")) {
                "rpc_response" -> rpcMachine[f.string("requestId")]
                "mirror_data" -> mirrorMachine[f.string("mirrorId")]
                else -> machineOfRun(f.string("runId"))
            }
        }
        if (message.string("type") == "rpc_response") message.string("requestId")?.let { rpcMachine.remove(it); rpcMethod.remove(it) }
        if (isRequest && sealedRun && (E2ee.envelopeOf(message["e2e"]) == null || opened["e2e"] != null)) return refuseRequest()
        return opened
    }
    private fun refuseRequest(): JsonObject? {
        state = state.copy(error = "Запрос разрешения от зашифрованной машины не удалось прочитать — он скрыт. Откройте сессию заново.")
        return null
    }

    /** Call only while the conversation is actually visible, not under a settings/report sheet. */
    fun markVisible() {
        val target = state.target ?: return
        val sessionId = target.sessionId ?: return
        if (state.connection != Connection.READY || !state.activeAccess || state.loadingHistory) return
        if (lastReadKey == target.key && now() - lastReadAt < 2000) return
        if (command("session_read", buildJsonObject { put("machineId", target.machineId); put("sessionId", sessionId) })) {
            lastReadKey = target.key; lastReadAt = now()
        }
    }
    fun statsInterest(on: Boolean) { command("stats_interest", buildJsonObject { put("on", on) }) }
    fun setStage(machineId: String, sessionId: String, stage: String?) {
        command("set_stage", buildJsonObject { put("machineId", machineId); put("sessionId", sessionId); stage?.let { put("stage", it) } })
    }
    fun continueTurn() { if (!state.busy && state.approval == null && state.turnFinished) submit(continuation = true) }
    fun quickReply(reply: JsonObject) {
        val text = reply.string("send")?.trim()?.takeIf { it.length in 1..60 } ?: return
        if (reply.string("kind") == "idea") editDraft(listOf(state.draft, text).filter { it.isNotBlank() }.joinToString("\n"))
        else if (!state.busy && state.approval == null) submit(continuation = true, message = text)
    }

    private var submission: Submission?
        get() = state.pending
        set(value) { state = state.copy(pending = value) }
    private var subscribed: String? = null
    private var mirrorId: String? = null
    var defaultOptions: Map<String, RunOptions> = emptyMap()
    /** Cached Codex model rows for a machine; lets an OpenCode start pick its explicit Go model. */
    var codexModels: (String) -> List<ModelChoice> = { emptyList() }
    private data class Request(val deadline: Long, val done: (Result<JsonObject>) -> Unit)
    private val requests = mutableMapOf<String, Request>()
    private fun rejectRequests() {
        val old = requests.values.toList(); requests.clear()
        old.forEach { it.done(Result.failure(IllegalStateException("Соединение закрыто"))) }
    }
    fun request(type: String, body: JsonObject = buildJsonObject {}, done: (Result<JsonObject>) -> Unit): String? {
        if (state.connection != Connection.READY || !state.activeAccess) {
            done(Result.failure(IllegalStateException("Нет соединения"))); return null
        }
        if (type == "enrich_request" && !allowAI()) { done(Result.failure(IllegalStateException("Передача данных AI не разрешена"))); return null }
        // Suggestions and titles are made by the hub from plaintext: never for a private machine.
        if (type == "enrich_request" && body.string("machineId").let { isPrivate(it) || it != null && keys.has(it) }) {
            done(Result.failure(IllegalStateException("Для зашифрованной машины подсказки отключены"))); return null
        }
        val id = newId()
        requests[id] = Request(now() + 30_000, done)
        if (!send(JsonObject(body + ("type" to JsonPrimitive(type)) + ("requestId" to JsonPrimitive(id))))) {
            requests.remove(id)?.done?.invoke(Result.failure(IllegalStateException("Не удалось отправить запрос")))
        }
        return id
    }
    fun cancelRequest(id: String) { requests.remove(id) }
    fun command(type: String, body: JsonObject = buildJsonObject {}): Boolean {
        if (state.connection != Connection.READY || !state.activeAccess) return false
        return send(JsonObject(body + ("type" to JsonPrimitive(type))))
    }
    fun error(text: String) { state = state.copy(error = text) }
    fun addImages(images: List<ImageInput>) {
        val key = state.target?.key ?: return
        val combined = state.images + images
        if (combined.size > 4 || combined.sumOf { it.data.length.toLong() } > 12_000_000) {
            error("Можно прикрепить до 4 изображений общим размером до 9 МБ"); return
        }
        state = state.copy(attachments = state.attachments + (key to combined))
    }
    fun removeImage(index: Int) {
        val key = state.target?.key ?: return
        state = state.copy(attachments = state.attachments + (key to state.images.filterIndexed { i, _ -> i != index }))
    }
    fun restoreOffline(viewer: Viewer, cache: AccountCache) {
        if (state.connection == Connection.READY || state.viewer != null) return
        state = state.copy(viewer = viewer, machines = cache.machines.map { it.copy(online = false) },
            target = cache.target, drafts = cache.drafts, attachments = cache.attachments,
            uncertain = cache.outgoing, titles = cache.titles, notices = cache.notices, favorites = cache.favorites, history = cache.target?.let { cache.conversations[it.key]?.messages }.orEmpty())
    }
    fun restoreCache(cache: AccountCache) {
        state = state.copy(drafts = cache.drafts, attachments = cache.attachments, uncertain = cache.outgoing, titles = cache.titles, notices = cache.notices, favorites = cache.favorites)
        if (state.target == null) cache.target?.let { select(it) }
    }
    fun showCached(lines: List<ChatLine>, key: String) {
        if (state.target?.key == key && state.history.isEmpty()) state = state.copy(history = lines)
    }
    fun setOptions(value: RunOptions) {
        val run = state.runId
        if (run == null) { state = state.copy(options = value); return }
        if (state.readOnlyReason != null) return
        val old = state.options
        if (old.model != value.model) command("set_model", buildJsonObject {
            put("runId", run); value.model?.let { put("model", it) }
        })
        if (old.effort != value.effort || old.ultracode != value.ultracode) command("set_effort", buildJsonObject {
            put("runId", run); value.effort?.let { put("effort", it) }; put("ultracode", value.ultracode)
        })
        if (old.permissionMode != value.permissionMode) command("set_permission_mode", buildJsonObject {
            put("runId", run); put("mode", value.permissionMode ?: "default")
        })
        state = state.copy(options = value)
    }
    fun compact() {
        val run = state.runId ?: return
        if (!state.canSend || state.busy || state.compaction in listOf("requested", "running")) return
        if (!allowAI()) return
        if (command("compact", buildJsonObject { put("runId", run); put("ref", ref) })) {
            compactionDeadline = now() + 190_000; state = state.copy(compaction = "requested")
        }
    }
    fun endSession() {
        val target = state.target ?: return
        if (state.readOnlyReason != null && !state.canTakeover) return
        target.sessionId?.let { command("end_session", buildJsonObject {
            put("machineId", target.machineId); put("sessionId", it)
        }) }
    }
    fun loadMore() { state = state.copy(historyLimit = 2000); loadHistory() }
    fun setQuickReplies(value: List<JsonObject>, key: String) {
        if (state.target?.key == key) state = state.copy(quickReplies = value.filter { it.string("send")?.trim()?.length in 1..60 }.distinctBy { it.string("send")?.trim() }.take(3))
    }
    fun generatedTitle(title: String, key: String, base: String) {
        if (state.titles[key] == null && title.length in 3..40) state = state.copy(titles = state.titles + (key to TitleRecord(base, title)))
    }
    fun renamed(title: String, key: String) {
        val target = state.target ?: return
        if (target.key != key) return
        state = state.copy(target = target.copy(title = title), titles = state.titles + (key to TitleRecord(title, title, true)), machines = state.machines.map { m ->
            if (m.machine.machineId != target.machineId) m else m.copy(sessions = m.sessions.map {
                if (it.sessionId == target.sessionId) it.copy(title = title) else it
            })
        })
    }

    fun connecting() { state = state.copy(connection = Connection.CONNECTING, error = null) }
    fun connected() {
        notificationSeeded = false; previousRunStates = emptyMap()
        state = state.copy(connection = Connection.SYNCING)
        send(frame("hello") { put("client", "app"); put("caps", JsonArray(listOf("sessionDelta", "sessionPatch", "statsOnDemand").map(::JsonPrimitive))) })
    }
    fun disconnected(message: String? = null) {
        commitReplay()
        rejectRequests(); mirrorId = null; rpcMachine.clear(); rpcMethod.clear(); mirrorMachine.clear(); pendingOpen.clear()
        historyRequest = null
        subscribed = null
        state = state.copy(
            connection = Connection.DISCONNECTED, opening = false, loadingHistory = false,
            approval = null, uncertain = submission ?: state.uncertain,
            error = message ?: if (submission != null) "Связь прервалась. Проверьте историю перед повторной отправкой" else null,
        )
        submission = null
    }
    fun signOut() {
        notificationSeeded = false; previousRunStates = emptyMap()
        rejectRequests(); mirrorId = null
        historyRequest = null; subscribed = null; ref = newId(); lastSendRef = null
        replay = null; replayEchoes = emptyList(); lastReadKey = null
        runMachine.clear(); rpcMachine.clear(); rpcMethod.clear(); mirrorMachine.clear(); pendingOpen.clear()
        state = HubState()
    }
    fun editDraft(text: String) {
        val key = state.target?.key ?: return
        state = state.copy(drafts = state.drafts + (key to text.take(100_000)))
    }
    fun editDraftFor(key: String, text: String) { state = state.copy(drafts = state.drafts + (key to text.take(100_000))) }
    fun restoreDrafts(drafts: Map<String, String>) { state = state.copy(drafts = drafts) }
    fun restoreOutgoing(outgoing: Submission?) { state = state.copy(uncertain = outgoing) }
    fun toggleFavorite(key: String) { state = state.copy(favorites = if (key in state.favorites) state.favorites - key else state.favorites + key) }
    fun markNoticesRead() { state = state.copy(notices = state.notices.map { it.copy(unread = false) }) }
    fun clearHistory() { historyRequest = null; state = state.copy(history = emptyList(), live = emptyList(), loadingHistory = false) }
    fun clearNotices() { state = state.copy(notices = emptyList()) }
    private fun ingestNotices(runs: List<Run>) {
        val fresh = if (!notificationSeeded) emptyList() else runs.filter {
            it.ownerUserId == state.viewer?.userId && it.ownerUserId != null && it.runId != state.runId &&
                it.state in listOf("needs_attention", "idle", "error") && previousRunStates[it.runId] != it.state
        }.map { Notice(newId(), it, now()) }
        previousRunStates = runs.associate { it.runId to it.state }; notificationSeeded = true
        if (fresh.isNotEmpty()) state = state.copy(notices = (fresh.reversed() + state.notices).take(60))
    }
    fun dismissError() { state = state.copy(error = null) }
    fun importShare(key: String, text: String, images: List<ImageInput>): Boolean {
        val combined = state.attachments[key].orEmpty() + images
        if (combined.size > 4 || combined.sumOf { it.data.length.toLong() } > 12_000_000) {
            error("Освободите место во вложениях: максимум 4 изображения и 9 МБ. Материалы сохранены для повторного добавления")
            return false
        }
        state = state.copy(drafts = state.drafts + (key to listOf(state.drafts[key].orEmpty(), text).filter(String::isNotBlank).joinToString("\n\n")),
            attachments = state.attachments + (key to combined))
        return true
    }
    fun recoverUncertain() {
        val pending = state.uncertain ?: return
        if (pending.continuation || importShare(pending.key, pending.text, pending.images)) state = state.copy(uncertain = null)
    }
    fun discardUncertain() { state = state.copy(uncertain = null) }
    private fun sameTurn(line: ChatLine, text: String, images: Int) = line.role == "user" && line.text.trim() == text.trim() && line.imageCount == images
    private fun delivered(sent: Submission, lines: List<ChatLine>) =
        if (sent.before >= 0) lines.count { sameTurn(it, sent.text, sent.images.size) } > sent.before
        else lines.any { sameTurn(it, sent.text, sent.images.size) && it.id !in sent.previousIds }

    fun select(target: Target): Boolean {
        if (state.opening) { state = state.copy(error = "Дождитесь открытия сессии"); return false }
        commitReplay(); leaveSubscription()
        ref = newId(); lastSendRef = null; historyRequest = null; convergeAgain = false
        state = state.copy(target = target, runId = null, history = emptyList(), live = emptyList(),
            approval = null, busy = false, turnStartedAt = null, turnTokens = null, error = null, loadingHistory = false, mirrored = false,
            options = if (target.sessionId == null) (defaultOptions[target.source] ?: RunOptions()).let { o -> if (target.source == "codex" && o.model != null && OpenCode.isGo(o.model) != target.isOpenCode) o.copy(model = null) else o } else RunOptions(), runSettings = null, contextUsage = null, historyLimit = 1000, quickReplies = emptyList(), turnIdle = false, turnFinished = false, subagents = emptyList(), background = emptyList(), compaction = "idle", rateLimit = null)
        loadHistory()
        return true
    }
    fun refresh() { if (state.connection == Connection.READY) loadHistory() }
    private fun leaveSubscription() {
        mirrorId?.let { send(frame("mirror_close") { put("mirrorId", it) }) }; mirrorId = null
        subscribed?.let { send(frame("unsubscribe") { put("runId", it); put("ref", ref) }) }
        subscribed = null
    }
    /** `quiet`: a convergence read after a turn — it must not lock the composer the way an open does. */
    private fun loadHistory(quiet: Boolean = false) {
        val target = state.target ?: return
        if (state.connection != Connection.READY || !state.activeAccess) return
        attach()
        if (target.sessionId == null) return
        if (state.runId == null && state.session?.livePid != null && state.machine?.online == true && mirrorId == null) {
            val id = newId(); mirrorId = id
            if (!send(frame("mirror_open") { put("mirrorId", id); put("machineId", target.machineId)
                put("sessionId", target.sessionId)
                // A private machine's folder is content: the agent finds it from the session id, none goes to the hub.
                put("cwd", if (state.sealedMachine(target.machineId)) "" else target.cwd) })) mirrorId = null
        }
        if (historyRequest != null) return
        val request = newId()
        historyRequest = request; historyDeadline = now() + 30_000; historyQuiet = quiet
        if (!quiet) state = state.copy(loadingHistory = true)
        if (!send(frame("rpc_request") {
            put("requestId", request); put("machineId", target.machineId); put("method", "session.messages")
            putJsonObject("params") {
                put("sessionId", target.sessionId); put("cwd", target.cwd); put("source", target.source)
                put("limit", state.historyLimit); put("toolChars", 4000)
            }
        })) {
            historyRequest = null
            state = state.copy(loadingHistory = false, error = "Не удалось запросить историю")
        }
    }
    private fun attach() {
        val target = state.target ?: return
        if (state.connection != Connection.READY || !state.activeAccess) return
        val run = state.runs.firstOrNull { it.machineId == target.machineId && it.runId == state.runId }
            ?: state.runs.firstOrNull { it.machineId == target.machineId && it.sessionId == target.sessionId }
            ?: return
        if (subscribed == run.runId) return
        state = state.copy(runId = run.runId, busy = run.state == "working", turnStartedAt = if (run.state == "working") run.taskStartedAt?.takeIf { it > 0 }?.coerceAtMost(now()) ?: state.turnStartedAt ?: run.since.takeIf { it > 0 } ?: now() else null)
        if (send(frame("subscribe") { put("runId", run.runId); put("ref", ref) })) subscribed = run.runId
    }
    fun submit(takeover: Boolean = false, continuation: Boolean = false, message: String = "Продолжай") {
        val target = state.target ?: return
        val text = if (continuation) message else state.draft.trim()
        if ((text.isEmpty() && state.images.isEmpty()) || !(state.canSend || (takeover && state.canTakeover))) return
        if (!allowAI()) return
        if (submission != null) { state = state.copy(error = "Предыдущая отправка ещё не подтверждена"); return }
        val runId = state.runId
        val type = if (runId != null) "input" else if (target.sessionId == null) "new_session" else if (takeover && state.canTakeover) "takeover" else "open"
        val images = if (continuation) emptyList() else state.images
        val sendRef = newId()
        val payload = frame(type) {
            put("ref", sendRef)
            if (images.isNotEmpty()) put("images", wireJson.encodeToJsonElement(images))
            if (type == "new_session") {
                if (target.isOpenCode) put("model", OpenCode.startModel(state.options.model, codexModels(target.machineId)))
                else state.options.model?.let { put("model", it) }
                state.options.effort?.let { put("effort", it) }
                state.options.permissionMode?.let { put("permissionMode", it) }
            }
            if (runId != null) { put("runId", runId); put("text", text) }
            else {
                put("machineId", target.machineId); put("message", text)
                if (target.sessionId != null) put("sessionId", target.sessionId)
                else { put("cwd", target.cwd); put("source", target.source) }
            }
        }
        val echoId = "sent:$sendRef"
        val outgoing = Submission(target.key, text, sendRef, now() + 30_000, state.history.map { it.id }.toSet(), images,
            before = state.messages.count { sameTurn(it, text, images.size) }, continuation = continuation, echoId = echoId, correlated = true)
        // Durable before touching the socket: process death can never erase an accepted send.
        val prepared = state.copy(pending = outgoing, drafts = if (continuation) state.drafts else state.drafts + (target.key to ""), attachments = if (continuation) state.attachments else state.attachments - target.key)
        if (!checkpoint(prepared)) { error("Не удалось сохранить сообщение на телефоне. Отправка отменена"); return }
        if (!send(payload)) {
            checkpoint(state)
            state = state.copy(error = sendFailure?.let { "$it Сообщение осталось в черновике" } ?: "Нет соединения. Сообщение осталось в черновике"); return
        }
        lastSendRef = sendRef
        submission = outgoing
        val echo = ChatLine(echoId, "user", text, images = images, ts = now())
        if (replay != null) replayEchoes = replayEchoes + echo
        state = state.copy(
            drafts = if (continuation) state.drafts else state.drafts + (target.key to ""), attachments = if (continuation) state.attachments else state.attachments - target.key, opening = runId == null,
            live = state.live + echo, error = null,
            turnFinished = false, turnIdle = false, quickReplies = emptyList(), rateLimit = null,
        )
    }
    fun interrupt() {
        val runId = state.runId ?: return
        if (state.connection == Connection.READY && state.readOnlyReason == null)
            send(frame("interrupt") { put("runId", runId); put("ref", ref) })
    }
    fun decide(allow: Boolean, answers: Map<String, String> = emptyMap()) = decideStructured(allow, JsonObject(answers.mapValues { JsonPrimitive(it.value) }))
    fun decideStructured(allow: Boolean, answers: JsonObject = buildJsonObject {}, permissionMode: String? = null) {
        val request = state.approval ?: return
        if (state.connection != Connection.READY || state.readOnlyReason != null) return
        if (!allowAI()) return
        if (allow && request.isQuestion && request.questions.any {
            val answer = answers[it.string("id") ?: it.string("question")]
            when (answer) { is JsonArray -> answer.isEmpty(); is JsonPrimitive -> answer.content.isBlank(); else -> true }
        }) return
        val sent = send(frame("tool_decision") {
            put("runId", request.runId); put("requestId", request.requestId); put("allow", allow); put("ref", ref)
            if (allow && request.isQuestion) put("updatedInput", JsonObject(request.input + ("answers" to answers)))
            if (allow && request.tool in listOf("ExitPlanMode", "EnterPlanMode")) put("updatedInput", request.input)
            if (allow && request.tool == "ExitPlanMode" && permissionMode in listOf("default", "acceptEdits")) put("permissionMode", permissionMode)
        })
        if (sent) state = state.copy(approval = null)
    }
    fun tick() {
        if (replay != null && now() >= replayDeadline) commitReplay()
        if (state.compaction in listOf("requested", "running") && now() >= compactionDeadline) state = state.copy(compaction = "failed", error = "Сжатие контекста не подтвердилось. Проверьте состояние и повторите.")
        requests.filterValues { now() >= it.deadline }.keys.toList().forEach { id ->
            requests.remove(id)?.done?.invoke(Result.failure(IllegalStateException("Ответ не получен за 30 секунд")))
        }
        if (historyRequest != null && now() >= historyDeadline) {
            historyRequest = null
            state = state.copy(loadingHistory = false, error = if (historyQuiet) state.error else "История не загрузилась за 30 секунд. Потяните переписку вниз или откройте меню сессии → «Обновить историю»")
            attach()
        }
        if (submission != null && state.runId != null && now() >= submission!!.deadline - 25_000 && historyRequest == null) loadHistory()
        submission?.takeIf { now() >= it.deadline }?.let {
            state = state.copy(opening = false, uncertain = it, error = "Доставка не подтверждена. Проверьте историю перед повторной отправкой")
            submission = null
        }
    }
    fun receive(raw: String) = receive(parseFrame(raw))
    /** A frame already parsed by [parseFrame] — the adapter parses on the socket's thread, so a
     * multi-megabyte snapshot or history never builds its JSON tree on the main thread. */
    fun receive(frame: Result<JsonObject>) {
        val message = frame.getOrElse { state = state.copy(error = it.message); return }
        try { receive(message) }
        catch (_: IllegalArgumentException) { state = state.copy(error = UNREADABLE) }
    }
    companion object {
        private const val UNREADABLE = "Не удалось прочитать ответ хаба. Обновите приложение"
        /** Pure and thread-safe: size cap and JSON parse, no engine state. */
        fun parseFrame(raw: String): Result<JsonObject> {
            if (raw.length > 16 * 1024 * 1024) return Result.failure(IllegalStateException("Ответ хаба слишком большой"))
            return try { Result.success(wireJson.parseToJsonElement(raw).jsonObject) }
            catch (_: IllegalArgumentException) { Result.failure(IllegalStateException(UNREADABLE)) }
        }
    }
    private fun receive(raw: JsonObject) {
        val message = openIncoming(raw) ?: return
        val type = message.string("type") ?: return
        message.string("requestId")?.let { id ->
            if (type in setOf("rpc_response", "memory_list_result", "memory_read_result", "memory_delete_result", "enrich_result")) {
                requests.remove(id)?.let { request ->
                    request.done(if (message["ok"]?.jsonPrimitive?.booleanOrNull == true) Result.success(message)
                        else Result.failure(IllegalStateException(message.string("error") ?: "Ошибка запроса")))
                    return
                }
            }
        }
        val responseRef = message.string("ref")
        if (responseRef != null && responseRef != ref && responseRef != lastSendRef) {
            if (type == "opened") message.string("runId")?.let { id -> send(frame("unsubscribe") { put("runId", id); put("ref", responseRef) }) }
            return
        }
        if (type in setOf("tool_request", "run_status", "error", "mirror_data", "snapshot")) commitReplay()
        when (type) {
            "machine_sessions" -> {
                val machine = wireJson.decodeFromJsonElement<Machine>(message["machine"] ?: return)
                val old = state.machines.indexOfFirst { it.machine.machineId == machine.machine.machineId }
                state = state.copy(machines = if (old < 0) state.machines + machine else state.machines.toMutableList().also { it[old] = machine })
                attach()
            }
            "session_updates" -> {
                val updates = wireJson.decodeFromJsonElement<List<Session>>(message["sessions"] ?: return)
                val removed = (message["removed"] as? JsonArray).orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull }.toSet()
                val byId = updates.associateBy { it.sessionId }
                state = state.copy(machines = state.machines.map { machine ->
                    if (machine.machine.machineId != message.string("machineId")) machine else machine.copy(sessions =
                        (machine.sessions.filter { it.sessionId !in removed && it.sessionId !in byId } + updates.filter { it.sessionId !in removed })
                            .distinctBy { it.sessionId }.sortedWith(compareByDescending<Session> { it.lastModified }.thenBy { it.sessionId }))
                })
                attach()
            }
            "session_reads" -> {
                var reads = state.reads
                (message["reads"] as? JsonArray).orEmpty().forEach { raw ->
                    val row = raw as? JsonObject ?: return@forEach
                    val key = "${row.string("machineId") ?: return@forEach}:${row.string("sessionId") ?: return@forEach}"
                    val at = row["at"]?.jsonPrimitive?.doubleOrNull ?: return@forEach
                    reads = reads + (key to maxOf(reads[key] ?: 0.0, at))
                }
                state = state.copy(reads = reads, notices = state.notices.map { notice ->
                    if ((reads["${notice.run.machineId}:${notice.run.sessionId}"] ?: 0.0) >= notice.run.since) notice.copy(unread = false) else notice
                })
            }
            "session_stage" -> state = state.copy(machines = state.machines.map { machine ->
                if (machine.machine.machineId != message.string("machineId")) machine else machine.copy(sessions = machine.sessions.map {
                    if (it.sessionId == message.string("sessionId")) it.copy(stage = message.string("stage")) else it
                })
            })
            "user_turn" -> receiveUserTurn(message)
            "run_settings" -> if (message.string("runId") == state.runId) {
                state = state.copy(runSettings = message, options = state.options.copy(
                    model = message.string("model"), effort = message.string("effort"),
                    ultracode = message["ultracode"]?.jsonPrimitive?.booleanOrNull == true))
            }
            "run_mode" -> if (message.string("runId") == state.runId)
                state = state.copy(options = state.options.copy(permissionMode = message.string("mode")))
            "context_usage" -> if (message.string("runId") == state.runId) state = state.copy(contextUsage = message)
            "machine_stats", "usage", "codex_usage", "runtime_status", "builder_profile" -> {
                val field = when(type) { "machine_stats" -> "stats"; "runtime_status" -> "runtimes"; "builder_profile" -> "profile"; else -> "usage" }
                val value = message.objectValue(field) ?: return
                state = state.copy(machines = state.machines.map { m ->
                    if (m.machine.machineId != message.string("machineId")) m else when(type) {
                        "machine_stats" -> m.copy(stats = value)
                        "usage" -> m.copy(usage = value)
                        "codex_usage" -> m.copy(codexUsage = value)
                        "runtime_status" -> m.copy(runtimes = value)
                        else -> m.copy(profile = value)
                    }
                })
            }
            "mirror_opened" -> if (message.string("mirrorId") == mirrorId) state = state.copy(mirrored = true)
            "mirror_exit" -> if (message.string("mirrorId") == mirrorId) { mirrorId = null; state = state.copy(mirrored = false) }
            "mirror_data" -> if (message.string("mirrorId") == mirrorId) {
                val lines = historyLines(wireJson.decodeFromJsonElement(message["messages"] ?: return))
                state = state.copy(live = if (message["replace"]?.jsonPrimitive?.booleanOrNull == true) lines else (state.live + lines).takeLast(2000))
            }
            "snapshot" -> {
                val snapshot = wireJson.decodeFromJsonElement<Snapshot>(message)
                val previous = state.viewer
                val identityChanged = previous != null && (previous.userId != snapshot.viewer?.userId || previous.workspace?.workspaceId != snapshot.viewer?.workspace?.workspaceId)
                if (identityChanged) {
                    notificationSeeded = false; previousRunStates = emptyMap()
                    leaveSubscription(); rejectRequests(); historyRequest = null; ref = newId(); lastSendRef = null
                }
                val wasReady = !identityChanged && state.connection == Connection.READY
                val active = snapshot.viewer?.access?.state.let { it == null || it == "active" }
                if (!active) {
                    leaveSubscription(); rejectRequests(); historyRequest = null; lastSendRef = null
                    state = HubState(connection = Connection.READY, viewer = snapshot.viewer)
                    return
                }
                state = (if (identityChanged) HubState() else state).copy(connection = Connection.READY, viewer = snapshot.viewer, machines = snapshot.machines, runs = snapshot.activeRuns)
                if (!notificationSeeded) { previousRunStates = snapshot.activeRuns.associate { it.runId to it.state }; notificationSeeded = true }
                // A newly-created run may have learned its id while the phone was offline.
                val target = state.target
                val recovered = snapshot.activeRuns.firstOrNull { it.runId == state.runId && it.machineId == target?.machineId }
                if (target?.sessionId == null && recovered != null && recovered.sessionId.isNotBlank()) bindSession(recovered.sessionId)
                if (!wasReady) loadHistory() else attach()
            }
            "activity" -> {
                state = state.copy(runs = wireJson.decodeFromJsonElement(message["runs"] ?: return))
                ingestNotices(state.runs)
                val current = state.runs.firstOrNull { it.runId == state.runId }
                if (current != null) state = state.copy(busy = current.state == "working", turnFinished = current.state == "idle", turnStartedAt = if (current.state == "working") current.taskStartedAt?.takeIf { it > 0 }?.coerceAtMost(now()) ?: state.turnStartedAt ?: current.since.takeIf { it > 0 } ?: now() else null)
                attach()
            }
            "rpc_response" -> {
                if (message.string("requestId") != historyRequest) return
                historyRequest = null
                if (message["ok"]?.jsonPrimitive?.booleanOrNull == true) {
                    val messages = message.objectValue("result")?.get("messages") ?: JsonArray(emptyList())
                    val lines = historyLines(wireJson.decodeFromJsonElement(messages))
                    // Keep live events received while the RPC was in flight. The view merges overlap.
                    state = state.copy(history = lines, loadingHistory = false)
                    val pending = submission
                    if (pending != null && pending.key == state.target?.key && delivered(pending, lines)) submission = null
                    // A card asking «did it arrive?» answers itself once the file shows the message.
                    val doubt = state.uncertain
                    if (doubt != null && doubt.key == state.target?.key && delivered(doubt, lines)) state = state.copy(uncertain = null, error = null)
                    // Streamed lines are superseded once the file holds every settled thing they said.
                    if (!state.busy && submission == null && state.live.isNotEmpty() && historyCovers(lines, state.live)) state = state.copy(live = emptyList())
                    if (convergeAgain) { convergeAgain = false; loadHistory(quiet = true) }
                } else state = state.copy(loadingHistory = false, error = if (historyQuiet) state.error else message.string("error") ?: "Не удалось загрузить историю")
                attach()
            }
            "opened" -> {
                val runId = message.string("runId") ?: return
                // The answer to an open this client made must name the machine it asked for; one that names another is
                // the hub's doing and is dropped (only when a keyed machine is involved, as on the web).
                val answered = message.string("machineId")
                val asked = message.string("ref")?.let { pendingOpen[it] }
                if (asked != null && asked != answered) {
                    if (keys.has(asked) || answered != null && keys.has(answered)) {
                        state = state.copy(error = "Хаб ответил за другую машину — ответ отброшен."); return
                    }
                } else message.string("ref")?.let { pendingOpen.remove(it) }
                val known = runMachine[runId]
                if (known != null && known != answered) return
                if (asked != null && asked == answered) runMachine[runId] = asked
                val target = state.target
                val same = target != null && target.machineId == message.string("machineId") &&
                    (target.sessionId == message.string("sessionId") || state.opening || state.runId == runId)
                if (!same) { send(frame("unsubscribe") { put("runId", runId) }); return }
                // `same` holds only for the machine the person chose: that is what the run is attributed to.
                runMachine.getOrPut(runId) { target!!.machineId }
                mirrorId?.let { send(frame("mirror_close") { put("mirrorId", it) }) }; mirrorId = null
                state = state.copy(mirrored = false)
                val isReplay = state.runs.firstOrNull { it.runId == runId }?.state in listOf("working", "needs_attention", "error")
                if (isReplay && state.live.isNotEmpty()) {
                    commitReplay()
                    replayEchoes = state.live.filter { it.role == "user" && (it.id.startsWith("sent:") || it.turnId != null) }
                    replay = emptyList(); replayDeadline = now() + 150
                }
                state = state.copy(runId = runId, opening = false)
                subscribed = runId
                val id = message.string("sessionId")
                if (state.target?.sessionId == null && !id.isNullOrBlank()) bindSession(id)
            }
            "session_started" -> if (message.string("runId") == state.runId) {
                bindSession(message.string("sessionId") ?: return)
            }
            "stream" -> {
                if (message.string("runId") != state.runId) return
                val event = message.objectValue("event") ?: return
                val kind = event.string("kind") ?: return
                val text = event.string("text").orEmpty()
                val code = event.string("code")
                val data = event.objectValue("data")
                when (code) {
                    "background_tasks" -> { state = state.copy(background = (data?.get("tasks") as? JsonArray).orEmpty().mapNotNull { runCatching { wireJson.decodeFromJsonElement<BackgroundTask>(it) }.getOrNull() }.take(32)); return }
                    "subagents" -> { state = state.copy(subagents = parseSubagents(data)); return }
                    "session_state" -> {
                        when (data?.string("state")) {
                            "running" -> state = state.copy(busy = true, turnIdle = false, turnFinished = false)
                            "idle" -> state = state.copy(turnIdle = true)
                        }
                        return
                    }
                    "image_gen" -> {
                        val image = runCatching { wireJson.decodeFromJsonElement<ImageGeneration>(data ?: return) }.getOrNull() ?: return
                        if (image.state !in listOf("started", "done", "failed")) return
                        val lines = liveLines.toMutableList()
                        val index = lines.indexOfFirst { it.generation?.id == image.id }
                        val previous = lines.getOrNull(index)?.generation
                        if (previous?.state in listOf("done", "failed") && image.state == "started") return
                        val merged = image.copy(startedAt = image.startedAt ?: previous?.startedAt, prompt = image.prompt ?: previous?.prompt)
                        val line = ChatLine("image:${image.id}", "assistant", "", imageRefs = listOfNotNull(image.ref), imageCount = if (image.ref != null) 1 else 0, generation = merged)
                        if (index < 0) lines += line else lines[index] = line
                        liveLines = lines.takeLast(2000)
                        return
                    }
                    "rate_limit" -> {
                        val words = rateLimitWords(data, text)
                        state = state.copy(rateLimit = if (data?.string("status") == "allowed") null else words)
                        if (data?.string("status") == "rejected" && liveLines.none { it.role == "notice" && it.text == words }) liveLines = liveLines + ChatLine(newId(), "notice", words)
                        return
                    }
                    "compact_started", "compact_done", "compact_failed" -> {
                        val phase = when(code) { "compact_started" -> "running"; "compact_done" -> "completed"; else -> "failed" }
                        state = state.copy(compaction = phase)
                        compactionDeadline = now() + 190_000
                        val words = when(phase) { "running" -> "Сжимаем контекст…"; "completed" -> "Контекст сжат"; else -> text.ifBlank { "Не удалось сжать контекст" } }
                        val lines = liveLines.toMutableList()
                        val index = lines.indexOfLast { it.id.startsWith("compact:") }
                        val line = ChatLine(if (index >= 0) lines[index].id else "compact:${newId()}", "notice", words)
                        if (index >= 0 && (phase != "running" || lines[index].text == "Сжимаем контекст…")) lines[index] = line else lines += line
                        liveLines = lines
                        return
                    }
                }
                if (code == "turn_started") state = state.copy(busy = true, turnIdle = false, turnFinished = false, turnStartedAt = now(), turnTokens = null, quickReplies = emptyList())
                if (code == "turn_usage") {
                    val tokens = event.objectValue("data")?.get("totalTokens")?.jsonPrimitive?.longOrNull?.takeIf { it >= 0 }
                    state = state.copy(turnTokens = tokens ?: state.turnTokens, turnStartedAt = state.turnStartedAt ?: now(), busy = true)
                    return
                }
                if (!state.busy && kind in listOf("partial", "assistant", "tool_use")) state = state.copy(turnStartedAt = now(), turnTokens = null)
                // A stream event is not an acknowledgement of an input. Confirm through history.
                val lines = liveLines.toMutableList()
                val tail = lines.lastOrNull()
                when (kind) {
                    "partial" -> if (tail?.streaming == true) lines[lines.lastIndex] = tail.copy(text = tail.text + text)
                        else lines += ChatLine(newId(), "assistant", text, true)
                    "assistant" -> if (tail?.streaming == true) lines[lines.lastIndex] = tail.copy(text = text.ifEmpty { tail.text }, streaming = false)
                        else if (text.isNotEmpty()) lines += ChatLine(newId(), "assistant", text)
                    "result" -> if (tail?.streaming == true) lines[lines.lastIndex] = tail.copy(streaming = false)
                    // The agent streams a tool call as "Name {json}" (agent/src/claude-session.ts).
                    "tool_use" -> if (text.isNotEmpty()) {
                        val name = text.substringBefore(' ')
                        val input = text.substringAfter(' ', "").takeIf { it.isNotBlank() }?.let { runCatching { wireJson.parseToJsonElement(it) }.getOrNull() ?: JsonPrimitive(it) }
                        lines += ChatLine(newId(), "system", text, blocks = listOf(Block("tool_use", name = name, input = input)))
                    }
                    "error" -> if (text.isNotEmpty()) lines += ChatLine(newId(), "error", text)
                    "status" -> {
                        val value = text.trim()
                        if (value.isNotEmpty() && value !in listOf("→ completed", "completed", "done")) {
                            lines += if (statusFolds(value)) ChatLine(newId(), "system", value, blocks = listOf(Block("output", text = value)))
                                else ChatLine(newId(), "notice", value.removeSuffix("\n→ completed"))
                        }
                    }
                    // `system` events are init/model noise, not conversation.
                }
                liveLines = lines.takeLast(2000)
                state = state.copy(turnFinished = when(kind) { "result" -> true; "partial", "assistant", "tool_use" -> false; else -> state.turnFinished },
                    turnIdle = if (kind in listOf("partial", "assistant", "tool_use")) false else state.turnIdle, busy = when (kind) {
                    "result", "error" -> false
                    "partial", "assistant", "tool_use" -> true
                    else -> state.busy
                })
                // The turn is over: re-read the file so it supersedes the stream (see `rpc_response`).
                if (kind == "result" && state.target?.sessionId != null) { commitReplay(); if (historyRequest != null) convergeAgain = true else loadHistory(quiet = true) }
            }
            "tool_request" -> if (message.string("runId") == state.runId) {
                state = state.copy(busy = false, approval = Approval(
                    state.runId!!, message.string("requestId") ?: return,
                    message.string("tool") ?: return, message.objectValue("input") ?: buildJsonObject {}, message.string("title"),
                ))
                if (submission != null) loadHistory()
            }
            "tool_resolved" -> if (message.string("requestId") == state.approval?.requestId && message.string("runId") == state.approval?.runId)
                state = state.copy(approval = null)
            "run_status" -> if (message.string("runId") == state.runId) {
                val status = message.string("state")
                if (message.string("code") == "resume_refused") restoreSubmission()
                val terminal = status in listOf("ended", "error", "yielded")
                state = state.copy(busy = status == "started", opening = false,
                    runId = if (terminal) null else state.runId, approval = if (terminal) null else state.approval,
                    error = message.string("error") ?: state.error)
                if (terminal) subscribed = null
            }
            "error" -> {
                val code = message.string("code")
                if (code != "attachments_dropped") restoreSubmission()
                state = state.copy(opening = state.opening && code == "attachments_dropped", error = message.string("message") ?: "Ошибка хаба")
                if (code == "run_gone") { subscribed = null; state = state.copy(runId = null) }
                if (code == "run_active") message.string("runId")?.let { id ->
                    state = state.copy(runId = id)
                    if (send(frame("subscribe") { put("runId", id); put("ref", ref) })) subscribed = id
                }
            }
        }
    }
    private fun receiveUserTurn(message: JsonObject) {
        val target = state.target ?: return
        if (message.string("runId") != state.runId || message.string("sessionId") != target.sessionId.orEmpty()) return
        val turnId = message.string("turnId") ?: return
        val text = message.string("text") ?: return
        val images = message["images"]?.jsonPrimitive?.intOrNull ?: 0
        val truncated = message["truncated"]?.jsonPrimitive?.booleanOrNull == true
        // A direct command reply carries its submission ref; replay carries the subscription ref.
        // Content cannot identify a send: repeated text may have entirely different attachments.
        val accepted = (state.pending ?: state.uncertain)?.takeIf {
            it.key == target.key && it.correlated && message.string("ref") == it.ref && images == it.images.size
        }
        val lines = liveLines.toMutableList()
        if (accepted == null && lines.any { it.turnId == turnId }) return
        val candidates = lines + replayEchoes
        val echo = accepted?.let { sent ->
            candidates.firstOrNull { it.id == sent.echoId }
                ?: ChatLine(sent.echoId ?: "sent:${sent.ref}", "user", sent.text, images = sent.images)
        } ?: candidates.firstOrNull { it.turnId == turnId }
        val line = (echo ?: ChatLine("turn:$turnId", "user", text, imageCount = images)).copy(turnId = turnId,
            ts = message["ts"]?.jsonPrimitive?.longOrNull ?: echo?.ts, truncated = truncated && echo == null,
            files = (message["files"] as? JsonArray).orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull })
        val at = lines.indexOfFirst { it.id == line.id || it.turnId == turnId }
        if (at >= 0) lines[at] = line else lines += line
        if (echo != null) replayEchoes = replayEchoes.filterNot { it.id == echo.id }
        liveLines = lines.takeLast(2000)
        if (accepted != null) state = state.copy(pending = null, uncertain = null, error = null)
    }
    private fun bindSession(id: String) {
        val old = state.target ?: return
        val target = old.copy(sessionId = id)
        val pending = submission?.copy(key = target.key)
        state = state.copy(target = target, drafts = state.drafts - old.key + (target.key to state.draft),
            attachments = state.attachments - old.key + (target.key to state.images),
            pending = pending, uncertain = state.uncertain?.let { if (it.key == old.key) it.copy(key = target.key) else it })
    }
    private fun restoreSubmission() {
        val pending = submission ?: return
        state = state.copy(pending = null, uncertain = pending,
            live = state.live.filterNot { it.role == "user" && it.text == pending.text && it.id.startsWith("sent:") })
        recoverUncertain()
    }
    private fun newId() = UUID.randomUUID().toString()
}
