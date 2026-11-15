package net.hegai.code

import android.net.Uri
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import net.hegai.code.core.*

fun segment(value: String) = Uri.encode(value)
fun roleLabel(value: String?) = when(value) { "owner" -> "Владелец"; "manager" -> "Менеджер"; else -> "Участник" }

@Composable fun TeamScreen(state: HubState, model: HubViewModel) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    val workspace = state.viewer?.workspace ?: return
    val base = "/api/workspaces/${segment(workspace.workspaceId)}"
    var members by remember(workspace.workspaceId) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var projects by remember(workspace.workspaceId) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var events by remember(workspace.workspaceId) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }
    var invitation by remember { mutableStateOf<JsonObject?>(null) }
    var email by rememberSaveable { mutableStateOf("") }
    var inviteRole by rememberSaveable { mutableStateOf("member") }
    var publish by remember { mutableStateOf(false) }
    var member by remember { mutableStateOf<JsonObject?>(null) }
    var remove by remember { mutableStateOf<JsonObject?>(null) }
    var invitationToken by rememberSaveable { mutableStateOf("") }
    var adminName by rememberSaveable { mutableStateOf("") }
    var assignmentTarget by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val owner = workspace.role == "owner"
    suspend fun reload() {
        loading = true
        try { when(tab) {
            1 -> members = model.api("$base/members").rows("members")
            2 -> projects = model.api("$base/projects").rows("projects")
            3 -> events = model.api("$base/audit").rows("events")
        }; error = null } catch(e: Exception) { error = e.message } finally { loading = false }
    }
    LaunchedEffect(tab, workspace.workspaceId) { reload() }
    Column(Modifier.fillMaxSize()) {
        ScrollableTabRow(tab, edgePadding = 12.dp) { listOf("Обзор", "Люди", "Проекты", "Аудит").forEachIndexed { i, name -> Tab(tab == i, { tab = i }, text = { Text(name) }) } }
        LazyColumn(Modifier.fillMaxSize().padding(horizontal = 20.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
            item { ErrorNote(error); if (loading) LinearProgressIndicator(Modifier.fillMaxWidth()) }
            when(tab) {
                0 -> {
                    item { Section(workspace.name) {
                        ValueRow("Ваша роль", roleLabel(workspace.role))
                        ValueRow("Подключённых машин", state.machines.count { it.online }.toString())
                        ValueRow("Активных сессий", state.runs.count { it.state == "working" }.toString())
                    } }
                    items(state.machines) { machine -> Section(machine.machine.name) {
                        Text(if (machine.online) "В сети" else "Не в сети")
                        machine.sessions.take(5).forEach { session -> Text(shown(session.title), style = MaterialTheme.typography.bodyMedium) }
                    } }
                    item { Section("Принять приглашение") {
                        OutlinedTextField(invitationToken, { invitationToken = it }, label = { Text("Код приглашения") }, modifier = Modifier.fillMaxWidth())
                        Button({ scope.launch { runCatching {
                            model.api("/api/invitations/accept", "POST", buildJsonObject { put("token", invitationToken.trim()) })
                        }.onSuccess { invitationToken = ""; model.retry() }.onFailure { error = it.message } } }, enabled = invitationToken.isNotBlank()) { Text("Присоединиться") }
                    } }
                    if (state.viewer?.platformAdmin == true) item { Section("Создать рабочее пространство") {
                        OutlinedTextField(adminName, { adminName = it }, label = { Text("Название") }, modifier = Modifier.fillMaxWidth())
                        Button({ scope.launch { runCatching { model.api("/api/admin/workspaces", "POST", buildJsonObject { put("name", adminName.trim()) }) }.onSuccess { adminName = ""; model.retry() }.onFailure { error = it.message } } }, enabled = adminName.isNotBlank()) { Text("Создать") }
                    } }
                }
                1 -> {
                    if (owner) item { Section("Пригласить участника") {
                        OutlinedTextField(email, { email = it }, label = { Text("Email") }, modifier = Modifier.fillMaxWidth())
                        listOf("member", "manager").filter { !workspace.selfServe || it == "member" }.forEach { value -> RadioRow(roleLabel(value), inviteRole == value) { inviteRole = value } }
                        Button({ scope.launch { runCatching {
                            model.api("$base/invitations", "POST", buildJsonObject { put("email", email.trim()); put("role", inviteRole) })
                        }.onSuccess { invitation = it; email = "" }.onFailure { error = it.message } } }, enabled = email.contains('@')) { Text("Создать приглашение") }
                        invitation?.let { value -> SelectionContainer { Text(value.string("url") ?: value.string("token") ?: "Приглашение создано") } }
                    } }
                    items(members) { person -> ListItem(headlineContent = { Text(personName(person)) }, supportingContent = { Text(listOfNotNull(person.string("email"), roleLabel(person.string("role"))).joinToString(" · ")) }, modifier = Modifier.clickable(enabled = owner && person.string("role") != "owner") { member = person }) }
                }
                2 -> {
                    if (owner) item { Button({ publish = true }, Modifier.padding(vertical = 16.dp)) { Text("Открыть доступ к проекту") } }
                    items(projects) { project -> Section(project.string("name") ?: "Проект") {
                        Text(project.string("root").orEmpty(), fontFamily = HegaiTokens.Mono, style = MaterialTheme.typography.bodyMedium)
                        ValueRow("Доступ", if (project.string("access") == "control") "Можно работать" else "Просмотр")
                        if (owner) TextButton({ remove = project }) { Text("Закрыть доступ") }
                    } }
                }
                3 -> items(events) { event -> ListItem(headlineContent = { Text(event.string("action").orEmpty()) }, supportingContent = { Text("${event.string("actorName") ?: event.string("actorUserId")} · ${dateLabel(event.number("createdAt"))}\n${event.string("targetId").orEmpty()}") }) }
            }
            if (tab > 0) item { TextButton({ scope.launch { reload() } }) { Text("Обновить") } }
        }
    }
    member?.let { person -> AlertDialog(onDismissRequest = { member = null }, title = { Text(personName(person)) },
        text = { Column(Modifier.verticalScroll(rememberScrollState())) {
            listOf("member", "manager").filter { !workspace.selfServe || it != "manager" }.forEach { role ->
                RadioRow(roleLabel(role), person.string("role") == role) { scope.launch {
                    runCatching { model.api("$base/members/${segment(person.string("userId").orEmpty())}", "PATCH", buildJsonObject { put("role", role) }) }
                        .onSuccess { member = null; reload() }.onFailure { error = it.message }
                } }
            }
            if (!workspace.selfServe && person.string("role") == "manager") {
                Text("Назначить участника менеджеру")
                members.filter { it.string("role") == "member" }.forEach { target -> RadioRow(personName(target), assignmentTarget == target.string("userId")) { assignmentTarget = target.string("userId").orEmpty() } }
                TextButton({ scope.launch { runCatching {
                    model.api("$base/assignments", "POST", buildJsonObject { put("managerUserId", person.string("userId")); put("targetKind", "member"); put("targetId", assignmentTarget) })
                }.onSuccess { member = null }.onFailure { error = it.message } } }, enabled = assignmentTarget.isNotBlank()) { Text("Назначить") }
            }
        } }, confirmButton = { TextButton({ member = null }) { Text("Закрыть") } }) }
    if (publish) ShareProject(state, model, base, { publish = false }) { scope.launch { reload() } }
    remove?.let { project -> AlertDialog(onDismissRequest = { remove = null }, title = { Text("Закрыть доступ к проекту?") }, text = { Text("Файлы проекта сохранятся на машине владельца.") },
        confirmButton = { TextButton({ remove = null; scope.launch { runCatching { model.api("$base/projects/${segment(project.string("projectShareId").orEmpty())}", "DELETE"); reload() }.onFailure { error = it.message } } }) { Text("Закрыть доступ") } },
        dismissButton = { TextButton({ remove = null }) { Text("Отмена") } }) }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun ShareProject(state: HubState, model: HubViewModel, base: String, dismiss: () -> Unit, changed: () -> Unit) {
    var machineId by rememberSaveable { mutableStateOf("") }
    var root by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("") }
    var access by rememberSaveable { mutableStateOf("view") }
    var error by remember { mutableStateOf<String?>(null) }
    var roots by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(machineId) { roots = emptyList(); if (machineId.isNotEmpty()) runCatching { model.rpc(machineId, "projects.list").rows("projects") }.onSuccess { roots = it } }
    ModalBottomSheet(onDismissRequest = dismiss) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp)) {
            Text("Открыть доступ к проекту", style = MaterialTheme.typography.titleLarge)
            state.machines.filter { it.canControl }.forEach { m -> RadioRow(m.machine.name, machineId == m.machine.machineId) { machineId = m.machine.machineId; root = "" } }
            roots.forEach { project -> RadioRow(project.string("label") ?: project.string("cwd").orEmpty(), root == project.string("cwd")) { root = project.string("cwd").orEmpty(); name = project.string("label") ?: root.substringAfterLast('/') } }
            OutlinedTextField(root, { root = it }, label = { Text("Папка проекта") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(name, { name = it }, label = { Text("Название") }, modifier = Modifier.fillMaxWidth())
            RadioRow("Только просмотр", access == "view") { access = "view" }; RadioRow("Можно работать", access == "control") { access = "control" }
            ErrorNote(error)
            Button({ scope.launch { saving = true; runCatching {
                model.api("$base/projects", "POST", buildJsonObject { put("machineId", machineId); put("root", root); put("name", name.trim()); put("access", access) })
            }.onSuccess { changed(); dismiss() }.onFailure { error = it.message }; saving = false } }, enabled = machineId.isNotBlank() && root.isNotBlank() && name.isNotBlank() && !saving) { Text("Открыть доступ") }
        }
    }
}
