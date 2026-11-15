package net.hegai.code

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.drop
import kotlinx.serialization.json.*
import net.hegai.code.core.*
import net.hegai.code.core.Target

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable fun HegaiApp(model: HubViewModel, signIn: () -> Unit) {
    val signedIn by model.signedIn.collectAsStateWithLifecycle()
    val state by model.state.collectAsStateWithLifecycle()
    val showAutomated by model.automated.collectAsStateWithLifecycle()
    val authError by model.authError.collectAsStateWithLifecycle()
    val restoring by model.restoring.collectAsStateWithLifecycle()
    CompositionLocalProvider(LocalReportOpener provides model::openReport) {
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        if (!signedIn) LoginScreen(authError, signIn, { model.startTelegram() }, model::connectLocal, model::reviewSignIn, model)
        else if (restoring) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { LoadingIndicator() }
        else WorkspaceScreen(if (showAutomated) state else state.copy(machines = state.machines.map { m -> m.copy(sessions = m.sessions.filterNot { it.entrypoint == "sdk-cli" && it.owner == null }) }), model.engine, model::retry, model::logout, model)
    }
    TelegramDialog(model)
    PairKeyDialog(model)
    AIDataConsentDialog(model)
    ReportDialog(model)
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable private fun LoginScreen(error: String?, signIn: () -> Unit, telegram: () -> Unit, local: (String) -> Unit, review: (String, String, (String?) -> Unit) -> Unit, model: HubViewModel) {
    var serverOpen by rememberSaveable { mutableStateOf(false) }
    val hubBase by model.hubBase.collectAsStateWithLifecycle()
    // A customer's hub has its own sign-in page instead of Google (null: not answered yet, or never — the usual buttons).
    val publicConfig by model.publicConfig.collectAsStateWithLifecycle()
    val ownPage = publicConfig?.usesHubSignInPage == true
    LaunchedEffect(hubBase) { model.refreshPublicConfig() }
    var developer by rememberSaveable { mutableStateOf(false) }
    var reviewOpen by rememberSaveable { mutableStateOf(false) }
    var port by rememberSaveable { mutableStateOf("4319") }
    BoxWithConstraints(Modifier.fillMaxSize().safeDrawingPadding().imePadding()) {
    val compact = maxHeight < 650.dp || androidx.compose.ui.platform.LocalDensity.current.fontScale > 1.3f
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        HegaiWordmark(Modifier.padding(bottom = 8.dp))
        ProjectArtwork(Modifier.fillMaxWidth().height(if (compact) 124.dp else 230.dp))
        Text("Ваши проекты.\nВсегда рядом.", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.SemiBold)
        Text("Работайте с Claude и Codex. С телефона — на своих машинах.", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(8.dp))
        Button(onClick = signIn, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp), shapes = ButtonDefaults.shapes()) {
            Text(if (ownPage) "Войти" else "Войти через Google", style = MaterialTheme.typography.titleSmall)
        }
        if (!ownPage || publicConfig?.telegram == true) OutlinedButton(telegram, Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
            Icon(Icons.AutoMirrored.Outlined.Send, null, Modifier.size(20.dp))
            Spacer(Modifier.width(12.dp))
            Text("Войти через Telegram", style = MaterialTheme.typography.titleSmall)
        }
        // Store reviewers cannot use Google or Telegram; release builds keep this on purpose (it is our hub's door).
        if (!ownPage) TextButton({ reviewOpen = true }, Modifier.align(Alignment.CenterHorizontally)) {
            Text("Вход для проверки (Google Play)", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        // Customers who run their own hub choose it before signing in (iOS: Settings → hub URL).
        TextButton({ serverOpen = true }, Modifier.align(Alignment.CenterHorizontally)) {
            Text(if (HubUrl.isDefault(hubBase)) "Другой сервер" else "Сервер: ${HubUrl.label(hubBase)}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Text("hegai.code · ${BuildConfig.VERSION_NAME}", Modifier.align(Alignment.CenterHorizontally), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (BuildConfig.DEBUG) {
            TextButton({ developer = !developer }) { Text("Локальная разработка") }
            if (developer) {
                OutlinedTextField(port, { port = it.filter(Char::isDigit).take(5) }, label = { Text("Порт тестового хаба") }, singleLine = true)
                TextButton({ local(port) }) { Text("Подключить эмулятор") }
            }
        }
    }
    }
    if (reviewOpen) ReviewSignInDialog(review) { reviewOpen = false }
    if (serverOpen) HubServerDialog(model, signedIn = false) { serverOpen = false }
}

/** Email + password for the store review account (`POST /api/auth/review-login`). */
@Composable private fun ReviewSignInDialog(review: (String, String, (String?) -> Unit) -> Unit, dismiss: () -> Unit) {
    var email by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    val submit = {
        busy = true; failure = null
        review(email, password) { message -> busy = false; if (message == null) dismiss() else failure = message }
    }
    AlertDialog(onDismissRequest = { if (!busy) dismiss() },
        title = { Text("Вход для проверки") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(email, { email = it.take(254) }, label = { Text("Email") }, singleLine = true, enabled = !busy,
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Email))
                OutlinedTextField(password, { password = it.take(256) }, label = { Text("Пароль") }, singleLine = true, enabled = !busy,
                    visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(),
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Password))
                failure?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
            }
        },
        confirmButton = { TextButton(submit, enabled = !busy && email.isNotBlank() && password.isNotEmpty()) { Text("Войти") } },
        dismissButton = { TextButton(dismiss, enabled = !busy) { Text("Отмена") } })
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable fun WorkspaceScreen(state: HubState, engine: HubEngine, retry: () -> Unit, logout: () -> Unit, model: HubViewModel? = null) {
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    var settings by rememberSaveable { mutableStateOf(false) }
    var inbox by rememberSaveable { mutableStateOf(false) }
    var team by rememberSaveable { mutableStateOf(false) }
    var flow by rememberSaveable { mutableStateOf(false) }
    var reports by rememberSaveable { mutableStateOf(false) }
    var sessionMenu by rememberSaveable { mutableStateOf(false) }
    var fullError by remember { mutableStateOf<String?>(null) }
    var chooseProject by rememberSaveable { mutableStateOf(false) }
    var drillProject by rememberSaveable { mutableStateOf<String?>(null) }
    // A new chat keeps the selected project and composer, with real work/recent history above it.
    val showAutomated = model?.automated?.collectAsStateWithLifecycle()?.value ?: false
    val catalog = model?.projectCatalog?.collectAsStateWithLifecycle()?.value.orEmpty()
    val sharedRoots = model?.sharedProjects?.collectAsStateWithLifecycle()?.value.orEmpty()
    LaunchedEffect(state.connection, state.activeAccess, state.viewer?.workspace?.workspaceId) { model?.refreshSharedProjects() }
    val startProjects = remember(state.machines, state.runs, state.viewer, catalog, sharedRoots, showAutomated) {
        val discovered = drawerProjects(state, showAutomated, "")
        discovered + state.machines.flatMap { machine -> mergeProjectPaths(catalog[machine.machine.machineId].orEmpty(), sharedRoots.filter { it.machineId == machine.machine.machineId }.map { it.root }, ignoreCase = machine.machine.os == "win32").filter { cwd ->
            discovered.none { it.machine.machine.machineId == machine.machine.machineId && it.cwd.equals(cwd, machine.machine.os == "win32") }
        }.map { cwd -> DrawerProject("${machine.machine.machineId}:$cwd", machine, cwd, emptyList()) } }
    }
    val isStart = state.target.let { t -> t == null || (t.sessionId == null && state.messages.isEmpty() && !state.busy && !state.opening) }
    fun startable(p: DrawerProject) = p.cwd.isNotBlank() && p.machine.online && (p.machine.canStart || p.machine.canControl)
    // Showing automation history must not make its transient directory the default workspace.
    val defaultProject = startProjects.firstOrNull { startable(it) && (it.sessions.isEmpty() || it.sessions.any { session -> !session.automated }) }
    // A workspace member runs Codex only (the start chooser has no engine picker for them).
    val defaultSource = if (state.viewer?.workspace?.role == "member") "codex" else "claude"
    val newChat: () -> Unit = {
        val t = state.target
        val next = if (t != null && t.cwd.isNotBlank()) Target(t.machineId, t.cwd, source = t.source,
            agent = if (OpenCode.isOpenCodeChat(t, state.runSettings?.string("activeModel"), state.options.model)) OpenCode.AGENT else null)
            else defaultProject?.let { Target(it.machine.machine.machineId, it.cwd, source = defaultSource) }
        if (next != null) engine.select(next) else chooseProject = true
    }
    // Default = the newest project (ios: selection keyed by machine::cwd, newest by default).
    LaunchedEffect(state.target == null, defaultProject?.id, state.connection, state.activeAccess) {
        if (state.target == null && state.activeAccess && state.connection == Connection.READY)
            defaultProject?.let { engine.select(Target(it.machine.machine.machineId, it.cwd, source = defaultSource)) }
    }
    LaunchedEffect(state.target?.key, state.busy, state.loadingHistory, state.messages.lastOrNull()?.id) { model?.enrichConversation() }
    val shared = model?.share?.collectAsStateWithLifecycle()?.value
    LaunchedEffect(shared) { if (shared != null) chooseProject = true }
    val reportOpen = model?.report?.collectAsStateWithLifecycle()?.value != null
    LaunchedEffect(isStart, chooseProject, state.connection, state.machines.filter { it.online && it.canControl }.map { it.machine.machineId }) {
        if (isStart || chooseProject) model?.refreshProjects()
    }
    val conversationVisible = !reportOpen && fullError == null && !isStart && !settings && !inbox && !team && !flow && !reports && !chooseProject && !sessionMenu && drillProject == null && !drawer.isOpen
    LaunchedEffect(conversationVisible, state.target?.key, state.connection, state.loadingHistory, state.messages.lastOrNull()?.id, state.busy) {
        if (conversationVisible) { engine.markVisible(); delay(2100); engine.markVisible() }
    }
    BackHandler(drawer.isOpen) { scope.launch { drawer.close() } }
    ModalNavigationDrawer(drawerState = drawer, gesturesEnabled = state.activeAccess,
        drawerContent = {
            // 86% of the screen, at most 400: iOS's 74.5% squeezed titles and the bottom bar on a phone
            // (Owner, 26.09); a strip of the chat still shows beside the menu.
            val drawerWidth = minOf(androidx.compose.ui.platform.LocalConfiguration.current.screenWidthDp * 0.86f, 400f).dp
            ModalDrawerSheet(Modifier.width(drawerWidth).fillMaxHeight(), drawerContainerColor = MaterialTheme.colorScheme.surfaceContainerLow) {
                SessionDrawer(state, { target -> engine.select(target); scope.launch { drawer.close() } },
                    { newChat(); scope.launch { drawer.close() } }, { settings = true }, { team = true }, { inbox = true }, showAutomated, { flow = true }, if (model != null) ({ reports = true }) else null) { drillProject = it }
            }
        }) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
        // Open keyboard on a big-font phone leaves a sliver: secondary rows and the top bar step aside until it closes.
        val density = androidx.compose.ui.platform.LocalDensity.current
        val imeBottom = WindowInsets.ime.getBottom(density)
        val imeOpen = imeBottom > 0
        val freeHeightDp = androidx.compose.ui.platform.LocalConfiguration.current.screenHeightDp - with(density) { imeBottom.toDp().value }
        val minFreeDp = if (density.fontScale > 1.15f) 520f else 380f
        val squeezed = imeOpen && freeHeightDp < minFreeDp
        Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding()) {
            // Material 3 top app bar with a subtitle (flexible bar, M3 Expressive): the title opens the session
            // menu; the machine and project ride underneath instead of a mono caption in a floating island.
            if (!squeezed) TopAppBar(
                title = {
                    if (isStart) HegaiWordmark() else Text(state.displayTitle, Modifier.clickable(enabled = state.target != null) { sessionMenu = true },
                        maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleLargeEmphasized)
                },
                subtitle = {
                    val machine = state.machine
                    if (machine != null && !isStart && density.fontScale <= 1.3f) Text(listOfNotNull(state.target?.project?.takeIf(String::isNotBlank), machine.machine.name + if (machine.online) "" else " · офлайн").joinToString(" · "),
                        maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                },
                navigationIcon = { IconButton({ scope.launch { drawer.open() } }) { Icon(Icons.Outlined.Menu, "Открыть меню") } },
                actions = {
                    if (isStart && model != null) WorkspaceSwitcher(state, model)
                    if (isStart) IconButton({ settings = true }, Modifier.semantics { contentDescription = "Настройки" }) { AccountAvatar(state.viewer?.fullName ?: state.viewer?.email ?: "Аккаунт", Modifier) }
                    else FilledTonalIconButton(newChat, enabled = state.activeAccess, shapes = IconButtonDefaults.shapes()) { Icon(Icons.Outlined.Edit, "Новый чат") }
                    Spacer(Modifier.width(4.dp))
                },
                windowInsets = WindowInsets(0),
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
            AnimatedVisibility(state.connection != Connection.READY) {
                Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)) {
                    Row(Modifier.padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        if (state.connection != Connection.DISCONNECTED) LoadingIndicator(Modifier.size(28.dp))
                        Text(when (state.connection) { Connection.CONNECTING -> "Подключение…"; Connection.SYNCING -> "Синхронизация…"; else -> "Нет соединения" },
                            Modifier.weight(1f).padding(horizontal = 8.dp), style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        IconButton(retry) { Icon(Icons.Outlined.Refresh, "Повторить подключение") }
                    }
                }
            }
            if (model != null) TelegramAccountBanner(model, state.viewer?.userId)
            if (!state.activeAccess) {
                Column(Modifier.weight(1f).padding(24.dp), verticalArrangement = Arrangement.Center) {
                    Text(if (state.viewer?.access?.state == "suspended") "Доступ приостановлен" else "Вы в списке ожидания", style = MaterialTheme.typography.headlineMedium)
                    Text("Статус обновится после открытия доступа.", Modifier.padding(top = 16.dp))
                    TextButton(logout) { Text("Выйти") }
                }
            } else {
                state.error?.let { error ->
                    Surface(onClick = { fullError = error }, color = MaterialTheme.colorScheme.errorContainer, shape = MaterialTheme.shapes.large, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) {
                        Row(Modifier.padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(error, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onErrorContainer, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            IconButton(engine::dismissError) { Icon(Icons.Outlined.Close, "Закрыть сообщение") }
                        }
                    }
                }
                if (isStart) {
                    StartActive(state, startProjects, Modifier.weight(1f)) { target -> engine.select(target) }
                    ProjectChip(state, { chooseProject = true })
                    if (state.target != null) EnhancedComposer(state, engine, model)
                    else Spacer(Modifier.height(16.dp))
                } else {
                    Transcript(state, Modifier.weight(1f), engine::refresh, model)
                    if (state.locked && model != null) LockedBanner(state.machine?.machine?.name) { model.requestPair(state.target?.machineId, state.machine?.machine?.name) }
                    if (!imeOpen) state.rateLimit?.let { Text(it, Modifier.padding(horizontal = 20.dp, vertical = 4.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
                    if (!imeOpen && state.turnIdle && state.background.isNotEmpty()) Text("В фоне: " + state.background.joinToString { it.description }, Modifier.padding(horizontal = 20.dp), style = MaterialTheme.typography.bodySmall)
                    if (!imeOpen && state.turnFinished && !state.busy && state.approval == null) Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.CheckCircle, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.width(8.dp))
                        Text("Ход завершён", Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        TextButton(engine::continueTurn, enabled = state.canSend) { Text("Продолжить") }
                    }
                    if (state.uncertain != null) {
                        Surface(color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.padding(16.dp), shape = HegaiTokens.Control) {
                            Column(Modifier.padding(12.dp)) {
                                Text("Отправка не подтверждена. Проверьте историю: сообщение могло дойти.", style = MaterialTheme.typography.bodyMedium)
                                Row {
                                    TextButton(engine::discardUncertain) { Text("Уже дошло") }
                                    TextButton(engine::recoverUncertain) { Text("Вернуть текст") }
                                }
                            }
                        }
                    }
                    if (!imeOpen && !state.busy && state.approval == null && state.quickReplies.isNotEmpty()) Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
                        state.quickReplies.forEach { reply -> SuggestionChip(onClick = { engine.quickReply(reply) }, label = { Text(reply.string("send").orEmpty()) }, modifier = Modifier.padding(end = 8.dp)) }
                    }
                    EnhancedComposer(state, engine, model)
                }
            }
        }
        }
    }
    drillProject?.let { id ->
        val automatedNow = showAutomated
        val title = drawerProjects(state, automatedNow, "").find { it.id == id }?.let(::projectName) ?: "Проект"
        FullScreen(title, { drillProject = null }) {
            ProjectSessions(state, id, automatedNow) { target -> engine.select(target); drillProject = null; scope.launch { drawer.close() } }
        }
    }
    if (inbox) FullScreen("Входящие", { inbox = false }) { InboxScreen(state, engine) { target -> engine.select(target); inbox = false; scope.launch { drawer.close() } } }
    if (settings && model != null) FullScreen("Настройки", { settings = false }) { SettingsScreen(state, model, logout) { settings = false; scope.launch { drawer.close() } } }
    if (flow) FullScreen("Доска", { flow = false }) { FlowScreen(state, engine) { flow = false; scope.launch { drawer.close() } } }
    if (reports && model != null) FullScreen("Отчёты", { reports = false }) { ReportsScreen(model) }
    if (team && model != null) FullScreen("Команда", { team = false }) { TeamScreen(state, model) }
    if (settings && model == null) ModalBottomSheet(onDismissRequest = { settings = false }) {
        Column(Modifier.padding(24.dp)) {
            Text("Настройки", style = MaterialTheme.typography.titleLarge)
            Text(state.viewer?.fullName ?: state.viewer?.email ?: "Локальная разработка", Modifier.padding(top = 24.dp))
            state.viewer?.workspace?.let { Text(it.name, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            Text("Hegai Code · Android ${BuildConfig.VERSION_NAME}\nСветлая и тёмная тема следуют настройкам телефона.", Modifier.padding(vertical = 24.dp), style = MaterialTheme.typography.bodyMedium)
            OutlinedButton({ settings = false; logout() }) { Text("Выйти из аккаунта") }
            Spacer(Modifier.height(24.dp))
        }
    }
    fullError?.let { error -> AlertDialog(onDismissRequest = { fullError = null }, title = { Text("Сообщение об ошибке") },
        text = { Text(error, Modifier.verticalScroll(rememberScrollState())) }, confirmButton = { TextButton({ fullError = null }) { Text("Закрыть") } }) }
    if (sessionMenu) SessionMenu(state, model, engine) { sessionMenu = false }
    if (chooseProject && model != null) AdvancedProjectPicker(state, model, { chooseProject = false; model.cancelShare() }) { target -> model.selectShared(target); chooseProject = false }
    if (chooseProject && model == null) ProjectPicker(state, { chooseProject = false }) { target -> engine.select(target); chooseProject = false }
    val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
    state.approval?.let { ApprovalDialog(it) { allow, answers, mode ->
        haptics.performHapticFeedback(if (allow) androidx.compose.ui.hapticfeedback.HapticFeedbackType.Confirm else androidx.compose.ui.hapticfeedback.HapticFeedbackType.Reject)
        engine.decideStructured(allow, answers, mode)
    } }
}

/** M3 Expressive segmented list: items of one group share a container, 2dp apart, with large outer corners
 * and small inner ones — the grouping is drawn by the shape, not by dividers. */
fun segmentShape(index: Int, count: Int): androidx.compose.ui.graphics.Shape {
    val outer = 20.dp; val inner = 4.dp
    return androidx.compose.foundation.shape.RoundedCornerShape(
        topStart = if (index == 0) outer else inner, topEnd = if (index == 0) outer else inner,
        bottomStart = if (index == count - 1) outer else inner, bottomEnd = if (index == count - 1) outer else inner)
}

private fun working(state: HubState, machineId: String, sessionId: String?) =
    state.runs.any { it.machineId == machineId && it.sessionId == sessionId && it.state == "working" } ||
        state.machines.firstOrNull { it.machine.machineId == machineId }?.sessions?.any { it.sessionId == sessionId && it.liveStatus == "busy" } == true

/** Real work and recent history; ownership and automation filtering come from drawerProjects. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable private fun StartActive(state: HubState, projects: List<DrawerProject>, modifier: Modifier, open: (Target) -> Unit) {
    val running = projects.flatMap { p -> p.sessions.filter { working(state, p.machine.machine.machineId, it.sessionId) }.map { p to it } }
    val recent = projects.flatMap { p -> p.sessions.filterNot { working(state, p.machine.machine.machineId, it.sessionId) }.map { p to it } }
        .sortedByDescending { it.second.lastModified }.take(6)
    LazyColumn(modifier.fillMaxWidth(), contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item("hero") {
            Column(Modifier.padding(top = 8.dp, bottom = 16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Что сделаем\nсегодня?", Modifier.weight(1f), style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.SemiBold)
                    if (androidx.compose.ui.platform.LocalDensity.current.fontScale <= 1.3f) ProjectArtwork(Modifier.size(96.dp, 100.dp), compact = true)
                }
                Text("От первой мысли — до готового.", Modifier.padding(top = 10.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (running.isNotEmpty()) item("running-label") { HomeSectionLabel("Сейчас в работе", running.size) }
        running.forEach { (project, session) ->
            item("run:${project.id}:${session.sessionId}") { HomeSessionCard(project, session, state, true, open) }
        }
        if (recent.isNotEmpty()) item("recent-label") { HomeSectionLabel("Недавние разговоры", recent.size) }
        recent.forEach { (project, session) ->
            item("recent:${project.id}:${session.sessionId}") { HomeSessionCard(project, session, state, false, open) }
        }
        if (running.isEmpty() && recent.isEmpty()) item("empty") {
            Surface(color = MaterialTheme.colorScheme.surfaceContainerLowest, shape = HegaiTokens.Card) {
                Column(Modifier.padding(20.dp)) {
                    Text("Здесь начинается ваша работа", style = MaterialTheme.typography.titleMedium)
                    Text(if (projects.isEmpty()) "Подключите машину в настройках, чтобы выбрать проект." else "Выберите проект ниже и опишите первую задачу.", Modifier.padding(top = 8.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable private fun HomeSectionLabel(label: String, count: Int) {
    Row(Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
        Text(count.toString(), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable private fun HomeSessionCard(project: DrawerProject, session: Session, state: HubState, active: Boolean, open: (Target) -> Unit) {
    Surface(onClick = { open(Target(project.machine.machine.machineId, session.cwd.orEmpty(), session.sessionId, session.title, session.source)) },
        shape = HegaiTokens.Card, color = if (active) MaterialTheme.colorScheme.surfaceContainerLowest else androidx.compose.ui.graphics.Color.Transparent, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(horizontal = if (active) 16.dp else 0.dp, vertical = 14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                ProjectAvatar(projectName(project), project.id, 36.dp)
                Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                    Text(state.titleFor(project.machine.machine.machineId, session).ifBlank { "Без названия" }, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(projectName(project) + " · " + project.machine.machine.name + if (project.machine.online) "" else " · офлайн", Modifier.padding(top = 4.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Icon(Icons.Outlined.KeyboardArrowRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (active) {
                Text("В работе", Modifier.padding(top = 14.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                LinearWavyProgressIndicator(Modifier.fillMaxWidth().padding(top = 8.dp), color = BrandColors.action)
            }
        }
    }
}

/** ios project chip above the start composer: folder · project · chevron; opens «Проекты». */
@Composable private fun ProjectChip(state: HubState, choose: () -> Unit) {
    val label = state.target?.takeIf { it.cwd.isNotBlank() }?.let { t ->
        state.machine?.sessions?.firstOrNull { it.cwd == t.cwd }?.project?.takeIf(String::isNotBlank) ?: t.project
    } ?: "Выбрать проект"
    Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 8.dp)) {
        Surface(onClick = choose, enabled = state.activeAccess, shape = androidx.compose.foundation.shape.RoundedCornerShape(18.dp),
            color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = Modifier.heightIn(min = 48.dp)) {
            Row(Modifier.padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.Folder, null, Modifier.size(18.dp))
                Text(label, Modifier.padding(horizontal = 8.dp).widthIn(max = 240.dp), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelLarge)
                Icon(Icons.Outlined.KeyboardArrowDown, null, Modifier.size(18.dp))
            }
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable private fun SessionDrawer(state: HubState, select: (Target) -> Unit, create: () -> Unit, settings: () -> Unit, team: () -> Unit, inbox: () -> Unit, automated: Boolean, flow: () -> Unit, reports: (() -> Unit)?, openProject: (String) -> Unit) {
    var search by rememberSaveable { mutableStateOf("") }
    Column(Modifier.fillMaxSize().padding(horizontal = 12.dp)) {
        Row(Modifier.fillMaxWidth().padding(start = 12.dp, top = 8.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            HegaiWordmark(Modifier.weight(1f))
            IconButton(settings) { Icon(Icons.Outlined.Settings, "Настройки") }
        }
        // Search and navigation scroll with projects so large text leaves the account reachable.
        // The field takes focus only when tapped: the drawer used to open straight into the keyboard,
        // which hid the menu behind it.
        var searching by remember { mutableStateOf(false) }
        val focus = remember { androidx.compose.ui.focus.FocusRequester() }
        val focusManager = androidx.compose.ui.platform.LocalFocusManager.current
        LaunchedEffect(searching) { if (searching) runCatching { focus.requestFocus() } }
        val projects = remember(state.machines, state.runs, state.viewer, automated, search) { drawerProjects(state, automated, search) }
        val list = rememberLazyListState()
        var atTop by remember { mutableStateOf(true) }
        LaunchedEffect(list) { snapshotFlow { list.isScrollInProgress }.drop(1).collect { if (!it) atTop = !list.canScrollBackward } }
        LaunchedEffect(projects.map { it.id }) { if (atTop) list.scrollToItem(0) }
        LazyColumn(Modifier.weight(1f), state = list, contentPadding = PaddingValues(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        item("search") {
        Box(Modifier.fillMaxWidth()) {
        TextField(search, { search = it }, Modifier.fillMaxWidth().focusRequester(focus).focusProperties { canFocus = searching }
            .onFocusChanged { if (!it.isFocused && search.isEmpty()) searching = false }, placeholder = { Text("Поиск сессий") },
            leadingIcon = { Icon(Icons.Outlined.Search, null) },
            trailingIcon = if (search.isNotEmpty()) { { IconButton({ search = "" }) { Icon(Icons.Outlined.Close, "Очистить поиск") } } } else null,
            singleLine = true, shape = androidx.compose.foundation.shape.RoundedCornerShape(28.dp),
            colors = TextFieldDefaults.colors(focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh, unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                focusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent, unfocusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent))
        // Until tapped, a transparent layer takes the tap: nothing in the drawer can grab focus on open.
        if (!searching) Box(Modifier.matchParentSize().clickable(interactionSource = null, indication = null) { searching = true })
        }
        }
        item("new-chat") {
            if (state.activeAccess) Button({ focusManager.clearFocus(); create() }, Modifier.fillMaxWidth().heightIn(min = 52.dp).semantics { contentDescription = "Новый чат" }) {
                Icon(Icons.Outlined.Add, null); Spacer(Modifier.width(8.dp)); Text("Новый чат")
            }
        }
        item("places") {
            // Wrap at large font scales instead of shrinking labels or hit targets.
            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(flow) { Icon(Icons.Outlined.ViewKanban, null, Modifier.size(20.dp)); Spacer(Modifier.width(8.dp)); Text("Доска") }
                if (reports != null) TextButton(reports) { Icon(Icons.Outlined.Description, null, Modifier.size(20.dp)); Spacer(Modifier.width(8.dp)); Text("Отчёты") }
            }
        }
            val favorites = projects.flatMap { p -> p.sessions.filter { "${p.machine.machine.machineId}:${it.sessionId}" in state.favorites }.map { p.machine to it } }
            if (favorites.isNotEmpty()) item("favorites") { Text("Избранное", Modifier.padding(16.dp), style = MaterialTheme.typography.titleSmall) }
            favorites.forEach { (machine, session) -> item("favorite:${machine.machine.machineId}:${session.sessionId}") { SessionItem(machine, session, state, select) } }
            projects.forEach { project -> item(project.id) { ProjectSection(project, state, select, search.isNotEmpty(), { openProject(project.id) }, Modifier.animateItem()) } }
            if (state.machines.none { m -> m.sessions.any { state.isMine(m, it) } }) item {
                Text("Здесь появятся ваши сессии с подключённых машин.", Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        // Account row (Gemini/ChatGPT pattern): who is signed in, and the three secondary places.
        Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            val name = state.viewer?.let { v -> v.fullName?.takeIf(String::isNotBlank) ?: v.email?.takeIf(String::isNotBlank) ?: v.telegram?.takeIf(String::isNotBlank) } ?: "Аккаунт"
            Surface(onClick = settings, shape = androidx.compose.foundation.shape.RoundedCornerShape(28.dp), color = androidx.compose.ui.graphics.Color.Transparent, modifier = Modifier.weight(1f)) {
                Row(Modifier.padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    AccountAvatar(name)
                    Text(name, Modifier.padding(start = 12.dp), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleSmall)
                }
            }
            val unread = state.notices.count { it.unread }
            IconButton(inbox) {
                BadgedBox(badge = { if (unread > 0) Badge { Text(if (unread > 99) "99+" else unread.toString()) } }) {
                    Icon(Icons.Outlined.Notifications, if (unread > 0) "Входящие: $unread" else "Входящие")
                }
            }
            IconButton(team) { Icon(Icons.Outlined.People, "Команда") }
        }
    }
}
private data class DrawerProject(val id: String, val machine: Machine, val cwd: String, val sessions: List<Session>)
/** Order (Owner, 11.11.2026, as on iOS/web): waiting for the user (run needs_attention / error), then
 * working, then quiet — for sessions inside a project and for projects; inside each group by creation
 * time (createdAt, else lastModified) newest first, then id. Sorting by the last change made the drawer
 * jump on every message. An open editor (livePid) alone is not «working». */
private fun drawerProjects(state: HubState, automated: Boolean, search: String): List<DrawerProject> {
    fun waiting(machine: Machine, session: Session) = state.runs.any { it.machineId == machine.machine.machineId && it.sessionId == session.sessionId && (it.state == "needs_attention" || it.state == "error") }
    fun created(s: Session) = s.createdAt ?: s.lastModified
    fun rank(machine: Machine, s: Session) = if (waiting(machine, s)) 2 else if (working(state, machine.machine.machineId, s.sessionId)) 1 else 0
    return state.machines.flatMap { machine ->
        machine.sessions.filter { state.isMine(machine, it) && (automated || !it.automated) }
            .filter { search.isBlank() || "${state.titleFor(machine.machine.machineId, it)} ${it.title} ${it.project} ${it.cwd} ${machine.machine.name}".contains(search.trim(), ignoreCase = true) }
            .groupBy { it.cwd.orEmpty().let { cwd -> if (machine.machine.os == "win32") cwd.lowercase() else cwd } }
            .map { (cwd, group) ->
                DrawerProject("${machine.machine.machineId}:$cwd", machine, group.first().cwd.orEmpty(), group.sortedWith(
                    compareByDescending<Session> { rank(machine, it) }.thenByDescending { created(it) }.thenBy { it.sessionId }))
            }
    }.sortedWith(compareByDescending<DrawerProject> { p -> p.sessions.maxOf { rank(p.machine, it) } }
        .thenByDescending { p -> p.sessions.maxOf { created(it) } }.thenBy { it.id })
}
/** A project in the drawer (ios SessionDrawer): header (project, machine, «+»), its first FOUR sessions
 * in the stable order (see drawerProjects; a working one beyond them is still shown, in list order), and «Все сессии · N» leading into the project — never the whole list inline. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable private fun ProjectSection(project: DrawerProject, state: HubState, select: (Target) -> Unit, searching: Boolean, open: () -> Unit, modifier: Modifier = Modifier) {
    val machine = project.machine; val cwd = project.cwd; val sorted = project.sessions
    Column(modifier.fillMaxWidth().padding(top = 8.dp).clip(HegaiTokens.Card).background(MaterialTheme.colorScheme.surfaceContainerLowest).padding(vertical = 4.dp)) {
        Row(Modifier.padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            ProjectAvatar(projectName(project), project.id)
            Column(Modifier.weight(1f).heightIn(min = 48.dp).clip(MaterialTheme.shapes.small).clickable(onClick = open).padding(start = 12.dp, top = 4.dp, bottom = 4.dp)) {
                Text(projectName(project), style = MaterialTheme.typography.titleSmallEmphasized, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(machine.machine.name + (if (machine.machine.isPrivate) " · зашифрована" else "") + (if (machine.online) "" else " · офлайн"), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
            }
            if (cwd.isNotBlank() && machine.online && (machine.canStart || machine.canControl)) IconButton({ select(Target(machine.machine.machineId, cwd)) }) { Icon(Icons.Outlined.Add, "Новый чат в проекте") }
        }
        val shown = if (searching) sorted else sorted.filterIndexed { i, it -> i < 4 || working(state, machine.machine.machineId, it.sessionId) }
        shown.forEach { session -> SessionItem(machine, session, state, select) }
        if (!searching && sorted.size > 4) TextButton(open, Modifier.padding(start = 4.dp)) { Text("Все сессии · ${sorted.size}") }
    }
}

private fun projectName(project: DrawerProject) = project.sessions.firstOrNull()?.project?.takeIf(String::isNotBlank)
    ?: if (project.cwd.isBlank() && project.machine.machine.isPrivate) "Зашифровано" else Target(project.machine.machine.machineId, project.cwd).project

/** A private machine whose key this phone lacks (docs/E2EE.md, Clients): nothing is read or sent until a code is entered. */
@Composable private fun LockedBanner(machineName: String?, pair: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = HegaiTokens.Control, modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.Lock, null, Modifier.size(20.dp))
                Text("Зашифровано на машине" + (machineName?.let { " · $it" } ?: "") + " — нужен ключ", Modifier.padding(start = 8.dp), style = MaterialTheme.typography.titleSmall)
            }
            Text("Сервер не может прочитать эти сессии, и телефон тоже, пока не введён код пары с машины. Писать в такую машину без ключа нельзя.", Modifier.padding(top = 8.dp), style = MaterialTheme.typography.bodyMedium)
            Button(pair, Modifier.padding(top = 8.dp)) { Text("Ввести код пары") }
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable private fun SessionItem(machine: Machine, session: Session, state: HubState, select: (Target) -> Unit) {
    val selected = state.target?.machineId == machine.machine.machineId && state.target?.sessionId == session.sessionId
    val busy = working(state, machine.machine.machineId, session.sessionId)
    NavigationDrawerItem(
        label = { Text(state.titleFor(machine.machine.machineId, session).ifBlank { "Без названия" }, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        selected = selected,
        onClick = { select(Target(machine.machine.machineId, session.cwd.orEmpty(), session.sessionId, session.title, session.source)) },
        icon = if (busy) { { LoadingIndicator(Modifier.size(24.dp)) } } else if (state.unread(machine.machine.machineId, session.sessionId)) { { Icon(Icons.Outlined.MarkChatUnread, "Непрочитано") } } else null,
        modifier = Modifier.heightIn(min = 48.dp),
        colors = NavigationDrawerItemDefaults.colors(unselectedContainerColor = androidx.compose.ui.graphics.Color.Transparent, selectedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh),
    )
}

/** The drill-in (ios ProjectSessions): every session of one project, searchable, «+» for a new chat in it. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable private fun ProjectSessions(state: HubState, projectId: String, automated: Boolean, select: (Target) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    val project = remember(state.machines, state.runs, state.viewer, automated) { drawerProjects(state, automated, "") }.find { it.id == projectId }
    if (project == null) { Text("Проект больше не доступен.", Modifier.padding(24.dp), color = MaterialTheme.colorScheme.onSurfaceVariant); return }
    val machine = project.machine
    Column(Modifier.fillMaxSize().padding(horizontal = 12.dp)) {
        Text(machine.machine.name + " · " + project.cwd, Modifier.padding(start = 16.dp, bottom = 12.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextField(query, { query = it }, Modifier.weight(1f), placeholder = { Text("Поиск в проекте") }, leadingIcon = { Icon(Icons.Outlined.Search, null) }, singleLine = true,
                shape = androidx.compose.foundation.shape.RoundedCornerShape(28.dp),
                colors = TextFieldDefaults.colors(focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh, unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                    focusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent, unfocusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent))
            if (project.cwd.isNotBlank() && machine.online && (machine.canStart || machine.canControl))
                FilledTonalIconButton({ select(Target(machine.machine.machineId, project.cwd)) }, shapes = IconButtonDefaults.shapes()) { Icon(Icons.Outlined.Add, "Новый чат в проекте") }
        }
        val shown = project.sessions.filter { query.isBlank() || state.titleFor(machine.machine.machineId, it).contains(query.trim(), ignoreCase = true) }
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(vertical = 8.dp)) {
            items(shown, key = { it.sessionId }) { session -> Box(Modifier.animateItem()) { SessionItem(machine, session, state, select) } }
            if (shown.isEmpty()) item { Text("Ничего не найдено.", Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun ProjectPicker(state: HubState, dismiss: () -> Unit, select: (Target) -> Unit) {
    var source by rememberSaveable { mutableStateOf("claude") }
    var query by rememberSaveable { mutableStateOf("") }
    ModalBottomSheet(onDismissRequest = dismiss) {
        Column(Modifier.padding(24.dp)) {
            Text("Новый чат", style = MaterialTheme.typography.titleLarge)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(source == "claude", { source = "claude" }, label = { Text("Claude") })
                FilterChip(source == "codex", { source = "codex" }, label = { Text("Codex") })
            }
            OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), label = { Text("Проект или машина") }, singleLine = true)
            val projects = state.machines.filter { it.online && (it.canControl || it.canStart) }.flatMap { machine ->
                machine.sessions.mapNotNull { it.cwd }.filter { it.isNotBlank() }.distinct().map { cwd -> machine to cwd }
            }.filter { (machine, cwd) -> "$cwd ${machine.machine.name}".contains(query, ignoreCase = true) }
            LazyColumn(Modifier.heightIn(max = 400.dp)) {
                items(projects, key = { "${it.first.machine.machineId}:${it.second}" }) { (machine, cwd) ->
                    ListItem(headlineContent = { Text(Target(machine.machine.machineId, cwd).project) }, supportingContent = { Text("${machine.machine.name}\n$cwd", style = MaterialTheme.typography.bodyMedium) },
                        modifier = Modifier.clickable { select(Target(machine.machine.machineId, cwd, source = source)) })
                }
                if (projects.isEmpty()) item { Text("Пока нет доступных проектов. Откройте первую сессию на подключённой машине — проект появится здесь.", Modifier.padding(vertical = 24.dp)) }
            }
        }
    }
}
@Composable private fun ApprovalDialog(request: Approval, decide: (Boolean, JsonObject, String?) -> Unit) {
    var picked by remember(request.requestId) { mutableStateOf<Map<String, Set<String>>>(emptyMap()) }
    var custom by remember(request.requestId) { mutableStateOf<Map<String, String>>(emptyMap()) }
    val answers = buildJsonObject {
        request.questions.forEach { question ->
            val key = question.string("id") ?: question.string("question") ?: return@forEach
            val values = picked[key].orEmpty().toList() + listOfNotNull(custom[key]?.trim()?.takeIf(String::isNotBlank))
            if (values.isNotEmpty()) put(key, if (question["multiSelect"]?.jsonPrimitive?.booleanOrNull == true) JsonArray(values.map(::JsonPrimitive)) else JsonPrimitive(values.last()))
        }
    }
    val plan = request.tool == "ExitPlanMode"
    if (plan) {
        AlertDialog(onDismissRequest = {}, title = { Text("Подтверждение плана") }, text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Markdown(request.input.string("plan") ?: "Готовы выполнить план?")
                Button({ decide(true, answers, "default") }, Modifier.fillMaxWidth().padding(top = 16.dp)) { Text("Подтвердить с проверкой правок") }
                OutlinedButton({ decide(true, answers, "acceptEdits") }, Modifier.fillMaxWidth()) { Text("Подтвердить и принимать правки") }
                TextButton({ decide(false, buildJsonObject {}, null) }, Modifier.fillMaxWidth()) { Text("Продолжить планирование") }
            }
        }, confirmButton = {})
        return
    }
    AlertDialog(onDismissRequest = {}, title = { Text(request.title ?: when { plan -> "Подтверждение плана"; request.isQuestion -> "Нужен ваш ответ"; else -> "Разрешить действие?" }) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text(request.tool, style = MaterialTheme.typography.labelSmall)
                if (request.isQuestion) request.questions.forEach { question ->
                    val label = question.string("question") ?: return@forEach
                    val key = question.string("id") ?: label
                    val multi = question["multiSelect"]?.jsonPrimitive?.booleanOrNull == true
                    Text(label, Modifier.padding(top = 16.dp), style = MaterialTheme.typography.titleMedium)
                    (question["options"] as? JsonArray)?.forEach optionLoop@ { option ->
                        val item = option as? JsonObject ?: return@optionLoop
                        val value = item.string("label") ?: return@optionLoop
                        val selected = value in picked[key].orEmpty()
                        Row(Modifier.fillMaxWidth().clickable {
                            picked = picked + (key to if (multi) { if (selected) picked[key].orEmpty() - value else picked[key].orEmpty() + value } else setOf(value))
                            if (!multi) custom = custom - key
                        }, verticalAlignment = Alignment.CenterVertically) {
                            if (multi) Checkbox(selected, null) else RadioButton(selected, null)
                            Column(Modifier.weight(1f)) { Text(value); item.string("description")?.let { Text(it, style = MaterialTheme.typography.bodySmall) } }
                        }
                    }
                    OutlinedTextField(custom[key].orEmpty(), { custom = custom + (key to it); if (!multi) picked = picked - key }, label = { Text("Свой ответ") }, modifier = Modifier.fillMaxWidth())
                } else if (plan) Markdown(request.input.string("plan") ?: "Готовы выполнить план?")
                else SelectionContainer { Text(request.input.toString(), Modifier.padding(top = 16.dp), fontFamily = HegaiTokens.Mono, style = MaterialTheme.typography.bodyMedium) }
            }
        }, confirmButton = {
            Column {
                TextButton({ decide(true, answers, if (plan) "default" else null) }, enabled = !request.isQuestion || answers.size == request.questions.size) { Text(when { plan -> "Подтвердить с проверкой правок"; request.isQuestion -> "Ответить"; else -> "Разрешить" }) }
                if (plan) TextButton({ decide(true, answers, "acceptEdits") }) { Text("Подтвердить и принимать правки") }
            }
        }, dismissButton = { TextButton({ decide(false, buildJsonObject {}, null) }) { Text(if (plan) "Продолжить планирование" else "Отклонить") } })
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable private fun FullScreen(title: String, dismiss: () -> Unit, content: @Composable () -> Unit) {
    Dialog(onDismissRequest = dismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
            Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding()) {
                TopAppBar(title = { Text(title, style = MaterialTheme.typography.titleLargeEmphasized) },
                    navigationIcon = { IconButton(dismiss) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Назад") } },
                    windowInsets = WindowInsets(0), colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface))
                content()
            }
        }
    }
}
