package net.hegai.code

import android.app.Application
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import net.hegai.code.core.*
import net.hegai.code.core.Target
import net.hegai.code.core.Connection
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.util.concurrent.TimeUnit

class HubViewModel(application: Application, private val saved: SavedStateHandle) : AndroidViewModel(application) {
    /** Chosen hub origin (`https://host[:port]`), see [HubConfig]; every hub URL below derives from it. */
    private var hub = HubConfig.base(application)
    private val _hubBase = MutableStateFlow(hub)
    val hubBase = _hubBase.asStateFlow()
    /** The workspace session, bound to the hub that issued it ([HubSession]). */
    private val vault = HubSession(application)
    private val browserSignIn = BrowserSignIn(application)
    private var signingIn = false
    private var authEpoch = 0
    private var telegramJob: Job? = null
    private var telegramStopped = false
    private var googleLinkEpoch: Int? = null
    private val _telegram = MutableStateFlow<TelegramPhase?>(null)
    val telegram = _telegram.asStateFlow()
    private val telegramMemoVault = SessionVault(application, "telegram-memo")
    private val _telegramMemo = MutableStateFlow(runCatching { wireJson.parseToJsonElement(telegramMemoVault.read() ?: "null") as? JsonObject }.getOrNull())
    val telegramMemo = _telegramMemo.asStateFlow()
    private val _identityRevision = MutableStateFlow(0)
    val identityRevision = _identityRevision.asStateFlow()
    fun forgetTelegramMemo() { telegramMemoVault.clear(); _telegramMemo.value = null }

    private val lastIdentity = SessionVault(application, "last-account")
    private val pushOwner = SessionVault(application, "push-owner")
    private val pushToken = SessionVault(application, "push-token")
    /** Which machines are private, for a notification that must decide without the hub (PushNotifications.cachedPrivate). */
    private val privateMachinesVault = SessionVault(application, "private-machines")
    private var lastPrivateIds: List<String>? = null
    /** Declared before `init`: init retries a pending revocation on a background thread, and a property
     * declared below init is still null then — 0.2.3 crashed on launch whenever that thread won the race. */
    private val pendingRevoke = SessionVault(application, "pending-revoke")
    /** Guards the read-modify-write of [pendingRevoke] (a queue in one stored string). Declared before the
     *  stored session is opened below, which may queue a revocation during construction. */
    private val revokeLock = Any()
    private var pushRegistered: String? = null
    private var identitySaved: String? = null
    private var notificationWorkspace: String? = null
    private var notificationTarget: Triple<String, String, String>? = null
    data class SharePayload(val text: String, val uris: List<android.net.Uri>)
    private val _share = MutableStateFlow<SharePayload?>(null)
    val share = _share.asStateFlow()
    private val _report = MutableStateFlow<ReportLink?>(null)
    val report = _report.asStateFlow()
    fun openReport(raw: String): Boolean {
        val link = ReportLink.parse(raw, hub) ?: return false
        _report.value = link; return true
    }
    fun closeReport() { _report.value = null }
    suspend fun reportContent(link: ReportLink): String {
        val credential = token ?: error("Войдите в аккаунт")
        val stamp = cacheEpoch
        val content = withContext(Dispatchers.IO) {
            http.newBuilder().readTimeout(30, TimeUnit.SECONDS).followRedirects(false).build().newCall(
                Request.Builder().url(endpoint.toHttpUrl().newBuilder().encodedPath(link.contentPath).query(null).build()).header("Authorization", "Bearer $credential").build()
            ).execute().use { response ->
                check(response.isSuccessful) { if (response.code in listOf(403, 404)) "Отчёт не найден или вам недоступен" else "HTTP ${response.code}" }
                val body = response.body ?: error("Пустой отчёт")
                check(body.contentLength() <= 20_000_000) { "Отчёт слишком большой" }
                val source = body.source()
                source.request(20_000_001)
                val bytes = source.buffer.readByteArray()
                check(bytes.size <= 20_000_000) { "Отчёт слишком большой" }
                bytes.toString(Charsets.UTF_8)
            }
        }
        check(stamp == cacheEpoch && token == credential) { "Аккаунт изменился" }
        return ReportLink.hardened(content)
    }

