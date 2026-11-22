package net.hegai.code

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import net.hegai.code.core.*
import net.hegai.code.core.Target

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun AdvancedProjectPicker(state: HubState, model: HubViewModel, dismiss: () -> Unit, onHandPick: (machineId: String) -> Unit = {}, select: (Target) -> Unit) {
    // null = nobody chose: the runtime follows each machine (Claude unless it cannot start there and Codex can).
    var picked by rememberSaveable { mutableStateOf<String?>(null) }
    val source = picked ?: "claude"
    var query by rememberSaveable { mutableStateOf("") }
    var create by remember { mutableStateOf(false) }
    // Machines whose Codex model list carries `pool-go/` rows: OpenCode is offered only where it can run.
    var goMachines by remember { mutableStateOf(setOf<String>()) }
    val catalog by model.projectCatalog.collectAsStateWithLifecycle()
    val shared by model.sharedProjects.collectAsStateWithLifecycle()
    val member = state.viewer?.workspace?.role == "member"
    val projects = state.machines.filter { it.canControl || it.canStart }.flatMap { machine ->
        val id = machine.machine.machineId
        mergeProjectPaths(machine.sessions.mapNotNull { it.cwd }, catalog[id].orEmpty(), shared.filter { it.machineId == id }.map { it.root }, ignoreCase = machine.machine.os.let { it == "windows" || it == "win32" }).map { machine to it }
    }
    LaunchedEffect(state.connection, state.viewer?.workspace?.workspaceId) { model.refreshSharedProjects() }
    // Every startable machine, not only those with a project: the first project can be created here.
    val goCandidates = state.machines.filter { it.online && (it.canControl || it.canStart) }.map { it.machine.machineId }
    LaunchedEffect(state.connection, goCandidates) {
        goCandidates.forEach { id ->
            val rows = if (state.connection == Connection.READY) runCatching { model.models(id, "codex") }.getOrDefault(model.cachedModels(id, "codex")) else model.cachedModels(id, "codex")
            if (OpenCode.available(rows)) goMachines = goMachines + id
        }
    }
    val choice = if (source == OpenCode.AGENT && goMachines.isEmpty()) "codex" else source
    fun runtimeOf(machine: String) = if (picked == null) Runtimes.pick(state.machines.firstOrNull { it.machine.machineId == machine }?.runtimes, "claude") else choice
    fun start(machine: String, cwd: String) = if (member) Target(machine, cwd, source = "codex")
        else Target(machine, cwd, source = if (choice == OpenCode.AGENT) "codex" else runtimeOf(machine), agent = if (choice == OpenCode.AGENT && machine in goMachines) OpenCode.AGENT else null)
    // A person's own pick is remembered by the caller (so the follow-the-logins effect leaves it alone); the automatic one is not.
    fun go(machine: String, cwd: String) { if (picked != null) onHandPick(machine); select(start(machine, cwd)) }
    // What the chips show is what will run: with no pick it is the runtime every listed machine resolves to (none lit when they differ).
    val shownChoice: String? = if (picked != null) choice else projects.filter { it.first.online }.map { runtimeOf(it.first.machine.machineId) }.distinct().let { if (it.isEmpty()) "claude" else it.singleOrNull() }
    LaunchedEffect(state.connection, state.machines.filter { it.online && it.canControl }.map { it.machine.machineId }) { model.refreshProjects() }
    ModalBottomSheet(onDismissRequest = dismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp)) {
            Text("Проекты", style = MaterialTheme.typography.titleLarge)
            // Own row under the heading: whose projects these are, and the way to another team's.
            WorkspaceSwitcher(state, model, Modifier.offset(x = (-12).dp))
            if (!member) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(shownChoice == "claude", { picked = "claude" }, label = { Text("Claude") })
                FilterChip(shownChoice == "codex", { picked = "codex" }, label = { Text("Codex") })
                if (goMachines.isNotEmpty()) FilterChip(shownChoice == OpenCode.AGENT, { picked = OpenCode.AGENT }, label = { Text("OpenCode") })
            }
            OutlinedTextField(query, { query = it }, label = { Text("Найти проект") }, modifier = Modifier.fillMaxWidth())
            LazyColumn(Modifier.weight(1f, fill = false), contentPadding = PaddingValues(bottom = 24.dp)) {
                items(projects.filter { "${it.second} ${it.first.machine.name}".contains(query, true) }) { (machine, cwd) ->
                    val chosen = state.target?.machineId == machine.machine.machineId && state.target?.cwd == cwd
                    ListItem(headlineContent = { Text(shared.firstOrNull { it.machineId == machine.machine.machineId && it.root == cwd }?.name ?: Target(machine.machine.machineId, cwd).project) }, supportingContent = {
                        Column {
                            Text("${machine.machine.name}${if (machine.online) "" else " · офлайн"} · $cwd", maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.MiddleEllipsis)
                            // Visible, not silent: the picked agent cannot start on this machine (or both cannot, and the preference stands).
                            if (!member && choice != OpenCode.AGENT) Runtimes.problem(machine.runtimes, runtimeOf(machine.machine.machineId))?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
                            if (!member && picked == null && runtimeOf(machine.machine.machineId) != "claude") Text("Claude здесь недоступен — запустится Codex.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    },
                        trailingContent = {
                            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                                if (chosen) Icon(Icons.Outlined.Check, "Выбран")
                                ProjectRemoveMenu(state, machine, cwd, Target(machine.machine.machineId, cwd).project, machine.sessions.filter { cwdInside(it.cwd, cwd, machine.machine.os.let { it == "windows" || it == "win32" }) })
                            }
                        },
                        modifier = Modifier.clickable(enabled = machine.online && (choice != OpenCode.AGENT || machine.machine.machineId in goMachines)) { go(machine.machine.machineId, cwd) })
                }
                item { TextButton({ create = true }, enabled = state.machines.any { it.online && it.canControl }) { Text("Создать проект") } }
                if (projects.isEmpty()) item { Text("Выберите подключённую машину и создайте первый проект.", Modifier.padding(vertical = 16.dp)) }
            }
        }
    }
    if (create) CreateProject(state, model, if (choice == OpenCode.AGENT) goMachines else null, { create = false }) { machine, cwd -> go(machine, cwd); create = false }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun CreateProject(state: HubState, model: HubViewModel, onlyMachines: Set<String>?, dismiss: () -> Unit, created: (String, String) -> Unit) {
    var machineId by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("") }
    var repository by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    ModalBottomSheet(onDismissRequest = dismiss) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp)) {
            Text("Создать проект", style = MaterialTheme.typography.titleLarge)
            state.machines.filter { it.online && it.canControl && (onlyMachines == null || it.machine.machineId in onlyMachines) }.forEach { machine -> RadioRow(machine.machine.name, machineId == machine.machine.machineId) { machineId = machine.machine.machineId } }
            OutlinedTextField(name, { name = it.lowercase().take(64) }, label = { Text("Имя папки") }, supportingText = { Text("Латинские буквы, цифры, дефис и подчёркивание") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(repository, { repository = it }, label = { Text("Git HTTPS URL · необязательно") }, modifier = Modifier.fillMaxWidth())
            ErrorNote(error)
            Button({ scope.launch {
                busy = true
                runCatching { model.rpc(machineId, "projects.create", buildJsonObject {
                    put("name", name); if (repository.isNotBlank()) put("gitUrl", repository.trim()) else put("template", "empty")
                }) }.onSuccess { result ->
                    val cwd = result.string("cwd") ?: result.objectValue("project")?.string("cwd")
                    if (cwd == null) error = "Проект создан, но путь не получен. Обновите список проектов." else created(machineId, cwd)
                }.onFailure { error = it.message }; busy = false
            } }, enabled = !busy && machineId.isNotBlank() && name.matches(Regex("[a-z0-9][a-z0-9._-]{0,63}")) && (repository.isBlank() || repository.startsWith("https://"))) { Text(if (busy) "Создаём…" else "Создать") }
        }
    }
}
