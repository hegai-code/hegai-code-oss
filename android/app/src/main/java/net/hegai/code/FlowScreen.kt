package net.hegai.code

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import net.hegai.code.core.*
import net.hegai.code.core.Target

val sessionStages = listOf("backlog" to "Бэклог", "planning" to "Планирование", "in_progress" to "В работе", "testing" to "Тестирование", "done" to "Готово")

@Composable fun FlowScreen(state: HubState, engine: HubEngine, navigated: () -> Unit = {}) {
    var change by remember { mutableStateOf<Pair<Machine, Session>?>(null) }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 20.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
        sessionStages.forEach { (stage, label) ->
            val rows = state.machines.flatMap { m -> m.sessions.filter { it.stage == stage }.map { m to it } }.sortedByDescending { it.second.lastModified }
            item { Text("$label · ${rows.size}", Modifier.padding(vertical = 16.dp), style = MaterialTheme.typography.titleMedium) }
            rows.forEach { (machine, session) -> item("${machine.machine.machineId}:${session.sessionId}") {
                ListItem(headlineContent = { Text(state.titleFor(machine.machine.machineId, session)) }, supportingContent = { Text("${session.project.orEmpty()} · ${machine.machine.name}") },
                    trailingContent = { if (state.canSetStage(machine, session)) TextButton({ change = machine to session }) { Text("Этап") } },
                    modifier = Modifier.clickable { engine.select(Target(machine.machine.machineId, session.cwd.orEmpty(), session.sessionId, session.title, session.source)); navigated() })
            } }
        }
        if (state.machines.none { m -> m.sessions.any { it.stage != null } }) item { Text("Назначьте этап в меню сессии — она появится на доске.") }
    }
    change?.let { (machine, session) -> StageDialog(session.stage, {
        engine.setStage(machine.machine.machineId, session.sessionId, it); change = null
    }) { change = null } }
}
@Composable fun StageDialog(stage: String?, select: (String?) -> Unit, dismiss: () -> Unit) {
    AlertDialog(onDismissRequest = dismiss, title = { Text("Этап сессии") }, text = {
        Column { sessionStages.forEach { (id, label) -> RadioRow(label, stage == id) { select(id) } }; RadioRow("Без этапа", stage == null) { select(null) } }
    }, confirmButton = { TextButton(dismiss) { Text("Закрыть") } })
}