    fun receiveShare(text: String, uris: List<android.net.Uri>) { _share.value = SharePayload(text.take(100_000), uris.filter { it.scheme == "content" }.take(4)) }
    fun cancelShare() { _share.value = null }
    private var importingShare = false
    fun selectShared(target: Target) {
        val payload = _share.value ?: run { engine.select(target); return }
        if (importingShare || _restoring.value || !engine.select(target)) return
        importingShare = true
        val stamp = cacheEpoch
        viewModelScope.launch {
            try {
                val images = withContext(Dispatchers.IO) { payload.uris.map { Attachments.read(getApplication(), it) } }
                if (stamp == cacheEpoch && engine.importShare(target.key, payload.text, images) && _share.value === payload) _share.value = null
            } catch (e: Exception) { engine.error(e.message ?: "Не удалось прикрепить изображение") }
            finally { importingShare = false }
        }
    }
    suspend fun importImages(targetKey: String, uris: List<android.net.Uri>): Boolean {
        val epoch = cacheEpoch
        val images = withContext(Dispatchers.IO) { uris.take(4).map { Attachments.read(getApplication(), it) } }
        check(epoch == cacheEpoch) { "Пространство изменилось. Добавьте изображения ещё раз" }
        return engine.importShare(targetKey, "", images)
    }
    fun openNotification(userId: String?, machineId: String?, sessionId: String?, workspace: String? = null) {
        if (userId == null || machineId == null || sessionId == null) return
        notificationWorkspace = workspace?.takeIf(String::isNotBlank)
        notificationTarget = Triple(userId, machineId, sessionId)
        followNotification(state.value)
    }
    /** Applies this account's saved workspace after the first READY snapshot; true when it started a switch. */
    private fun adoptSavedWorkspace(next: HubState, viewer: Viewer): Boolean {
        if (workspaceChecked) return false
        workspaceChecked = true
        val key = workspacePrefKey(hub, viewer.userId)
        val stored = prefs.getString(key, null) ?: return false
        val saved = savedWorkspace(stored, selectableWorkspaces(viewer.workspaces))
        if (saved == null) { prefs.edit().remove(key).apply(); return false }
        // A tapped notification for this person wins for this process (its session lives where it says).
        val notificationPending = notificationTarget?.first == viewer.userId
        // An unconfirmed send lives in this workspace's cache: switching away would strand it (personal may no
        // longer be offered anywhere). The pick applies on a later launch, once nothing is in flight.
        if (next.pending != null || next.uncertain != null) return false
        if (saved == viewer.workspace?.workspaceId || saved == workspaceId || notificationPending) return false
        return switchWorkspace(saved)
    }
    private fun followNotification(next: HubState) {
        val (user, machine, session) = notificationTarget ?: return
        if (next.connection != Connection.READY || _restoring.value) return
        if (next.viewer?.userId != user) { notificationTarget = null; notificationWorkspace = null; return }
        val requestedWorkspace = notificationWorkspace
        if (requestedWorkspace != null && requestedWorkspace != next.viewer?.workspace?.workspaceId) {
            if (next.viewer?.workspaces?.any { it.workspaceId == requestedWorkspace } == true) { notificationWorkspace = null; viewModelScope.launch { switchWorkspace(requestedWorkspace, remember = false) } }
            return
        }
        val info = next.machines.firstOrNull { it.machine.machineId == machine }?.sessions?.firstOrNull { it.sessionId == session } ?: return
        notificationTarget = null; notificationWorkspace = null
        viewModelScope.launch { engine.select(Target(machine, info.cwd.orEmpty(), session, info.title, info.source)) }
    }
    fun setNotifications(enabled: Boolean) {
        prefs.edit().putBoolean("notifications", enabled).apply()
        if (!enabled) {
            pushToken.read()?.let { engine.command("unregister_push", buildJsonObject { put("deviceToken", it); put("platform", "android") }) }
            pushOwner.clear(); pushRegistered = null
            androidx.core.app.NotificationManagerCompat.from(getApplication()).cancelAll()
        } else syncPush(state.value)
    }
    private fun syncPush(next: HubState) {
        val user = next.viewer?.userId ?: return
        val context = getApplication<Application>()
        if (!next.activeAccess || next.connection != Connection.READY || !PushNotifications.enabled(context) || !PushNotifications.available(context)) return
        val key = "$generation:$user:${currentPushToken().orEmpty()}"
        if (pushRegistered == key) return
        pushRegistered = key
        pushOwner.write(user)
        com.google.firebase.messaging.FirebaseMessaging.getInstance().token.addOnSuccessListener { value ->
            if (pushRegistered != key || engine.state.viewer?.userId != user || !PushNotifications.enabled(context)) return@addOnSuccessListener
            pushToken.write(value); pushTokenCache = value; pushTokenLoaded = true
            if (!engine.command("register_push", buildJsonObject { put("deviceToken", value); put("platform", "android") })) pushRegistered = null
        }.addOnFailureListener { if (pushRegistered == key) pushRegistered = null }
    }
    /** The FCM token, decrypted once: syncPush runs on every ready publication (every streamed token),
     * and a Keystore decrypt there was main-thread work per frame. */
    private var pushTokenCache: String? = null
    private var pushTokenLoaded = false
    private fun currentPushToken(): String? {
        if (!pushTokenLoaded) { pushTokenCache = pushToken.read(); pushTokenLoaded = true }
        return pushTokenCache
    }
    private var fingerprintOf: Pair<String, String>? = null
    private fun fingerprint(value: String): String = fingerprintOf?.takeIf { it.first == value }?.second
        ?: fingerprintRaw(value).also { fingerprintOf = value to it }
    private fun fingerprintRaw(value: String) = java.security.MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }

    private val http = OkHttpClient.Builder().pingInterval(25, TimeUnit.SECONDS)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS).build()
    private var socket: WebSocket? = null
    private var generation = 0
    private var reconnect: Job? = null
    private var foreground = false
    private var failures = 0
    private var token: String? = openStoredSession()
    /** A stored session for another hub is never used: it is cleared and revoked where it was issued. */
    private fun openStoredSession(): String? = when (val stored = vault.open(hub)) {
        null -> null
        is SessionBinding.Opened.Valid -> stored.token
        is SessionBinding.Opened.Foreign -> {
            // Queue the revocation where it was issued BEFORE dropping the only copy; if queuing fails the sealed
            // session stays (it is never sent here) and the next start tries again. An unknown origin cannot be
            // revoked safely anywhere, so it is just dropped.
            val queued = stored.hub?.let { origin -> runCatching { queueRevoke(origin, stored.token) }.isSuccess } ?: true
            if (queued) vault.clear()
            null
        }
    }
    private var endpoint = HubUrl.ui(hub)
    private var prefetchKey = ""
    private var prefetchJob: Job? = null
    private val _prefetch = MutableStateFlow<Pair<Int, Int>?>(null)
    val prefetch = _prefetch.asStateFlow()
    private val _projectCatalog = MutableStateFlow<Map<String, List<String>>>(emptyMap())
    val projectCatalog = _projectCatalog.asStateFlow()
    /** Per machine: folders `projects.list` marks `origin: "root"` — the only ones «Удалить с машины» may offer. */
    private val _removableProjects = MutableStateFlow<Map<String, Set<String>>>(emptyMap())
    val removableProjects = _removableProjects.asStateFlow()
    private val _sharedProjects = MutableStateFlow<List<SharedProject>>(emptyList())
    /** Projects shared into the current organization workspace with control access (a member may have no sessions there yet). */
    val sharedProjects = _sharedProjects.asStateFlow()
    private var sharedAsk = ""
    private var projectAsk = ""
    private var projectAskedAt = 0L
    private val _state = MutableStateFlow(HubState())
    val state = _state.asStateFlow()
    private val _signedIn = MutableStateFlow(token != null)
    val signedIn = _signedIn.asStateFlow()
    private val _authError = MutableStateFlow<String?>(null)
    val authError = _authError.asStateFlow()
    private val consentVault = SessionVault(application, "ai-consent")
    private var consents = runCatching { wireJson.parseToJsonElement(consentVault.read() ?: "{}").jsonObject }.getOrDefault(buildJsonObject {})
    private val _aiConsented = MutableStateFlow(false)
    val aiConsented = _aiConsented.asStateFlow()
    private val _consentDialog = MutableStateFlow(false)
    val consentDialog = _consentDialog.asStateFlow()
    fun requestAIDataConsent(): Boolean {
        if (BuildConfig.DEBUG && token == "dev-token") return true
        if (_aiConsented.value && engine.state.viewer != null && engine.state.activeAccess) return true
        _consentDialog.value = true; return false
    }
    fun closeConsentDialog() { _consentDialog.value = false }
    fun setAIConsent(allowed: Boolean) {
        val user = engine.state.viewer?.userId ?: return
        val key = fingerprint(user)
        val next = if (allowed) JsonObject(consents + (key to JsonPrimitive("2026-09-26"))) else JsonObject(consents - key)
        consentVault.write(next.toString()); consents = next
        _aiConsented.value = allowed; _consentDialog.value = false
        if (!allowed) engine.setQuickReplies(emptyList(), engine.state.target?.key.orEmpty())
    }
    private val cache = PrivateCache(application)
    @Volatile private var cacheScope: String? = null
    @Volatile private var cacheEpoch = 0
    @Volatile private var writeRevision = 0L
    private var bootstrapped = false
    private var saveJob: Job? = null
    private var conversations = linkedMapOf<String, ConversationCache>()
    private var workspaceId: String? = null
    /** Once per account per process: the saved choice was compared with what the hub returned. Not per connection — a reconnect
     *  after a notification jump must not drag the person back, and a hub that ignored the pick must not cause a loop. */
    private var workspaceChecked = false
    private val prefs = application.getSharedPreferences("appearance", 0)
    private val _theme = MutableStateFlow(prefs.getString("theme", "system") ?: "system")
    val theme = _theme.asStateFlow()
    private val _voiceMode = MutableStateFlow(prefs.getString("voice", "server") ?: "server")
    val voiceMode = _voiceMode.asStateFlow()
    fun setVoiceMode(value: String) { if (value in listOf("server", "phone")) { _voiceMode.value = value; prefs.edit().putString("voice", value).apply() } }
    private val _automated = MutableStateFlow(prefs.getBoolean("automated", false))
    val automated = _automated.asStateFlow()
    fun setAutomated(value: Boolean) { _automated.value = value; prefs.edit().putBoolean("automated", value).apply() }
    fun defaultOptions(source: String): RunOptions = runCatching { wireJson.decodeFromString<RunOptions>(prefs.getString("defaults-$source", "{}")!!) }.getOrDefault(RunOptions())
    fun setDefaults(source: String, value: RunOptions) {
        prefs.edit().putString("defaults-$source", wireJson.encodeToString(value)).apply()
        engine.defaultOptions = engine.defaultOptions + (source to value)
    }
    private val enriched = linkedSetOf<String>()
    suspend fun enrichConversation() {
        val current = engine.state
        if (!_aiConsented.value && !(BuildConfig.DEBUG && token == "dev-token")) return
        val target = current.target ?: return
        val session = target.sessionId ?: return
        // Suggestions and titles are made by the hub from plaintext: never for a private machine (docs/E2EE.md).
        if (current.sealedMachine(target.machineId)) return
        if (current.busy || current.approval != null || current.opening || current.loadingHistory || current.connection != Connection.READY) return
        val line = current.messages.lastOrNull { it.role == "assistant" && it.text.isNotBlank() && !it.streaming } ?: return
        val key = "$cacheEpoch:${target.key}:${line.text.hashCode()}"
        if (!enriched.add(key)) return
        while (enriched.size > 100) enriched.remove(enriched.first())
        val epoch = cacheEpoch
        fun body(purpose: String? = null, text: String = line.text) = buildJsonObject {
            put("machineId", target.machineId); put("sessionId", session); put("source", target.source)
            put("uuid", line.id.take(200)); put("text", text.takeLast(16_000))
            current.messages.lastOrNull { it.role == "user" }?.let { put("userText", it.text.takeLast(4000)) }
            purpose?.let { put("purpose", it) }
        }
        runCatching { request("enrich_request", body()).objectValue("enrichment")?.rows("quickReplies").orEmpty() }
            .onSuccess { if (epoch == cacheEpoch) engine.setQuickReplies(it, target.key) }
        if (current.titles[target.key] == null && epoch == cacheEpoch) {
            runCatching {
                val opening = rpc(target.machineId, "session.messages", buildJsonObject { put("sessionId", session); put("cwd", target.cwd); put("source", target.source); put("head", true); put("limit", 40); put("toolChars", 0) })
                val messages = wireJson.decodeFromJsonElement<List<HistoryMessage>>(opening["messages"] ?: JsonArray(emptyList()))
                val text = historyLines(messages).filter { it.role != "system" }.take(6).joinToString("\n\n") { it.text }.take(8000) + "\n\n" + line.text.takeLast(7000)
                request("enrich_request", body("session_title", text)).objectValue("enrichment")?.string("sessionTitle")
            }.onSuccess { if (it != null && epoch == cacheEpoch) engine.generatedTitle(it, target.key, current.session?.title ?: target.title) }
        }
    }
    fun clearHistoryCache() { dropPendingSave(); cacheEpoch++; conversations.clear(); engine.clearHistory(); if (!persistNow(engine.state)) engine.error("Не удалось очистить историю на телефоне") }
    fun setTheme(value: String) { _theme.value = value; prefs.edit().putString("theme", value).apply() }
    private val _restoring = MutableStateFlow(false)
    val restoring = _restoring.asStateFlow()
    private var restoredOwner: String? = null
    private val archived = saved.get<HashMap<String, String>>("accountDrafts") ?: hashMapOf()
    /** Private machines (docs/E2EE.md): the key ring (Keystore-wrapped) and the pairing dialog's request. */
    val e2ee = E2eeStore.get(application)
    private val _pairRequest = MutableStateFlow<PairRequest?>(null)
    val pairRequest = _pairRequest.asStateFlow()
    fun requestPair(machineId: String?, machineName: String? = null) {
        val name = machineName ?: engine.state.machines.firstOrNull { it.machine.machineId == machineId }?.machine?.name
        _pairRequest.value = PairRequest(machineId, name)
    }
    fun closePair() { _pairRequest.value = null }
    /** [done] gets null on success, else the words for the person. Reconnects: what already arrived was placeholders. */
    fun pair(code: String, expect: String?, done: (String?) -> Unit) {
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { e2ee.add(code, expect) }
                done(null); closePair(); retry()
            } catch (e: E2eeStore.PairingException) { done(e.message) }
            catch (_: Exception) { done("Не удалось сохранить ключ на этом телефоне.") }
        }
    }
    fun forgetKey(machineId: String) {
        viewModelScope.launch {
            try { withContext(Dispatchers.IO) { e2ee.forget(machineId) }; closePair(); retry() }
            catch (e: E2eeStore.PairingException) { engine.error(e.message ?: "Не удалось забыть ключ") }
        }
    }
    val engine = HubEngine(send = { socket?.send(it.toString()) == true }, changed = ::publish, checkpoint = ::persistNow, allowAI = ::requestAIDataConsent,
        keys = e2ee.keys, needKey = { machineId -> requestPair(machineId) })
    init {
        engine.keysChanged(e2ee.machines.value)
        viewModelScope.launch { e2ee.machines.collect { engine.keysChanged(it) } }
        engine.defaultOptions = mapOf("claude" to defaultOptions("claude"), "codex" to defaultOptions("codex"))
        engine.codexModels = { machineId -> cachedModels(machineId, "codex") }
        val credential = token
        viewModelScope.launch {
            val stamp = generation
            if (credential != null) {
                val identity = withContext(Dispatchers.IO) { runCatching { wireJson.parseToJsonElement(lastIdentity.read() ?: "{}").jsonObject }.getOrNull() }
                if (identity?.string("binding") == fingerprint(credential) && token == credential && engine.state.viewer == null && stamp == generation) {
                    val scope = identity.string("scope")
                    val viewer = identity["viewer"]?.let { runCatching { wireJson.decodeFromJsonElement<Viewer>(it) }.getOrNull() }
                    val offline = scope?.let { withContext(Dispatchers.IO) { cache.read(it) } }
                    if (viewer != null && offline != null && token == credential && stamp == generation && engine.state.viewer == null) {
                        // Ask for the person's own pick, not whatever the cache last showed (a notification jump, or
                        // the old personal default from before picks were saved): no pick = no param, the hub decides.
                        // Exceptions stay where the cache is: a tapped notification, and an unconfirmed send — its
                        // workspace may be one the switchers no longer offer, so leaving it would strand the message.
                        workspaceId = if (notificationTarget != null || offline.outgoing != null) viewer.workspace?.workspaceId
                            else savedWorkspace(prefs.getString(workspacePrefKey(hub, viewer.userId), null), selectableWorkspaces(viewer.workspaces))
                        engine.restoreOffline(viewer, offline)
                    }
                }
            }
            bootstrapped = true
            if (foreground && token != null && socket == null) connect()
        }
        viewModelScope.launch { while (isActive) { delay(1000); engine.tick() } }
        revokePending()
    }
    private fun publish(next: HubState) {
        _state.value = next
        _aiConsented.value = next.viewer?.userId?.let { consents.string(fingerprint(it)) == "2026-09-26" } == true
        val viewer = next.viewer ?: return
        val owner = viewer.userId + ":" + (viewer.workspace?.workspaceId ?: "personal")
        if (!next.activeAccess) {
            val old = cacheScope; cacheScope = null; conversations.clear(); dropPendingSave(); cacheEpoch++
            _restoring.value = false; pushOwner.clear(); lastIdentity.clear(); pushRegistered = null
            if (old != null) viewModelScope.launch(Dispatchers.IO) { cache.remove(old) }
            return
        }
        if (cacheScope != owner) {
            prefetchJob?.cancel(); prefetchKey = ""; _prefetch.value = null
            cacheScope = owner; conversations.clear(); dropPendingSave(); _restoring.value = true
            val epoch = ++cacheEpoch
            viewModelScope.launch {
                val stored = withContext(Dispatchers.IO) { cache.read(owner) }
                if (epoch != cacheEpoch || cacheScope != owner) return@launch
                if (stored != null) {
                    conversations.putAll(stored.conversations)
                    engine.restoreCache(stored)
                    engine.state.target?.let { target -> conversations[target.key]?.let { engine.showCached(it.messages, target.key) } }
                }
                _restoring.value = false
                publish(engine.state)
            }
            return
        }
        if (_restoring.value) return
        if (next.connection == Connection.READY) {
            val privateIds = next.machines.filter { it.machine.isPrivate }.map { it.machine.machineId }.sorted()
            if (privateIds != lastPrivateIds) { lastPrivateIds = privateIds; privateMachinesVault.write(JsonArray(privateIds.map(::JsonPrimitive)).toString()) }
            if (adoptSavedWorkspace(next, viewer)) return
            syncPush(next); followNotification(next)
            prefetchRecent()
            val credential = token
            val identityKey = "$owner:${credential?.let(::fingerprint)}"
            if (credential != null && identitySaved != identityKey) {
                identitySaved = identityKey
                lastIdentity.write(buildJsonObject { put("scope", owner); put("binding", fingerprint(credential)); put("viewer", wireJson.encodeToJsonElement(viewer)) }.toString())
            }
        }
        // Copying the transcript into the cache is the save's job, not every frame's; only leaving a
        // conversation settles it right away (select publishes empty messages, so check before that).
        unsaved?.takeIf { it.target != null && it.target?.key != next.target?.key }?.let(::rememberConversation)
        next.target?.takeIf { next.messages.isEmpty() && (next.loadingHistory || next.connection != Connection.READY) }?.let { target ->
            conversations[target.key]?.let { stored -> viewModelScope.launch { engine.showCached(stored.messages, target.key) } }
        }
        scheduleSave(next)
    }
    /** The newest state not yet written; the running save picks it up instead of restarting its timer. */
    private var unsaved: HubState? = null
    /** Every scope/epoch change drops BOTH: a leftover `unsaved` would carry the old account's chat into the next one. */
    private fun dropPendingSave() { saveJob?.cancel(); unsaved = null }
    private fun rememberConversation(next: HubState) {
        val target = next.target ?: return
        // A private machine's decrypted transcript is never written to the phone's cache (docs/E2EE.md, web parity).
        if (next.sealedMachine(target.machineId)) { conversations.remove(target.key); return }
        if (next.messages.isEmpty()) return
        conversations.remove(target.key)
        conversations[target.key] = ConversationCache(target, next.messages.takeLast(1000).map { it.copy(images = emptyList()) })
        while (conversations.size > 12) conversations.remove(conversations.keys.first())
        // Bound disk cache independently of the network/history window.
        while (conversations.size > 1 && conversations.values.sumOf { c -> c.messages.sumOf { it.weight } } > 4_000_000)
            conversations.remove(conversations.keys.first())
    }
    /** What of a private machine may rest on the phone: its sessions as the placeholders the hub itself holds. */
    private fun cacheSnapshot(next: HubState) = AccountCache(
        next.machines.map { m ->
            if (!next.sealedMachine(m.machine.machineId)) m
            else m.copy(sessions = m.sessions.map { it.copy(title = E2ee.PLACEHOLDER, cwd = null, project = null, gitBranch = null) })
        },
        next.drafts, next.attachments, next.pending ?: next.uncertain,
        conversations.filterValues { !next.sealedMachine(it.target.machineId) },
        next.target?.takeUnless { next.sealedMachine(it.machineId) },
        next.titles.filterKeys { key -> next.keyed.none { key.startsWith("$it:") } && next.machines.none { it.machine.isPrivate && key.startsWith("${it.machine.machineId}:") } },
        next.notices, next.favorites)
    private fun persistNow(next: HubState): Boolean {
        val owner = cacheScope ?: return next.viewer == null
        if (_restoring.value) return false
        dropPendingSave()
        rememberConversation(next)
        val epoch = cacheEpoch
        val revision = ++writeRevision
        return runCatching { cache.write(owner, cacheSnapshot(next)) { revision == writeRevision && epoch == cacheEpoch && owner == cacheScope } }.isSuccess
    }
    /** At most one write per 250 ms while frames keep coming. The old version restarted its timer on
     * every frame (and copied the transcript before it), so a long answer did all the copying and
     * saved nothing until it ended. */
    private fun scheduleSave(next: HubState) {
        cacheScope ?: return
        if (_restoring.value) return
        unsaved = next
        if (saveJob?.isActive == true) return
        val epoch = cacheEpoch
        saveJob = viewModelScope.launch {
            while (true) {
                delay(250)
                val latest = unsaved ?: break
                unsaved = null
                val owner = cacheScope ?: break
                if (epoch != cacheEpoch || _restoring.value) break
                rememberConversation(latest)
                val snapshot = cacheSnapshot(latest)
                val revision = ++writeRevision
                withContext(Dispatchers.IO) {
                    runCatching { cache.write(owner, snapshot) { revision == writeRevision && epoch == cacheEpoch && owner == cacheScope } }
                        .onFailure { withContext(Dispatchers.Main) { if (epoch == cacheEpoch) _authError.value = "Не удалось сохранить данные на телефоне" } }
                }
            }
        }
    }
    suspend fun request(type: String, body: JsonObject = buildJsonObject {}): JsonObject = suspendCancellableCoroutine { continuation ->
        val id = engine.request(type, body) { result -> if (continuation.isActive) result.fold(continuation::resume, continuation::resumeWithException) }
        continuation.invokeOnCancellation { viewModelScope.launch { id?.let(engine::cancelRequest) } }
    }
    suspend fun rpc(machineId: String, method: String, params: JsonObject = buildJsonObject {}): JsonObject =
        request("rpc_request", buildJsonObject { put("machineId", machineId); put("method", method); put("params", params) }).objectValue("result") ?: buildJsonObject {}
    /** `session.delete` as the web sends it; throws the agent's refusal. A live session is stopped by the agent first. */
    suspend fun deleteSession(machineId: String, sessionId: String, cwd: String, source: String) {
        rpc(machineId, "session.delete", buildJsonObject { put("sessionId", sessionId); put("cwd", cwd); put("source", source) })
        engine.sessionDeleted(machineId, sessionId)
    }
    /** `projects.remove`: the folder moves to ~/.cc-remote/trash on the machine. */
    suspend fun removeProject(machineId: String, cwd: String) {
        rpc(machineId, "projects.remove", buildJsonObject { put("cwd", cwd) })
        _projectCatalog.value = _projectCatalog.value + (machineId to _projectCatalog.value[machineId].orEmpty().filter { it != cwd })
        _removableProjects.value = _removableProjects.value + (machineId to _removableProjects.value[machineId].orEmpty().filter { it != cwd }.toSet())
        engine.projectRemoved(machineId, cwd)
    }
    suspend fun api(path: String, method: String = "GET", body: JsonObject? = null): JsonObject {
        require(path.startsWith("/api/") && !path.contains(".."))
        val credential = token ?: error("Войдите в аккаунт")
        val stamp = cacheEpoch
        val base = endpoint.toHttpUrl().newBuilder().encodedPath(path).query(null).build()
        val (code, response) = withContext(Dispatchers.IO) {
            val payload = if (method in listOf("POST", "PATCH")) (body ?: buildJsonObject {}).toString().toRequestBody("application/json".toMediaType()) else null
            http.newBuilder().readTimeout(30, TimeUnit.SECONDS).followRedirects(false).build().newCall(
                Request.Builder().url(base).header("Authorization", "Bearer $credential").method(method, payload).build()
            ).execute().use { response ->
                val raw = response.body?.string().orEmpty()
                response.code to (raw.takeIf { it.isNotBlank() }?.let { runCatching { wireJson.parseToJsonElement(it) as? JsonObject }.getOrNull() } ?: buildJsonObject {})
            }
        }
        check(stamp == cacheEpoch && token == credential) { "Аккаунт или пространство изменились" }
        // The same dead session the socket reports as 401 on connect: sign out instead of failing forever.
        if (code == 401) { expireLogin(); _authError.value = "Сессия истекла. Войдите снова — черновики сохранены"; error("Сессия истекла") }
        if (code !in 200..299) error(response.string("error") ?: "HTTP $code")
        return response
    }
    suspend fun transcribe(file: java.io.File, target: Target): String {
        check(!engine.state.sealedMachine(target.machineId)) { "Для зашифрованной машины запись не уходит на сервер. Выберите распознавание телефона" }
        check(requestAIDataConsent()) { "Передача данных AI не разрешена" }
        check(file.length() in 1..25_000_000) { "Запись пустая или слишком большая" }
        return speechRequest("/transcribe", file.asRequestBody("audio/mp4".toMediaType()), 45,
            mapOf("project" to target.project.take(200))).string("text")?.trim() ?: error("Сервер не вернул текст")
    }
    suspend fun polish(text: String, target: Target): String {
        if (text.isBlank() || text.length > 12_000) return text
        if (engine.state.sealedMachine(target.machineId)) return text
        val current = engine.state
        val body = buildJsonObject {
            put("text", text); put("project", target.project.take(200)); put("title", target.title.take(200))
            if (current.target?.key == target.key) put("recent", current.messages.filter { it.spoken }.takeLast(6).joinToString("\n") { "${it.role}: ${it.text}" }.takeLast(4000))
        }
        check(requestAIDataConsent()) { "Передача данных AI не разрешена" }
        val response = speechRequest("/polish", body.toString().toRequestBody("application/json".toMediaType()), 8)
        return if (response.flag("polished")) response.string("text")?.takeIf(String::isNotBlank) ?: text else text
    }
    private suspend fun speechRequest(path: String, body: RequestBody, seconds: Long, query: Map<String, String> = emptyMap()): JsonObject {
        val credential = token ?: error("Войдите в аккаунт")
        val stamp = cacheEpoch
        val url = endpoint.toHttpUrl().newBuilder().encodedPath(path).query(null).apply { query.forEach { (key, value) -> addQueryParameter(key, value) } }.build()
        val value = withContext(Dispatchers.IO) {
            http.newBuilder().readTimeout(seconds, TimeUnit.SECONDS).callTimeout(seconds, TimeUnit.SECONDS).followRedirects(false).build().newCall(
                Request.Builder().url(url).header("Authorization", "Bearer $credential").post(body).build()
            ).execute().use { response ->
                val raw = response.body?.string().orEmpty()
                check(response.isSuccessful) { if (response.code == 503 && raw.contains("not configured")) "Распознавание на сервере выключено. Выберите распознавание телефона в настройках." else "Не удалось распознать запись (HTTP ${response.code}). Повторите попытку." }
                wireJson.parseToJsonElement(raw).jsonObject
            }
        }
        check(stamp == cacheEpoch && token == credential) { "Аккаунт или пространство изменились" }
        return value
    }
    // ---- models.list per machine and runtime: asked once, refreshed in the background on each open.
    private val modelLists = mutableMapOf<String, List<ModelChoice>>()
    fun cachedModels(machineId: String, source: String): List<ModelChoice> = modelLists["$cacheEpoch:$machineId:$source"].orEmpty()
    suspend fun models(machineId: String, source: String): List<ModelChoice> {
        val key = "$cacheEpoch:$machineId:$source"
        val fetched = wireJson.decodeFromJsonElement<List<ModelChoice>>(rpc(machineId, "models.list", buildJsonObject { put("source", source) })["models"] ?: JsonArray(emptyList()))
        if (fetched.isNotEmpty()) modelLists[key] = fetched
        return fetched.ifEmpty { modelLists[key].orEmpty() }
    }
    // ---- Transcript images (web Attachment.tsx): fetched once per ref when the row is shown, kept in memory.
    sealed interface ImageLoad {
        data object Loading : ImageLoad
        data class Loaded(val image: ImageInput) : ImageLoad
        /** The agent has no bytes for this ref (an old transcript, a moved file) — quiet, cached, never retried. */
        data object Missing : ImageLoad
        /** A network failure — not cached, the row offers a retry. */
        data class Failed(val message: String) : ImageLoad
    }
    /** Files an answer names (screenshots, .md): see FilePreviewStore. Keys carry the account scope. */
    val previews = FilePreviewStore(viewModelScope, rpc = { machineId, method, params -> rpc(machineId, method, params) })
    fun previewScope(): String? = cacheScope
    private val imageCache = LinkedHashMap<String, ImageLoad>(32, 0.75f, true)
    private val imageLoads = mutableMapOf<String, Deferred<ImageLoad>>()
    private var imageEpoch = -1
    private fun imageKey(target: Target, ref: String) = "${target.machineId}:${target.sessionId}:$ref"
    fun cachedImage(target: Target, ref: String): ImageLoad? {
        if (imageEpoch != cacheEpoch) { imageCache.clear(); imageEpoch = cacheEpoch }
        return imageCache[imageKey(target, ref)]
    }
    suspend fun historyImage(target: Target, ref: String): ImageLoad {
        val session = target.sessionId ?: return ImageLoad.Missing
        cachedImage(target, ref)?.let { return it }
        val key = imageKey(target, ref)
        val load = imageLoads.getOrPut(key) {
            viewModelScope.async {
                val epoch = cacheEpoch
                val result = try {
                    var value = rpc(target.machineId, "session.image", buildJsonObject { put("sessionId", session); put("source", target.source); put("ref", ref) })
                    if (ref.startsWith("gen:")) for (attempt in 1..4) {
                        if (!value.string("dataB64").isNullOrEmpty()) break
                        delay(attempt * 400L)
                        check(epoch == cacheEpoch) { "Аккаунт изменился" }
                        value = rpc(target.machineId, "session.image", buildJsonObject { put("sessionId", session); put("source", target.source); put("ref", ref) })
                    }
                    val data = value.string("dataB64").orEmpty()
                    if (data.isEmpty() || data.length > 8_000_000) ImageLoad.Missing
                    else ImageLoad.Loaded(ImageInput(value.string("mediaType")?.takeIf(String::isNotBlank) ?: "image/jpeg", data))
                } catch (e: CancellationException) { throw e }
                catch (e: Exception) { ImageLoad.Failed(e.message ?: "Изображение не загрузилось") }
                if (epoch == cacheEpoch && result !is ImageLoad.Failed) {
                    imageCache[key] = result
                    // Bound memory by payload, not by count: one screenshot can be megabytes.
                    while (imageCache.size > 1 && imageCache.values.sumOf { (it as? ImageLoad.Loaded)?.image?.data?.length?.toLong() ?: 0L } > 24_000_000L)
                        imageCache.remove(imageCache.keys.first())
                }
                imageLoads.remove(key)
                result
            }
        }
        return load.await()
    }
    /** [remember]: an explicit pick becomes this account's default on the next launch; a notification jump does not. */
    fun switchWorkspace(id: String, remember: Boolean = true): Boolean {
        val viewer = state.value.viewer
        if (viewer?.workspaces?.none { it.workspaceId == id } != false) return false
        // Same rule as iOS: a send not yet confirmed lives in this workspace's cache, and the one being left may be
        // personal, which no switcher offers any more — leaving now would strand the message.
        if (state.value.pending != null || state.value.uncertain != null) { engine.error("Дождитесь отправки сообщений"); return false }
        if (!persistNow(state.value)) { engine.error("Не удалось сохранить черновики. Пространство не переключено"); return false }
        if (remember) prefs.edit().putString(workspacePrefKey(hub, viewer.userId), id).apply()
        disconnect(); dropPendingSave(); cacheEpoch++; cacheScope = null; conversations.clear(); restoredOwner = null
        invalidateAuth(); workspaceId = id; engine.signOut(); connect()
        return true
    }
    fun prefetchRecent(force: Boolean = false) {
        if (_restoring.value || engine.state.connection != Connection.READY || !engine.state.activeAccess || cacheScope == null) return
        val stamp = cacheEpoch
        val key = "$stamp:$generation"
        if (!force && key == prefetchKey || prefetchJob?.isActive == true) return
        prefetchKey = key
        val current = engine.state
        val targets = current.machines.filterNot { current.sealedMachine(it.machine.machineId) }.flatMap { machine -> machine.sessions.filter { current.isMine(machine, it) && !it.automated }.map { machine to it } }
            .sortedByDescending { it.second.lastModified }.take(8).map { (machine, session) -> Target(machine.machine.machineId, session.cwd.orEmpty(), session.sessionId, session.title, session.source) }
            .filter { it.key != current.target?.key }
        prefetchJob = viewModelScope.launch {
            _prefetch.value = 0 to targets.size
            try {
                // Two outstanding reads: prefetch must not fill the hub's RPC queue.
                val semaphore = kotlinx.coroutines.sync.Semaphore(2)
                coroutineScope { targets.map { target -> launch {
                    semaphore.acquire()
                    try {
                        val response = rpc(target.machineId, "session.messages", buildJsonObject {
                            put("sessionId", target.sessionId); put("cwd", target.cwd); put("source", target.source); put("limit", 200); put("toolChars", 1000)
                        })
                        if (stamp != cacheEpoch) return@launch
                        val lines = historyLines(wireJson.decodeFromJsonElement<List<HistoryMessage>>(response["messages"] ?: JsonArray(emptyList())))
                        if (lines.isNotEmpty() && target.key != engine.state.target?.key) {
                            conversations.remove(target.key)
                            conversations[target.key] = ConversationCache(target, lines.map { it.copy(images = emptyList()) })
                            while (conversations.size > 12 || conversations.size > 1 && conversations.values.sumOf { c -> c.messages.sumOf { it.weight } } > 4_000_000) conversations.remove(conversations.keys.first())
                            scheduleSave(engine.state)
                        }
                    } catch (e: CancellationException) { throw e }
                    catch (_: Exception) { /* Offline history remains usable; a failed prefetch isn't a chat error. */ }
                    finally { semaphore.release(); if (stamp == cacheEpoch) _prefetch.value = ((_prefetch.value?.first ?: 0) + 1) to targets.size }
                } }.joinAll() }
            } finally { if (stamp == cacheEpoch) _prefetch.value = null }
        }
    }
    suspend fun refreshProjects(force: Boolean = false) = supervisorScope {
        val current = engine.state
        if (current.connection != Connection.READY || !current.activeAccess) return@supervisorScope
        val ids = current.machines.filter { it.online && it.canControl }.map { it.machine.machineId }.sorted()
        val stamp = cacheEpoch
        val key = "$stamp:$generation:${ids.joinToString() }"
        if (!force && key == projectAsk && System.currentTimeMillis() - projectAskedAt < 300_000) return@supervisorScope
        projectAsk = key; projectAskedAt = System.currentTimeMillis()
        _projectCatalog.value = _projectCatalog.value.filterKeys { it in ids }
        _removableProjects.value = _removableProjects.value.filterKeys { it in ids }
        ids.map { id -> launch {
            try {
                val rows = rpc(id, "projects.list").rows("projects")
                val projects = rows.mapNotNull { it.string("cwd")?.takeIf(String::isNotBlank) }.distinct()
                if (stamp == cacheEpoch && key == projectAsk) {
                    _projectCatalog.value = _projectCatalog.value + (id to projects)
                    _removableProjects.value = _removableProjects.value + (id to removableProjectCwds(rows))
                }
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { /* Old/silent agent: retain that machine's last successful list. */ }
        } }.joinAll()
    }
    suspend fun refreshSharedProjects() {
        val current = engine.state
        val workspace = current.viewer?.workspace
        if (current.connection != Connection.READY || !current.activeAccess || workspace == null || workspace.kind == "personal") {
            _sharedProjects.value = emptyList(); sharedAsk = ""; return
        }
        val stamp = cacheEpoch
        val key = "$stamp:${workspace.workspaceId}"
        if (key == sharedAsk) return
        try {
            val rows = api("/api/workspaces/${segment(workspace.workspaceId)}/projects").rows("projects")
            if (stamp == cacheEpoch) { _sharedProjects.value = parseSharedProjects(rows); sharedAsk = key }
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) { if (stamp == cacheEpoch) _sharedProjects.value = emptyList() /* silent: the list is a convenience */ }
    }
    fun select(target: Target) { engine.select(target) }
    /** What the chosen hub offers (`/api/public-config`); null until it answers, and for a hub that never does. */
    private val _publicConfig = MutableStateFlow<HubPublicConfig?>(null)
    val publicConfig = _publicConfig.asStateFlow()
    private var configJob: Job? = null
    /** True when the last `/api/public-config` ask failed (login screen: «Сервер … не ответил»). */
    private val _configFailed = MutableStateFlow(false)
    val configFailed = _configFailed.asStateFlow()
    /** A hub proposed by a link or QR, waiting for the person's confirmation (never switched silently). */
    private val _proposedHub = MutableStateFlow<String?>(null)
    val proposedHub = _proposedHub.asStateFlow()
    fun proposeHub(text: String) {
        val base = net.hegai.code.core.HubLink.parse(text) ?: return
        if (base == hub) return
        // A proposal already on screen (or being probed) stays: the dialog must
        // switch to the host it showed, not to whatever link came last.
        _proposedHub.compareAndSet(null, base)
    }
    fun dismissProposedHub() { _proposedHub.value = null }
    /** Asks the current hub which sign-in ways it offers; the login screen reads [publicConfig]. */
    fun refreshPublicConfig() {
        val asked = hub
        _publicConfig.value = null
        _configFailed.value = false
        configJob?.cancel()
        configJob = viewModelScope.launch { val config = fetchPublicConfig(asked); if (asked == hub) { _publicConfig.value = config; _configFailed.value = config == null } }
    }
    private suspend fun fetchPublicConfig(base: String): HubPublicConfig? = withContext(Dispatchers.IO) {
        try {
            http.newBuilder().connectTimeout(8, TimeUnit.SECONDS).readTimeout(8, TimeUnit.SECONDS).followRedirects(false).build().newCall(
                Request.Builder().url(HubUrl.publicConfig(base)).build()
            ).execute().use { response ->
                if (response.isSuccessful) HubPublicConfig.parse(response.body?.source()?.let { it.request(16385); it.buffer.readUtf8() }.orEmpty().take(16384)) else null
            }
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) { null }
    }
    fun beginSignIn(context: android.content.Context) {
        invalidateAuth()
        val stamp = authEpoch
        val asked = hub
        viewModelScope.launch {
            // A tap right after the screen opens: ask once more rather than guess Google on a customer's hub.
            val config = _publicConfig.value ?: fetchPublicConfig(asked)
            if (stamp != authEpoch || asked != hub) return@launch
            runCatching { browserSignIn.launch(context, asked, config?.usesHubSignInPage == true) }
                .onFailure { _authError.value = "Не удалось открыть браузер: ${it.message}" }
        }
    }
    fun authCallback(uri: android.net.Uri) {
        if (uri.scheme == "ccremote") { googleLinkCallback(uri); return }

        if (signingIn) return
        val body = browserSignIn.exchangeBody(uri) ?: return
        signingIn = true
        val authStamp = authEpoch
        val authHub = hub
        viewModelScope.launch {
            try {
                val session = withContext(Dispatchers.IO) {
                    http.newBuilder().readTimeout(30, TimeUnit.SECONDS).followRedirects(false).build().newCall(
                        Request.Builder().url(HubUrl.exchange(authHub))
                            .post(body.toString().toRequestBody("application/json".toMediaType())).build()
                    ).execute().use { response ->
                        check(response.code !in listOf(400, 401)) { "Код входа истёк. Начните вход заново" }
                        check(response.isSuccessful) { "Сервер входа недоступен (HTTP ${response.code}). Попробуйте ещё раз" }
                        wireJson.parseToJsonElement(response.body?.string() ?: "{}").jsonObject.string("session") ?: error("Сервер не вернул сессию")
                    }
                }
                if (authStamp == authEpoch) { acceptSession(session); browserSignIn.clear() } else revokeAbandoned(session, authHub)
            } catch (e: Exception) { _authError.value = e.message ?: "Не удалось завершить вход" }
            finally { signingIn = false }
        }
    }
    private fun invalidateAuth() {
        // A pending 2FA session the code screen held: nothing will verify it now.
        (_telegram.value as? TelegramPhase.Code)?.let { c -> viewModelScope.launch { revokeAbandoned(c.session, c.hub) } }
        closeReport(); _consentDialog.value = false
        prefetchJob?.cancel(); prefetchKey = ""; _prefetch.value = null
        _projectCatalog.value = emptyMap(); _removableProjects.value = emptyMap(); projectAsk = ""; _sharedProjects.value = emptyList(); sharedAsk = ""
        authEpoch++; telegramStopped = true; _telegram.value = null; googleLinkEpoch = null
        // Do not cancel an in-flight poll: it may carry the one-use approval.
    }
    private suspend fun telegramPost(path: String, body: JsonObject, bearer: String? = null, base: String = hub): JsonObject = withContext(Dispatchers.IO) {
        http.newBuilder().readTimeout(15, TimeUnit.SECONDS).followRedirects(false).build().newCall(
            Request.Builder().url(HubUrl.telegram(base, path)).apply { bearer?.let { header("Authorization", "Bearer $it") } }
                .post(body.toString().toRequestBody("application/json".toMediaType())).build()
        ).execute().use { response ->
            val raw = response.body?.string().orEmpty()
            val value = wireJson.parseToJsonElement(raw.ifEmpty { "{}" }).jsonObject
            if (!response.isSuccessful) error(when (response.code) {
                404 -> "Вход через Telegram на сервере выключен."
                429 -> "Слишком много попыток. Подождите немного и начните заново."
                else -> identityError(value.string("error"))
            })
            value
        }
    }
    fun startTelegram(link: Boolean = false) {
        if (signingIn) return
        invalidateAuth(); telegramStopped = false
        val stamp = authEpoch
        val credential = if (link) token ?: return else null
        val flowHub = hub // the hub can be switched while a poll is in flight; never send its answer elsewhere
        _telegram.value = TelegramPhase.Starting(link)
        telegramJob = viewModelScope.launch {
            try {
                val login = wireJson.decodeFromJsonElement<TelegramLogin>(telegramPost("start", buildJsonObject {
                    put("client", "native"); put("device", "Android"); if (link) put("intent", "link")
                }, credential, flowHub))
                if (stamp != authEpoch || telegramStopped) return@launch
                check(login.valid) { "Сервер вернул некорректную ссылку Telegram" }
                _telegram.value = TelegramPhase.Waiting(login, link)
                val deadline = android.os.SystemClock.elapsedRealtime() + 11 * 60_000
                while (stamp == authEpoch && !telegramStopped) {
                    delay((login.interval * 1000).toLong().coerceIn(1000, 10_000))
                    if (stamp != authEpoch || telegramStopped) break
                    if (android.os.SystemClock.elapsedRealtime() >= deadline) error(telegramEnd("expired"))
                    val result = try { telegramPost("poll", buildJsonObject { put("pollToken", login.pollToken); put("mfa", "code") }, base = flowHub) }
                        catch (e: CancellationException) { throw e }
                        // A second factor is owed and an app has no browser here: say so
                        // instead of polling until the code expires.
                        catch (e: Exception) { if (e.message == identityError("mfa_browser_required")) throw e; continue }
                    if (stamp != authEpoch || telegramStopped || credential != (if (link) token else null)) {
                        // A different login won. Never apply this approval to its account.
                        result.string("session")?.let { revokeAbandoned(it, flowHub) }
                        return@launch
                    }
                    when (val status = result.string("status")) {
                        "pending" -> Unit
                        "approved" -> {
                            check(!link) { "Неожиданный результат привязки" }
                            val session = result.string("session")?.takeIf { it.isNotBlank() && it.length <= 4096 } ?: error("Сервер не вернул сессию")
                            val memo = buildJsonObject {
                                put("userId", result.string("userId")); put("telegram", result.string("telegram"))
                                put("name", result.objectValue("account")?.string("displayName"))
                            }
                            acceptSession(session)
                            if (token == session) { telegramMemoVault.write(memo.toString()); _telegramMemo.value = memo }
                            return@launch
                        }
                        "mfa" -> {
                            // Telegram proved the account; the authenticator code is still owed.
                            // The session is pending: it opens nothing until verified.
                            check(!link) { "Неожиданный результат привязки" }
                            val session = result.string("session")?.takeIf { it.isNotBlank() && it.length <= 4096 } ?: error("Сервер не вернул сессию")
                            val memo = buildJsonObject {
                                put("userId", result.string("userId")); put("telegram", result.string("telegram"))
                                put("name", result.objectValue("account")?.string("displayName"))
                            }
                            _telegram.value = TelegramPhase.Code(session, memo, flowHub)
                            return@launch
                        }
                        "confirm_link" -> {
                            check(link) { "Неожиданное подтверждение привязки" }
                            if (!telegramStopped) _telegram.value = TelegramPhase.Confirm(login, result.string("telegram") ?: "Telegram")
                            return@launch
                        }
                        else -> error(telegramEnd(status.orEmpty()))
                    }
                }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { if (stamp == authEpoch && !telegramStopped) _telegram.value = TelegramPhase.Failed(e.message ?: "Нет связи с сервером", link) }
        }
    }
    fun closeTelegram() {
        (_telegram.value as? TelegramPhase.Code)?.let { viewModelScope.launch { revokeAbandoned(it.session, it.hub) } }
        telegramStopped = true; _telegram.value = null
    }
    fun submitTelegramCode(code: String) {
        val phase = _telegram.value as? TelegramPhase.Code ?: return
        if (phase.busy || code.isBlank()) return
        val stamp = authEpoch
        _telegram.value = phase.copy(busy = true, error = null)
        viewModelScope.launch {
            val outcome = withContext(Dispatchers.IO) { runCatching {
                http.newBuilder().readTimeout(15, TimeUnit.SECONDS).followRedirects(false).build().newCall(
                    Request.Builder().url(HubUrl.mfaVerify(phase.hub)).header("Authorization", "Bearer ${phase.session}")
                        .post(buildJsonObject { put("code", code) }.toString().toRequestBody("application/json".toMediaType())).build()
                ).execute().use { response ->
                    val raw = response.body?.string().orEmpty()
                    val value = runCatching { wireJson.parseToJsonElement(raw.ifEmpty { "{}" }).jsonObject }.getOrNull()
                    when {
                        response.isSuccessful -> null
                        response.code == 401 -> "Время на ввод кода вышло. Начните вход заново."
                        response.code == 429 -> "Слишком много попыток. Подождите немного."
                        else -> value?.string("error") ?: "Код не подошёл."
                    }
                }
            } }
            if (stamp != authEpoch || (_telegram.value as? TelegramPhase.Code)?.session != phase.session) {
                // Another sign-in won meanwhile: never leave this session behind.
                revokeAbandoned(phase.session, phase.hub); return@launch
            }
            outcome.fold({ problem ->
                if (problem == null) {
                    if (phase.hub != hub) { revokeAbandoned(phase.session, phase.hub); _telegram.value = null; return@fold }
                    _telegram.value = null // or invalidateAuth() would revoke the session just verified
                    acceptSession(phase.session)
                    if (token == phase.session) { telegramMemoVault.write(phase.memo.toString()); _telegramMemo.value = phase.memo }
                } else _telegram.value = phase.copy(busy = false, error = problem)
            }, { _telegram.value = phase.copy(busy = false, error = "Нет связи с сервером") })
        }
    }
    fun confirmTelegramLink() {
        val phase = _telegram.value as? TelegramPhase.Confirm ?: return
        val credential = token ?: return
        val stamp = authEpoch
        val flowHub = hub
        _telegram.value = TelegramPhase.Linking
        viewModelScope.launch {
            try {
                telegramPost("link", buildJsonObject { put("pollToken", phase.login.pollToken) }, credential, flowHub)
                if (stamp == authEpoch && token == credential) { _telegram.value = null; _identityRevision.value++ }
            } catch (e: Exception) { if (stamp == authEpoch) _telegram.value = TelegramPhase.Failed(e.message ?: "Не удалось привязать", true) }
        }
    }
    private suspend fun revokeAbandoned(session: String, base: String = hub) = withContext(Dispatchers.IO) {
        runCatching { http.newBuilder().readTimeout(15, TimeUnit.SECONDS).build().newCall(
            Request.Builder().url(HubUrl.logout(base)).header("Authorization", "Bearer $session")
                .post(ByteArray(0).toRequestBody(null)).build()).execute().close() }
        Unit
    }
    suspend fun linkGoogle(context: android.content.Context) {
        invalidateAuth()
        val stamp = authEpoch
        val ticket = api("/api/auth/google/link", "POST")
        check(stamp == authEpoch) { "Аккаунт изменился" }
        val path = ticket.string("path") ?: error("Сервер не вернул ссылку")
        check(path.startsWith("/api/auth/google/start?native=1&link=")) { "Некорректная ссылка" }
        googleLinkEpoch = stamp
        androidx.browser.customtabs.CustomTabsIntent.Builder().build().launchUrl(context, android.net.Uri.parse(hub + path))
    }
    private fun googleLinkCallback(uri: android.net.Uri) {
        val stamp = googleLinkEpoch ?: return
        if (stamp != authEpoch || uri.host != "auth" || !uri.path.isNullOrEmpty() || uri.port != -1 || uri.userInfo != null || uri.fragment != null) return
        val result = uri.getQueryParameters("link_result").singleOrNull()
        val failure = uri.getQueryParameters("link_error").singleOrNull()
        if (result == null && failure == null) return
        googleLinkEpoch = null
        viewModelScope.launch {
            try {
                if (result == null) error(identityError(failure))
                api("/api/auth/google/link/confirm", "POST", buildJsonObject { put("result", result) })
                if (stamp == authEpoch) _identityRevision.value++
            } catch (e: Exception) { if (stamp == authEpoch) engine.error(identityError(e.message)) }
        }
    }
    fun cancelLogin(message: String? = null) { _authError.value = message }
    /**
     * Store review sign-in (Google Play reviewers): email + password against the hub's
     * `/api/auth/review-login`, which answers a native `{session}`. `done(null)` on success,
     * otherwise the message to show in the dialog.
     */
    fun reviewSignIn(email: String, password: String, done: (String?) -> Unit) {
        if (signingIn) { done("Вход уже выполняется, подождите"); return }
        invalidateAuth()
        signingIn = true
        val authStamp = authEpoch
        val authHub = hub
        viewModelScope.launch {
            try {
                val body = buildJsonObject { put("email", email.trim()); put("password", password) }
                val session = withContext(Dispatchers.IO) {
                    http.newBuilder().readTimeout(30, TimeUnit.SECONDS).followRedirects(false).build().newCall(
                        Request.Builder().url(HubUrl.reviewLogin(authHub))
                            .post(body.toString().toRequestBody("application/json".toMediaType())).build()
                    ).execute().use { response ->
                        when (response.code) {
                            401 -> error("Неверные данные")
                            429 -> error("Слишком много попыток, подождите")
                            404 -> error("Вход для проверки выключен")
                        }
                        check(response.isSuccessful) { "Сервер входа недоступен (HTTP ${response.code}). Попробуйте ещё раз" }
                        wireJson.parseToJsonElement(response.body?.string() ?: "{}").jsonObject.string("session") ?: error("Сервер не вернул сессию")
                    }
                }
                if (authStamp == authEpoch) acceptSession(session) else revokeAbandoned(session, authHub)
                done(if (_signedIn.value) null else _authError.value ?: "Не удалось завершить вход")
            } catch (e: Exception) { done(e.message ?: "Не удалось завершить вход") }
            finally { signingIn = false }
        }
    }
    /** Called only after an HTTPS native authentication exchange. */
    fun acceptSession(session: String?) {
        if (session.isNullOrBlank() || session.length > 4096) return
        try { vault.write(hub, session) }
        catch (_: Exception) { _authError.value = "Не удалось сохранить вход в защищённое хранилище"; return }
        invalidateAuth(); forgetTelegramMemo(); workspaceChecked = false
        persistNow(engine.state); disconnect(); dropPendingSave(); cacheEpoch++; cacheScope = null; conversations.clear(); workspaceId = null
        token = session; endpoint = HubUrl.ui(hub); _signedIn.value = true
        engine.signOut(); failures = 0
        if (foreground) connect()
    }
    /** Invoked only by the explicit developer form in debug builds, never intent extras. */
    fun connectLocal(port: String) {
        if (!BuildConfig.DEBUG) return
        val number = port.toIntOrNull()?.takeIf { it in 1024..65535 } ?: return
        disconnect(); vault.clear(); engine.signOut()
        endpoint = "http://10.0.2.2:$number/ui"; token = "dev-token"; _signedIn.value = true
        failures = 0
        connect()
    }
    fun foreground(active: Boolean) {
        foreground = active
        if (active && token != null && socket == null) connect()
        else if (!active) { persistNow(engine.state); disconnect(); engine.disconnected() }
    }
    fun retry() { failures = 0; disconnect(); if (foreground && token != null) connect() }
    private fun connect() {
        if (!bootstrapped) return
        val credential = token ?: return
        reconnect?.cancel(); reconnect = null
        val stamp = ++generation
        pushTokenLoaded = false // FCM may have rotated it (onNewToken writes the vault directly): re-read once per connection
        socket?.cancel()
        engine.connecting()
        // The session rides in a header, not the URL: a query string lands in every proxy's access log.
        val url = endpoint.toHttpUrl().newBuilder()
            .apply { workspaceId?.let { addQueryParameter("workspaceId", it) } }.build()
        socket = http.newWebSocket(Request.Builder().url(url).header("Authorization", "Bearer $credential").build(), object : WebSocketListener() {
            private fun current(block: () -> Unit) { viewModelScope.launch(Dispatchers.Main.immediate) { if (stamp == generation) block() } }
            override fun onOpen(webSocket: WebSocket, response: Response) = current { failures = 0; engine.connected() }
            // Parse here, on OkHttp's reader thread (frames arrive in order, and posts to main keep it).
            override fun onMessage(webSocket: WebSocket, text: String) { val frame = HubEngine.parseFrame(text); current { engine.receive(frame) } }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = current { lost() }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = current {
                if (response?.code == 401 || response?.code == 403) {
                    expireLogin(); _authError.value = "Сессия истекла. Войдите снова — черновики сохранены"
                } else lost()
                response?.close()
            }
        })
    }
    private fun lost() {
        ++generation; socket = null
        engine.disconnected("Связь потеряна. Переподключаемся…")
        if (!foreground || token == null) return
        val delayMs = minOf(30_000L, 1000L shl minOf(failures++, 5))
        reconnect = viewModelScope.launch { delay(delayMs); connect() }
    }
    private fun disconnect() {
        ++generation; reconnect?.cancel(); reconnect = null
        socket?.close(1000, null); socket = null
    }
    /** [keepSealed]: leave the stored (hub-bound) session in place — a hub switch whose revocation could not be
     *  queued keeps it so the next start finds it foreign to the new hub and revokes it where it was issued. */
    private fun expireLogin(keepSealed: Boolean = false) {
        invalidateAuth(); forgetTelegramMemo(); workspaceChecked = false
        disconnect(); if (!keepSealed) vault.clear(); token = null; _signedIn.value = false
        dropPendingSave(); cacheEpoch++; cacheScope = null; conversations.clear()
        _restoring.value = false; restoredOwner = null; engine.signOut()
    }
    /** The revocation must reach the hub that issued the session, even after the person switched hubs. Old entries are bare tokens of the default hub. */
    /** Queue a session for revocation at [base] (never overwrites another pending one). Throws if not stored. */
    private fun queueRevoke(base: String, credential: String) = synchronized(revokeLock) {
        pendingRevoke.write(RevokeQueue.add(pendingRevoke.read(), base, credential))
    }
    private fun revokePending() = viewModelScope.launch(Dispatchers.IO) {
        val entries = synchronized(revokeLock) { RevokeQueue.decode(pendingRevoke.read()) }
        if (entries.isEmpty()) return@launch
        val done = entries.filter { (base, credential) ->
            runCatching {
                http.newBuilder().readTimeout(15, TimeUnit.SECONDS).followRedirects(false).build().newCall(
                    Request.Builder().url(HubUrl.logout(base)).header("Authorization", "Bearer $credential")
                        .post(ByteArray(0).toRequestBody(null)).build()
                ).execute().use { response ->
                    // 401: the hub no longer knows this session — the goal already holds.
                    response.code == 401 || response.isSuccessful &&
                        runCatching { wireJson.parseToJsonElement(response.body?.string().orEmpty()).jsonObject["revoked"]?.jsonPrimitive?.booleanOrNull }.getOrNull() != null
                }
            }.getOrDefault(false)
        }
        if (done.isEmpty()) return@launch
        synchronized(revokeLock) {
            val rest = RevokeQueue.without(pendingRevoke.read(), done)
            if (rest == null) pendingRevoke.clear() else runCatching { pendingRevoke.write(rest) }
        }
    }
    fun logout() {
        // Revoke on the hub too (iOS does since e87ef1b): clearing the phone alone left a copied token alive.
        // A revocation that did not land (offline, 5xx) is kept sealed and retried on the next start.
        token?.let { credential -> queueRevoke(hub, credential); revokePending() }
        pushToken.read()?.let { engine.command("unregister_push", buildJsonObject { put("deviceToken", it); put("platform", "android") }) }
        forgetAccountLocally()
    }
    /**
     * Google Play: the account is deleted from inside the app. The hub removes it in one transaction, kills every
     * session token and drops this phone's push token itself, so nothing is revoked here — only the phone is cleared,
     * exactly as on logout. Throws the hub's own message on refusal (409: owner of a team with members, platform owner).
     */
    suspend fun deleteAccount() {
        api("/api/account/delete", "POST", buildJsonObject { put("confirm", "DELETE") })
        forgetAccountLocally()
    }
    /**
     * Points the app at another hub (iOS: Settings → hub URL). Returns null on success, else the text to show.
     * A session belongs to one hub, so switching signs the person out of the old one (revoked there, best effort)
     * and the sign-in screen appears. Nothing changes unless the new hub answers `/health` with `{"ok":true}`.
     */
    suspend fun switchHub(raw: String): String? {
        val base = HubUrl.normalize(raw) ?: return "Введите адрес вида https://hub.example.com"
        if (base == hub) return null
        val hubBefore = hub
        val tokenBefore = token
        probeHub(base)?.let { return it }
        // The probe suspends: a sign-in or another switch (a connect link, the dialog) may have landed meanwhile.
        // This older call must not revoke that newer session or overwrite the newer choice.
        if (hub != hubBefore || token != tokenBefore) return "Сервер уже изменён — повторите подключение"
        // Transaction: caches and drafts are the person's data, so nothing is destroyed until the new address is
        // stored. The hub is committed first; the old session stays sealed for the OLD hub, so even a process
        // death right after the commit never sends it to the new one. A failed commit changes nothing.
        val oldHub = hub
        val credential = token
        // The stored session is the only copy of the old token: it is removed only once its revocation is
        // durably queued. If queuing fails it stays, sealed for the old hub — foreign on the new one, so the next
        // start revokes it there instead of losing it with the session still valid.
        var queued = credential == null
        when (val outcome = HubSwitch.run(
            commit = { HubConfig.save(getApplication(), base) },
            clearCredential = {
                queued = credential == null || runCatching { queueRevoke(oldHub, credential) }.isSuccess
                queued && vault.clear()
            },
        )) {
            is HubSwitch.Outcome.Failed -> return outcome.message
            HubSwitch.Outcome.Committed -> Unit
        }
        // Committed: now the old session is revoked where it was issued, while the old socket is still open for
        // the push unregistration, and only then are caches and drafts dropped.
        credential?.let {
            if (queued) runCatching { revokePending() }
            pushToken.read()?.let { device -> engine.command("unregister_push", buildJsonObject { put("deviceToken", device); put("platform", "android") }) }
        }
        forgetAccountLocally(keepSealed = !queued)
        hub = base; endpoint = HubUrl.ui(base); _hubBase.value = base
        _authError.value = null
        _publicConfig.value = null
        return null
    }
    private suspend fun probeHub(base: String): String? = withContext(Dispatchers.IO) {
        try {
            http.newBuilder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS).followRedirects(false).build().newCall(
                Request.Builder().url(HubUrl.health(base)).build()
            ).execute().use { response ->
                val body = if (response.isSuccessful) response.body?.source()?.let { it.request(4097); it.buffer.readUtf8() }.orEmpty().take(4096) else ""
                if (HubUrl.isHealthy(body)) null else "Это не сервер Hegai Code: нет ответа {\"ok\":true} на /health"
            }
        } catch (e: javax.net.ssl.SSLException) {
            "Не удалось установить защищённое соединение с ${HubUrl.label(base)}"
        } catch (e: java.io.IOException) {
            "Сервер ${HubUrl.label(base)} недоступен"
        } catch (e: IllegalArgumentException) {
            "Некорректный адрес сервера"
        }
    }
    private fun forgetAccountLocally(keepSealed: Boolean = false) {
        pushOwner.clear(); pushRegistered = null; lastIdentity.clear(); identitySaved = null
        androidx.core.app.NotificationManagerCompat.from(getApplication()).cancelAll()
        expireLogin(keepSealed); cancelLogin()
        cache.clear(); browserSignIn.clear(); workspaceId = null
        archived.clear(); saved.remove<HashMap<String, String>>("accountDrafts")
    }
    override fun onCleared() {
        disconnect()
        // Closing a pooled TLS socket writes close_notify — network I/O, which
        // StrictMode kills on the main thread (NetworkOnMainThreadException):
        // leaving the app with «назад» crashed every 0.3.x while a connection
        // was open. Off the main thread it is the same cleanup.
        val client = http
        Thread({
            client.dispatcher.executorService.shutdown()
            client.connectionPool.evictAll()
        }, "hub-http-close").start()
    }
}
