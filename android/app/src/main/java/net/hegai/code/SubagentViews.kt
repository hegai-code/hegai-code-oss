package net.hegai.code

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import net.hegai.code.core.*

/** A child talks in its own read-only transcript, never as the parent's answer. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable fun SubagentPanel(state: HubState, model: HubViewModel) {
    val target = state.target ?: return
    if (target.sessionId == null) return
    var expanded by remember(target.key) { mutableStateOf(false) }
    var selected by remember(target.key) { mutableStateOf<Subagent?>(null) }
    // Retained history still offers a transcript after the live run disappears.
    val history = remember(state.messages) { state.messages.flatMap { it.blocks }.filter {
        it.kind == "tool_use" && it.name in listOf("Agent", "Task", "spawn_agent") && it.id != null
    }.map { block ->
        val input = block.input as? JsonObject
        Subagent(block.id!!, input?.string("subagent_type") ?: input?.string("agent_type") ?: "Агент",
            input?.string("description") ?: input?.string("message")?.take(200) ?: "Помощник", "history", 0.0, toolUseId = block.id)
    } }
    val agents = state.subagents + history.filter { h -> state.subagents.none { it.toolUseId == h.toolUseId || it.id == h.id } }
    if (agents.isEmpty()) return
    val scope = rememberCoroutineScope()
    var stopping by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxWidth().padding(top = 12.dp)) {
        TextButton({ expanded = !expanded }) { Text("Помощники · ${agents.size}" + if (agents.any { it.status == "running" }) " · работают" else "") }
        if (expanded) agents.forEach { agent ->
            OutlinedCard(Modifier.fillMaxWidth().padding(vertical = 4.dp)) { Column(Modifier.padding(12.dp)) {
                Text(agent.description, style = MaterialTheme.typography.titleSmall)
                Text("${agent.kind} · " + when(agent.status) { "running" -> "работает"; "completed" -> "готово"; "failed" -> "ошибка"; "stopped" -> "остановлен"; else -> "из истории" }, style = MaterialTheme.typography.bodySmall)
                agent.lastAction?.let { Text(it, Modifier.padding(top = 8.dp), style = MaterialTheme.typography.bodyMedium) }
                (agent.steps.ifEmpty { agent.recent }).forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
                agent.summary?.let { Markdown(it) }
                Row {
                    TextButton({ selected = agent }) { Text("Открыть разговор") }
                    if (agent.status == "running") TextButton({ stopping = agent.id; scope.launch {
                        try { model.rpc(target.machineId, "run.stopSubagent", buildJsonObject { put("sessionId", target.sessionId); put("id", agent.id) }) }
                        catch (e: Exception) { error = e.message } finally { stopping = null }
                    } }, enabled = stopping == null && state.canSend) { Text("Остановить") }
                }
            } }
        }
        ErrorNote(error)
    }
    selected?.let { agent ->
        var lines by remember(agent.id) { mutableStateOf<List<ChatLine>?>(null) }
        var failure by remember(agent.id) { mutableStateOf<String?>(null) }
        var attempt by remember(agent.id) { mutableIntStateOf(0) }
        LaunchedEffect(agent.id, attempt) {
            try {
                val response = model.rpc(target.machineId, "session.subagent", buildJsonObject {
                    put("sessionId", target.sessionId); put("cwd", target.cwd); put("source", target.source); put("toolChars", 4000)
                    agent.toolUseId?.let { put("toolUseId", it) }; if (agent.status != "history") put("id", agent.id)
                })
                lines = historyLines(wireJson.decodeFromJsonElement<List<HistoryMessage>>(response["messages"] ?: JsonArray(emptyList()))); failure = null
            } catch (e: Exception) { failure = e.message }
        }
        ModalBottomSheet(onDismissRequest = { selected = null }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
            LazyColumn(Modifier.fillMaxWidth().padding(horizontal = 20.dp), contentPadding = PaddingValues(bottom = 32.dp)) {
                item { Text(agent.description, style = MaterialTheme.typography.titleLarge); TextButton({ attempt++ }) { Text("Обновить") }; ErrorNote(failure) }
                if (lines == null && failure == null) item { CircularProgressIndicator() }
                items(lines.orEmpty().withIndex().toList(), key = { it.index }) { (_, line) ->
                    Column(Modifier.padding(vertical = 8.dp)) {
                        Text(if (line.role == "user") "Задача" else if (line.role == "assistant") "Помощник" else "Действия", style = MaterialTheme.typography.labelSmall)
                        Markdown(line.text.ifBlank { line.details })
                    }
                }
            }
        }
    }
}
