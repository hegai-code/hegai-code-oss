package net.hegai.code

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import net.hegai.code.core.*
import net.hegai.code.core.Target

@Composable fun InboxScreen(state: HubState, engine: HubEngine, open: (Target) -> Unit) {
    LaunchedEffect(Unit) { engine.markNoticesRead() }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 20.dp)) {
        if (state.notices.isEmpty()) item { Text("Пока тихо. Здесь появятся завершения, ошибки и вопросы ваших сессий.", Modifier.padding(vertical = 24.dp)) }
        else item { TextButton(engine::clearNotices) { Text("Очистить") } }
        items(state.notices, key = { it.id }) { notice ->
            val run = notice.run
            val session = state.machines.firstOrNull { it.machine.machineId == run.machineId }?.sessions?.firstOrNull { it.sessionId == run.sessionId }
            val status = when (run.state) {
                "needs_attention" -> when (run.pendingKind) { "question" -> "Ждёт ответа"; "permission" -> "Ждёт подтверждения"; else -> "Ждёт решения" }
                "error" -> "Завершилась ошибкой"
                else -> "Работа завершена"
            }
            ListItem(headlineContent = { Text(session?.title?.let(::shown) ?: run.title ?: run.sessionId.take(8)) },
                supportingContent = { Text("$status · ${run.machineName.orEmpty()}\n${dateLabel(notice.at.toDouble())}") },
                modifier = Modifier.clickable(enabled = session != null) {
                    session?.let { open(Target(run.machineId, it.cwd.orEmpty(), it.sessionId, it.title, it.source)) }
                })
        }
    }
}
