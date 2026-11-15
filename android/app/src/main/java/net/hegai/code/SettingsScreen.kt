package net.hegai.code

import androidx.compose.foundation.*
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.platform.LocalContext
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import net.hegai.code.core.*
import java.text.DateFormat
import java.util.Date

fun JsonObject.rows(key: String) = (get(key) as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()
fun JsonObject.number(key: String) = (get(key) as? JsonPrimitive)?.doubleOrNull
fun JsonObject.flag(key: String) = (get(key) as? JsonPrimitive)?.booleanOrNull == true
fun dateLabel(ms: Double?) = ms?.takeIf { it > 0 }?.let { DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(it.toLong())) } ?: "—"
fun sizeLabel(bytes: Double?) = bytes?.let { if (it >= 1024 * 1024 * 1024) "%.1f ГБ".format(it / (1024 * 1024 * 1024)) else "%.0f МБ".format(it / (1024 * 1024)) } ?: "—"

@Composable fun Section(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Text(title, Modifier.padding(bottom = 8.dp), style = MaterialTheme.typography.titleMedium)
        Surface(shape = HegaiTokens.Card, color = MaterialTheme.colorScheme.surface) {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp), content = content)
        }
    }
}
@Composable fun ValueRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth().heightIn(min = 32.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
        Text(value, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
    }
}
@Composable fun ErrorNote(error: String?) { error?.let { Text(it, Modifier.padding(vertical = 8.dp), color = MaterialTheme.colorScheme.error) } }
@Composable fun SettingsScreen(state: HubState, model: HubViewModel, logout: () -> Unit, navigated: () -> Unit = {}) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    Column(Modifier.fillMaxSize()) {
        ScrollableTabRow(tab, edgePadding = 12.dp) { listOf("Аккаунт", "Отчёты", "Доска", "Железо", "Память", "Профиль").forEachIndexed { i, label ->
            Tab(tab == i, { tab = i }, text = { Text(label) })
        } }
        key(state.viewer?.userId, state.viewer?.workspace?.workspaceId, tab) {
            when(tab) { 0 -> AccountSettings(state, model, logout); 1 -> ReportsScreen(model); 2 -> FlowScreen(state, model.engine, navigated); 3 -> HardwareSettings(state, model); 4 -> MemorySettings(model); else -> ProfileSettings(state) }
        }
    }
}
@Composable private fun AccountSettings(state: HubState, model: HubViewModel, logout: () -> Unit) {
    val theme by model.theme.collectAsStateWithLifecycle()
    val automated by model.automated.collectAsStateWithLifecycle()
    val voiceMode by model.voiceMode.collectAsStateWithLifecycle()
    val aiConsented by model.aiConsented.collectAsStateWithLifecycle()
    val hubBase by model.hubBase.collectAsStateWithLifecycle()
    var serverOpen by rememberSaveable { mutableStateOf(false) }
    val prefetch by model.prefetch.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var notifications by remember { mutableStateOf(PushNotifications.enabled(context)) }
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
        notifications = allowed; model.setNotifications(allowed)
    }
    var quota by remember { mutableStateOf<JsonObject?>(null) }
    var budget by remember { mutableStateOf<JsonObject?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var confirmLogout by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    var deleteTyped by remember { mutableStateOf("") }
    var deleting by remember { mutableStateOf(false) }
    var deleteError by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    var clear by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        runCatching { model.api("/api/gateway-quota") }.onSuccess { quota = it }.onFailure { error = it.message }
        runCatching { model.api("/api/budget") }.onSuccess { budget = it }
    }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 20.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
        item { Section("Аккаунт") {
            Text(state.viewer?.fullName ?: "Hegai"); Text(state.viewer?.email.orEmpty(), style = MaterialTheme.typography.bodyMedium)
            TextButton({ confirmLogout = true }) { Text("Выйти из аккаунта") }
            // Google Play: an app with accounts must let the person delete it from inside the app.
            TextButton({ deleteError = null; deleteTyped = ""; confirmDelete = true }) {
                Text("Удалить аккаунт", color = MaterialTheme.colorScheme.error)
            }
            TextButton({ runCatching { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(HubUrl.deleteAccount(hubBase)))) } }) {
                Text("Другие способы удалить аккаунт", style = MaterialTheme.typography.bodySmall)
            }
            TextButton({ runCatching { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(HubUrl.privacy(hubBase)))) } }) {
                Text("Политика конфиденциальности")
            }
        } }
        item { Section("Сервер") {
            ValueRow("Адрес", HubUrl.label(hubBase))
            TextButton({ serverOpen = true }) { Text("Изменить сервер") }
        } }
        item { SignInMethods(model, state.activeAccess) }
        item { Section("Рабочее пространство") {
            selectableWorkspaces(state.viewer?.workspaces.orEmpty()).forEach { workspace ->
                RadioRow(workspace.name, workspace.workspaceId == state.viewer?.workspace?.workspaceId) { model.switchWorkspace(workspace.workspaceId) }
            }
        } }
        item { Section("Внешний вид") {
            listOf("system" to "Как на телефоне", "light" to "Светлая", "dark" to "Тёмная").forEach { (id, name) -> RadioRow(name, theme == id) { model.setTheme(id) } }
        } }
        item { Section("Передача данных AI") {
            Text(if (aiConsented) "Передача сообщений, кода и контекста настроенным AI-провайдерам разрешена." else "Можно читать историю. Для отправки и обработки диктовки нужно согласие.")
            TextButton({ if (aiConsented) model.setAIConsent(false) else model.requestAIDataConsent() }) { Text(if (aiConsented) "Отозвать согласие" else "Как используются данные") }
        } }
        item { Section("Диктовка") {
            RadioRow("Распознавание на сервере · с обработкой текста", voiceMode == "server") { model.setVoiceMode("server") }
            RadioRow("Распознавание телефона", voiceMode == "phone") { model.setVoiceMode("phone") }
            Text("При сбое сервера запись остаётся на телефоне для повторной попытки.", style = MaterialTheme.typography.bodySmall)
        } }
        item { NewSessionDefaults(state, model) }
        item { Section("Лимиты") {
            state.machines.forEach { machine ->
                machine.usage?.let { UsageCard("Claude · ${machine.machine.name}", it) }
                machine.codexUsage?.let { UsageCard("Codex · ${machine.machine.name}", it) }
            }
            quota?.objectValue("gatewayQuota")?.let { GatewayUsage(it) }
            budget?.let { value ->
                value.objectValue("limits")?.let { limits ->
                    Text("Мой лимит", style = MaterialTheme.typography.titleMedium)
                    listOf("tokens" to "Токены", "requests" to "Запросы").forEach { (key, label) ->
                        val used = limits.number("${key}Used"); val cap = limits.number(key)
                        if (used != null && cap != null && cap > 0) ValueRow(label, "${used.toLong()} / ${cap.toLong()}")
                    }
                }
            }
            if (state.machines.none { it.usage != null || it.codexUsage != null } && quota?.objectValue("gatewayQuota") == null) Text("Данные о лимитах пока недоступны")
            ErrorNote(error)
        } }
        item { Section("Списки") {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("Показывать скриптовые сессии", Modifier.weight(1f)); Switch(automated, model::setAutomated)
            }
        } }
        item { Section("Уведомления") {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("Присылать уведомления", Modifier.weight(1f))
                Switch(notifications, { enabled ->
                    if (enabled && android.os.Build.VERSION.SDK_INT >= 33) notificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
                    else { notifications = enabled; model.setNotifications(enabled) }
                }, enabled = PushNotifications.available(context))
            }
            Text(if (PushNotifications.available(context)) "Уведомления о завершении работы, ошибках и запросах подтверждения." else "Фоновые уведомления ещё не подключены в этой сборке.", style = MaterialTheme.typography.bodyMedium)
        } }
        item { Section("Копия на телефоне") {
            Text("История открытых сессий, черновики и изображения сохраняются в зашифрованном хранилище. Неподтверждённые сообщения требуют проверки перед повторной отправкой.", style = MaterialTheme.typography.bodyMedium)
            prefetch?.let { Text("Скачиваем ${it.first} из ${it.second}…") }
            TextButton({ model.prefetchRecent(force = true) }, enabled = prefetch == null && state.connection == Connection.READY) { Text("Скачать последние разговоры") }
            TextButton({ clear = true }) { Text("Очистить сохранённую историю") }
        } }
        item { Text("Hegai Code · ${BuildConfig.VERSION_NAME}", Modifier.padding(vertical = 24.dp), style = MaterialTheme.typography.bodyMedium) }
    }
    if (serverOpen) HubServerDialog(model, signedIn = true) { serverOpen = false }
    if (confirmLogout) AlertDialog(onDismissRequest = { confirmLogout = false }, title = { Text("Выйти из аккаунта?") },
        text = { Text("Локальные черновики и история на этом телефоне будут удалены. История на сервере сохранится.") },
        confirmButton = { TextButton(logout) { Text("Выйти") } }, dismissButton = { TextButton({ confirmLogout = false }) { Text("Отмена") } })
    if (confirmDelete) AlertDialog(onDismissRequest = { if (!deleting) confirmDelete = false }, title = { Text("Удалить аккаунт?") },
        text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Это нельзя отменить. С сервера Hegai Code будут удалены: аккаунт и все входы в него, личное пространство и команды, где вы единственный участник, подключённые компьютеры и их копия истории сессий, память, push-токены и ключ доступа к моделям. Файлы на самих компьютерах останутся.", style = MaterialTheme.typography.bodyMedium)
            Text("Чтобы подтвердить, введите УДАЛИТЬ", style = MaterialTheme.typography.bodyMedium)
            OutlinedTextField(deleteTyped, { deleteTyped = it; deleteError = null }, singleLine = true, enabled = !deleting)
            ErrorNote(deleteError)
        } },
        confirmButton = { TextButton({
            deleting = true
            scope.launch {
                runCatching { model.deleteAccount() }
                    .onSuccess { android.widget.Toast.makeText(context, "Аккаунт удалён", android.widget.Toast.LENGTH_LONG).show() }
                    .onFailure { deleteError = it.message ?: "Не удалось удалить аккаунт" }
                deleting = false
            }
        }, enabled = !deleting && deleteTyped.trim().uppercase() == "УДАЛИТЬ") { Text(if (deleting) "Удаляем…" else "Удалить навсегда", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton({ confirmDelete = false }, enabled = !deleting) { Text("Отмена") } })
    if (clear) AlertDialog(onDismissRequest = { clear = false }, title = { Text("Очистить историю этого пространства?") },
        text = { Text("Черновики и другие пространства сохранятся. История снова загрузится с сервера при открытии сессии.") },
        confirmButton = { TextButton({ model.clearHistoryCache(); clear = false }) { Text("Очистить") } }, dismissButton = { TextButton({ clear = false }) { Text("Отмена") } })
}
@Composable fun UsageCard(label: String, usage: JsonObject) {
    Text(label, style = MaterialTheme.typography.titleMedium)
    usage.string("account")?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
    usage.string("subscription")?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
    val limits = usage.rows("limits").ifEmpty {
        listOf("fiveHour" to "За 5 часов", "sevenDay" to "За неделю").mapNotNull { (key, name) -> usage.objectValue(key)?.let { JsonObject(it + ("label" to JsonPrimitive(name))) } }
    }
    limits.forEach { limit ->
        val percent = limit.number("percent") ?: limit.number("utilization")
        ValueRow(limit.string("label") ?: "Использовано", percent?.let { "%.0f%%".format(it) } ?: "—")
        if (percent != null) LinearProgressIndicator(progress = { (percent / 100).toFloat().coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
        limit.number("resetsAt")?.let { Text("Сброс: ${dateLabel(it)}", style = MaterialTheme.typography.bodyMedium) }
    }
    Text("Обновлено: ${dateLabel(usage.number("updatedAt"))}", style = MaterialTheme.typography.bodyMedium)
}
@Composable private fun GatewayUsage(value: JsonObject) {
    Text("Шлюз", style = MaterialTheme.typography.titleMedium)
    if (!value.flag("ok")) { Text("Данные пока недоступны"); return }
    listOf("primary" to "Основной период", "secondary" to "Дополнительный период").forEach { (prefix, label) ->
        value.number("${prefix}_used_percent")?.let { percent ->
            ValueRow(label, "%.0f%%".format(percent))
            LinearProgressIndicator(progress = { (percent / 100).toFloat().coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
            value.number("${prefix}_reset_at")?.let { Text("Сброс: ${dateLabel(it * 1000)}", style = MaterialTheme.typography.bodyMedium) }
        }
    }

}

@Composable private fun HardwareSettings(state: HubState, model: HubViewModel) {
    DisposableEffect(model, state.connection) { model.engine.statsInterest(true); onDispose { model.engine.statsInterest(false) } }
    var devices by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var enrollment by remember { mutableStateOf<JsonObject?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var processMachine by remember { mutableStateOf<Machine?>(null) }
    var revoke by remember { mutableStateOf<JsonObject?>(null) }
    var loading by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    suspend fun reload() { devices = model.api("/api/devices").rows("devices") }
    val hubBase by model.hubBase.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { runCatching { reload() }.onFailure { error = it.message } }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 20.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
        item { ErrorNote(error) }
        items(state.machines, key = { it.machine.machineId }) { machine -> Section(machine.machine.name) {
            ValueRow("Состояние", if (machine.online) "В сети" else "Не в сети")
            machine.stats?.let { stats ->
                ValueRow("Процессор", "${stats.number("cpuPercent")?.toInt() ?: 0}% · ${stats.number("cpuCount")?.toInt() ?: 0} ядер")
                ValueRow("Оперативная память", "${sizeLabel(stats.number("memUsed"))} / ${sizeLabel(stats.number("memTotal"))}")
                ValueRow("Диск", "${sizeLabel(stats.number("diskUsed"))} / ${sizeLabel(stats.number("diskTotal"))}")
                ValueRow("Swap", "${sizeLabel(stats.number("swapUsed"))} / ${sizeLabel(stats.number("swapTotal"))}")
                ValueRow("Работает", "${((stats.number("uptimeSec") ?: 0.0) / 3600).toInt()} ч")
                Text("Обновлено: ${dateLabel(stats.number("ts"))}", style = MaterialTheme.typography.bodyMedium)
            }
            machine.runtimes?.let { runtimes -> listOf("claude", "codex").forEach { agent -> runtimes.objectValue(agent)?.let { runtime ->
                ValueRow(agent.replaceFirstChar(Char::uppercase), runtime.string("account") ?: if (!runtime.flag("present")) "Не найден" else if (runtime.string("auth") == "none") "Нужен вход" else "Установлен")
            } } }
            TextButton({ processMachine = machine }, enabled = machine.online && machine.canControl) { Text("Процессы") }
            if (machine.machine.isPrivate || machine.machine.machineId in state.keyed) {
                ValueRow("Шифрование", if (machine.machine.machineId in state.keyed) "Ключ на этом телефоне" else "Нужен ключ")
                TextButton({ model.requestPair(machine.machine.machineId, machine.machine.name) }) { Text(if (machine.machine.machineId in state.keyed) "Ключ шифрования" else "Ввести код пары") }
            }
        } }
        item { Section("Подключить машину") {
            enrollment?.let { value -> SelectionContainer { Text(value.string("code").orEmpty(), fontFamily = HegaiTokens.Mono) }
                Text("Действует до ${dateLabel(value.number("expiresAt"))}", style = MaterialTheme.typography.bodyMedium) }
            Text("Инструкция: ${HubUrl.install(hubBase)}", style = MaterialTheme.typography.bodyMedium)
            Button({ scope.launch { loading = true; runCatching { model.api("/api/enrollments", "POST") }.onSuccess { enrollment = it }.onFailure { error = it.message }; loading = false } }, enabled = !loading) { Text("Получить код подключения") }
        } }
        item { Section("Мои устройства") {
            if (devices.isEmpty()) Text("Устройства пока не подключены")
            devices.forEach { device ->
                Text(device.string("name") ?: "Устройство", style = MaterialTheme.typography.titleMedium)
                Text("${device.string("os")} · ${if (state.machines.any { it.machine.machineId == device.string("machineId") && it.online }) "В сети" else "Не в сети"}", style = MaterialTheme.typography.bodyMedium)
                if (device["revokedAt"] != null && device["revokedAt"] != JsonNull) TextButton({ scope.launch {
                    runCatching { model.api("/api/devices/${segment(device.string("machineId").orEmpty())}/restore", "POST"); reload() }.onFailure { error = it.message }
                } }) { Text("Восстановить доступ") }
                else TextButton({ revoke = device }) { Text("Отозвать доступ") }
            }
        } }
    }
    revoke?.let { device -> AlertDialog(onDismissRequest = { revoke = null }, title = { Text("Отозвать доступ машины?") }, text = { Text(device.string("name").orEmpty()) },
        confirmButton = { TextButton({ revoke = null; scope.launch { runCatching { model.api("/api/devices/${segment(device.string("machineId").orEmpty())}", "DELETE"); reload() }.onFailure { error = it.message } } }) { Text("Отозвать") } },
        dismissButton = { TextButton({ revoke = null }) { Text("Отмена") } }) }
    processMachine?.let { Processes(it, model) { processMachine = null } }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun Processes(machine: Machine, model: HubViewModel, dismiss: () -> Unit) {
    var processes by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var selection by remember { mutableStateOf<JsonObject?>(null) }
    val scope = rememberCoroutineScope()
    suspend fun reload() { processes = model.rpc(machine.machine.machineId, "proc.list").rows("processes") }
    LaunchedEffect(Unit) { runCatching { reload() }.onFailure { error = it.message } }
    ModalBottomSheet(onDismissRequest = dismiss) {
        LazyColumn(Modifier.fillMaxWidth().padding(horizontal = 20.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
            item { Text("Процессы · ${machine.machine.name}", style = MaterialTheme.typography.titleLarge); ErrorNote(error)
                TextButton({ scope.launch { runCatching { reload() }.onFailure { error = it.message } } }) { Text("Обновить") } }
            items(processes) { process ->
                ListItem(headlineContent = { Text(process.string("command") ?: "Процесс", maxLines = 3) }, supportingContent = { Text("PID ${process.number("pid")?.toInt()} · CPU ${process.number("cpu")}% · ${sizeLabel(process.number("rss"))}") }, modifier = Modifier.clickable { selection = process })
            }
        }
    }
    selection?.let { process -> AlertDialog(onDismissRequest = { selection = null }, title = { Text("Остановить процесс?") }, text = { Text(process.string("command").orEmpty()) },
        confirmButton = { TextButton({ selection = null; scope.launch {
            runCatching { val result = model.rpc(machine.machine.machineId, "proc.kill", buildJsonObject { put("pid", process.number("pid")!!.toInt()); put("signal", "TERM") })
                check(result.flag("ok")) { result.string("error") ?: "Не удалось остановить процесс" }; reload() }.onFailure { error = it.message }
        } }) { Text("Остановить") } }, dismissButton = { TextButton({ selection = null }) { Text("Отмена") } }) }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun MemorySettings(model: HubViewModel) {
    var entries by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var selected by remember { mutableStateOf<JsonObject?>(null) }
    var body by remember { mutableStateOf<String?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    suspend fun reload() { entries = model.request("memory_list").rows("memories").filterNot { it.flag("deleted") } }
    fun address(entry: JsonObject) = buildJsonObject { listOf("scope", "scopeKey", "path").forEach { key -> entry[key]?.let { put(key, it) } } }
    LaunchedEffect(Unit) { loading = true; runCatching { reload() }.onFailure { error = it.message }; loading = false }
    LaunchedEffect(selected) { body = null; selected?.let { entry -> runCatching { model.request("memory_read", address(entry)).string("content") }.onSuccess { body = it }.onFailure { error = it.message } } }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 20.dp)) {
        item { OutlinedTextField(query, { query = it }, label = { Text("Поиск в памяти") }, modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp)); ErrorNote(error)
            if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (!loading && entries.isEmpty()) Text("Пока нет сохранённых заметок") }
        items(entries.filter { "${it.string("path")} ${it.string("scopeKey")}".contains(query, true) }) { entry ->
            ListItem(headlineContent = { Text(entry.string("path").orEmpty()) }, supportingContent = { Text("${entry.string("scopeKey").orEmpty()} · ${dateLabel(entry.number("updatedAt"))}") }, modifier = Modifier.clickable { selected = entry })
        }
    }
    selected?.let { entry -> ModalBottomSheet(onDismissRequest = { selected = null }) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp)) {
            Text(entry.string("path").orEmpty(), style = MaterialTheme.typography.titleLarge)
            ErrorNote(error)
            if (body == null) Text("Загрузка…") else Markdown(body!!, Modifier.fillMaxWidth().padding(vertical = 16.dp))
            TextButton({ confirmDelete = true }) { Text("Удалить заметку", color = MaterialTheme.colorScheme.error) }
        }
    } }
    if (confirmDelete) AlertDialog(onDismissRequest = { confirmDelete = false }, title = { Text("Удалить заметку?") }, text = { Text("Удаление синхронизируется с подключёнными машинами.") },
        confirmButton = { TextButton({ val entry = selected ?: return@TextButton; confirmDelete = false; scope.launch {
            runCatching { model.request("memory_delete", address(entry)); selected = null; reload() }.onFailure { error = it.message }
        } }) { Text("Удалить") } }, dismissButton = { TextButton({ confirmDelete = false }) { Text("Отмена") } })
}

@Composable private fun ProfileSettings(state: HubState) {
    var selected by rememberSaveable { mutableStateOf<String?>(null) }
    val available = state.machines.filter { it.profile != null }
    val machine = available.firstOrNull { it.machine.machineId == selected } ?: available.firstOrNull()
    val profile = machine?.profile
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 20.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
        item {
            Row(Modifier.horizontalScroll(rememberScrollState())) { available.forEach { m -> FilterChip(machine == m, { selected = m.machine.machineId }, label = { Text(m.machine.name) }, modifier = Modifier.padding(end = 8.dp)) } }
            if (profile == null) Text("Профиль ещё не посчитан. Агент пришлёт его после обработки транскриптов.", Modifier.padding(vertical = 24.dp))
        }
        if (profile != null) {
            item { Section("Архетип") {
                Text(profile.objectValue("archetype")?.string("primary").orEmpty(), style = MaterialTheme.typography.headlineMedium)
                (profile.objectValue("archetype")?.get("badges") as? JsonArray)?.forEach { Text(it.jsonPrimitive.content) }
                Text("Обновлено: ${dateLabel(profile.number("generatedAt"))}", style = MaterialTheme.typography.bodyMedium)
            } }
            item { Section("Активность") {
                ValueRow("Сессий", profile.number("sessions")?.toInt()?.toString() ?: "—")
                ValueRow("Активных дней", profile.objectValue("span")?.number("activeDays")?.toInt()?.toString() ?: "—")
                ValueRow("Самая длинная серия", "${profile.objectValue("span")?.number("longestStreakDays")?.toInt() ?: 0} дней")
                ValueRow("Средняя сессия", "${profile.objectValue("cadence")?.number("avgSessionMinutes")?.toInt() ?: 0} мин")
            } }
            item { Section("Оценки") { listOf("steering" to "Управление", "execution" to "Исполнение", "engineering" to "Разработка", "planning" to "Планирование", "product" to "Продукт").forEach { (key, title) ->
                val value = profile.objectValue("scores")?.number(key) ?: 0.0
                ValueRow(title, "%.1f / 10".format(value)); LinearProgressIndicator(progress = { (value / 10).toFloat().coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
            }; Text("Продукт — косвенная оценка по работе с UI, стилями и документацией.", style = MaterialTheme.typography.bodyMedium) } }
            item { Section("Языки и навыки") {
                profile.objectValue("engineering")?.rows("topLanguages")?.forEach { ValueRow(it.string("name").orEmpty(), it.number("count")?.toInt()?.toString() ?: "—") }
                profile.objectValue("planning")?.rows("topSkills")?.forEach { ValueRow(it.string("name").orEmpty(), it.number("count")?.toInt()?.toString() ?: "—") }
            } }
            item { Text("Профиль рассчитан на вашей машине. Сервер получает только общую статистику.", Modifier.padding(vertical = 16.dp), style = MaterialTheme.typography.bodyMedium) }
        }
    }
}

@Composable private fun NewSessionDefaults(state: HubState, model: HubViewModel) {
    var source by rememberSaveable { mutableStateOf("claude") }
    var value by remember(source) { mutableStateOf(model.defaultOptions(source)) }
    var choices by remember(source) { mutableStateOf<List<ModelChoice>>(emptyList()) }
    val machine = state.machines.firstOrNull { it.online && (it.canControl || it.canStart) }
    LaunchedEffect(source, machine?.machine?.machineId) {
        if (machine != null) runCatching { model.rpc(machine.machine.machineId, "models.list", buildJsonObject { put("source", source) }) }
            // A default is for Codex and Claude: an OpenCode pick is remembered on its own side.
            .onSuccess { choices = wireJson.decodeFromJsonElement<List<ModelChoice>>(it["models"] ?: JsonArray(emptyList())).filterNot(OpenCode::isGo) }
    }
    fun change(next: RunOptions) { value = next; model.setDefaults(source, next) }
    Section("Для новых сессий") {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(source == "claude", { source = "claude" }, label = { Text("Claude") })
            FilterChip(source == "codex", { source = "codex" }, label = { Text("Codex") })
        }
        RadioRow("Модель из аккаунта", value.model == null) { change(value.copy(model = null)) }
        choices.filter { it.id != "default" }.forEach { choice -> RadioRow(choice.name ?: choice.id, value.model == choice.id) { change(value.copy(model = choice.id)) } }
        Text("Рассуждение", style = MaterialTheme.typography.titleMedium)
        RadioRow("Как в аккаунте", value.effort == null) { change(value.copy(effort = null)) }
        listOf("low" to "Низкое", "medium" to "Среднее", "high" to "Высокое", "xhigh" to "Очень высокое").forEach { (id, name) -> RadioRow(name, value.effort == id) { change(value.copy(effort = id)) } }
    }
}
