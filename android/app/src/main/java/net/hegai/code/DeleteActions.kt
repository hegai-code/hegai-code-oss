package net.hegai.code

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import net.hegai.code.core.*

/** What a list row can ask for. Provided by [DeleteHost]; null where there is no hub model (previews, tests). */
class DeleteActions(
    val deleteSession: (machineId: String, session: Session) -> Unit,
    val removeProject: (machineId: String, cwd: String, label: String, machineName: String) -> Unit,
)

val LocalDeleteActions = compositionLocalOf<DeleteActions?> { null }
/** Per machine, the folders `projects.list` marks `origin: "root"` (the only removable ones). */
val LocalRemovableProjects = compositionLocalOf<Map<String, Set<String>>> { emptyMap() }

private data class SessionAsk(val machineId: String, val session: Session)
private data class ProjectAsk(val machineId: String, val cwd: String, val label: String, val machineName: String)

/** The agent's `projects.remove` refusals, in the person's language (web StartScreen `describeRemoveError`). */
fun describeRemoveError(message: String?): String = when {
    message == null -> "Не удалось убрать проект"
    Regex("session is live", RegexOption.IGNORE_CASE).containsMatchIn(message) -> "В проекте идёт сессия — закройте её, потом убирайте."
    Regex("projects root", RegexOption.IGNORE_CASE).containsMatchIn(message) -> "Убрать можно только проект из папки проектов на машине."
    Regex("not found", RegexOption.IGNORE_CASE).containsMatchIn(message) -> "Папки уже нет на машине."
    else -> message
}

/** Confirmation dialogs for «Удалить» (session) and «Удалить с машины» (project), wording as on the web. */
@Composable fun DeleteHost(model: HubViewModel?, content: @Composable () -> Unit) {
    var session by remember { mutableStateOf<SessionAsk?>(null) }
    var project by remember { mutableStateOf<ProjectAsk?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val actions = remember(model) {
        if (model == null) null else DeleteActions({ m, s -> session = SessionAsk(m, s) }, { m, c, l, n -> project = ProjectAsk(m, c, l, n) })
    }
    val removable = model?.removableProjects?.collectAsStateWithLifecycle()?.value.orEmpty()
    CompositionLocalProvider(LocalDeleteActions provides actions, LocalRemovableProjects provides removable) { content() }
    session?.let { ask ->
        AlertDialog(onDismissRequest = { if (!busy) session = null }, title = { Text("Удалить запись этой сессии?") },
            confirmButton = { TextButton({
                scope.launch {
                    busy = true
                    try { model?.deleteSession(ask.machineId, ask.session.sessionId, ask.session.cwd.orEmpty(), ask.session.source); session = null }
                    catch (e: kotlinx.coroutines.CancellationException) { throw e }
                    catch (e: Exception) { session = null; failure = "Не удалось удалить: ${e.message ?: "ошибка"}" }
                    finally { busy = false }
                }
            }, enabled = !busy) { Text("Удалить", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton({ session = null }, enabled = !busy) { Text("Отмена") } })
    }
    project?.let { ask ->
        AlertDialog(onDismissRequest = { if (!busy) project = null }, title = { Text("Убрать «${ask.label}» с машины ${ask.machineName}?") },
            text = { Text("Папка переедет в корзину агента (~/.cc-remote/trash) — ничего не удаляется насовсем.") },
            confirmButton = { TextButton({
                scope.launch {
                    busy = true
                    try { model?.removeProject(ask.machineId, ask.cwd); project = null }
                    catch (e: kotlinx.coroutines.CancellationException) { throw e }
                    catch (e: Exception) { project = null; failure = describeRemoveError(e.message) }
                    finally { busy = false }
                }
            }, enabled = !busy) { Text("Убрать", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton({ project = null }, enabled = !busy) { Text("Отмена") } })
    }
    failure?.let { text -> AlertDialog(onDismissRequest = { failure = null }, text = { Text(text) }, confirmButton = { TextButton({ failure = null }) { Text("Понятно") } }) }
}

/** A three-dots button with one danger item; draws nothing when [label] has no action behind it. */
@Composable fun DangerMenu(description: String, label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box(modifier) {
        IconButton({ open = true }, Modifier.size(48.dp)) { Icon(Icons.Outlined.MoreVert, description) }
        DropdownMenu(open, { open = false }) {
            DropdownMenuItem(text = { Text(label, color = MaterialTheme.colorScheme.error) }, onClick = { open = false; onClick() })
        }
    }
}

/** A session may be deleted where the web allows it ([canDeleteSession]). */
@Composable fun SessionDeleteMenu(state: HubState, machine: Machine, session: Session, modifier: Modifier = Modifier) {
    val actions = LocalDeleteActions.current ?: return
    if (!state.canDeleteSession(machine, session)) return
    DangerMenu("Действия: ${session.title.ifBlank { "сессия" }}", "Удалить", modifier) { actions.deleteSession(machine.machine.machineId, session) }
}

/** «Удалить с машины»: only the machine's owner, online, with no live session in the project and `origin: root` in `projects.list` (web StartScreen). */
@Composable fun ProjectRemoveMenu(state: HubState, machine: Machine, cwd: String, label: String, sessions: List<Session>, modifier: Modifier = Modifier) {
    val actions = LocalDeleteActions.current ?: return
    val win = machine.machine.os.let { it == "windows" || it == "win32" }
    if (!machine.canControl || !machine.online || cwd.isBlank() || !isRemovableProject(LocalRemovableProjects.current[machine.machine.machineId], cwd, win) ||
        sessions.any { state.sessionHeld(machine.machine.machineId, it) }) return
    DangerMenu("Действия: $label", "Удалить с машины", modifier) { actions.removeProject(machine.machine.machineId, cwd, label, machine.machine.name) }
}
