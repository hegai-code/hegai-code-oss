package net.hegai.code

import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextPaint
import android.text.style.ClickableSpan
import android.text.style.ForegroundColorSpan
import android.text.style.TypefaceSpan
import android.view.View
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import net.hegai.code.core.*
import java.time.Instant
import java.time.ZoneId

/** The chat as ONE document (ios ChatView + TranscriptRows): prose stays open, machinery folds
 * into a «⚙ N» at the end of the exchange's last row, finished long answers fold into «Ход работы». */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable fun Transcript(state: HubState, modifier: Modifier, refresh: () -> Unit, model: HubViewModel?) {
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val messages = state.messages
    var clock by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(state.busy) { while (state.busy) { clock = System.currentTimeMillis(); delay(1000) } }
    // Day labels are relative («сегодня» becomes «вчера» at midnight) — recompute on a coarse tick.
    val day = clock / 3_600_000
    val items = remember(messages, state.busy, day) { groupTranscript(messages, state.busy, System.currentTimeMillis()) }
    var sheet by remember(state.target?.key) { mutableStateOf<List<Block>?>(null) }
    val source = state.target?.source ?: "claude"
    // Stick to the bottom while the reader is there — also when a row grows after layout (an image
    // arriving, a streamed paragraph). Scrolling up releases it; reaching the bottom again re-attaches.
    var stick by remember(state.target?.key) { mutableStateOf(true) }
    LaunchedEffect(list, state.target?.key) {
        // Only real scroll gestures decide: the flow's first value is the idle state before any layout.
        snapshotFlow { list.isScrollInProgress }.drop(1).collect { scrolling -> if (!scrolling) stick = !list.canScrollForward }
    }
    LaunchedEffect(list, state.target?.key) {
        snapshotFlow { list.layoutInfo.totalItemsCount to list.layoutInfo.visibleItemsInfo.lastOrNull()?.let { it.index to it.size } }
            .collect { if (stick && !list.isScrollInProgress && list.canScrollForward) list.scrollToItem((list.layoutInfo.totalItemsCount - 1).coerceAtLeast(0), Int.MAX_VALUE / 4) }
    }
    var window by remember(state.target?.key) { mutableIntStateOf(40) }
    val shownItems = items.takeLast(window)
    val atEnd by remember(list) { derivedStateOf { !list.canScrollForward } }
    // Pull down to re-read history (the old «Последние 1000 сообщений ⟳» row is gone); first load shows
    // the Expressive loading indicator in the middle instead of an empty page.
    PullToRefreshBox(state.loadingHistory && messages.isNotEmpty(), { if (!state.opening) refresh() }, modifier.fillMaxWidth()) {
        if (state.loadingHistory && messages.isEmpty()) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { LoadingIndicator(Modifier.size(56.dp)) }
        LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 16.dp)) {
            if (window < items.size) item("earlier") { TextButton({ window += 100 }) { Text("Показать более ранние · ${items.size - window}") } }
            items(shownItems, key = { it.id }) { item ->
                Box(Modifier.animateItem()) { when (item) {
                    is SpokenItem -> SpokenRow(item, state, model) { sheet = item.activity }
                    is FoldItem -> FoldRow(item, state, model) { sheet = it }
                    is ActivityItem -> Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.End) {
                        GearButton(item.activityCount) { sheet = item.activity }
                    }
                    is NoticeItem -> Text(item.text, Modifier.fillMaxWidth().padding(vertical = 8.dp), style = MaterialTheme.typography.labelSmall,
                        color = if (item.error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 6, overflow = TextOverflow.Ellipsis)
                    is DayItem -> Box(Modifier.fillMaxWidth().padding(top = 24.dp, bottom = 4.dp), contentAlignment = Alignment.Center) {
                        Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = MaterialTheme.shapes.extraLarge) {
                            Text(item.label, Modifier.padding(horizontal = 12.dp, vertical = 4.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                } }
            }
            if (model != null) item("subagents") { SubagentPanel(state, model) }
            if (state.busy || state.opening) item("working") {
                Column {
                Row(Modifier.animateItem().padding(top = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    LoadingIndicator(Modifier.size(32.dp))
                    Text(if (state.opening) "Открываем сессию…" else buildString {
                        append("Работает")
                        state.turnStartedAt?.let { val seconds = ((clock - it).coerceAtLeast(0) / 1000); append(" · %d:%02d".format(seconds / 60, seconds % 60)) }
                        state.turnTokens?.let { append(" · %,d ток.".format(it)) }
                    }, Modifier.padding(start = 8.dp), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                LinearWavyProgressIndicator(Modifier.fillMaxWidth().padding(top = 8.dp), color = BrandColors.action)
                }
            }
        }
        if (!atEnd && items.isNotEmpty()) SmallFloatingActionButton(
            { stick = true; scope.launch { list.animateScrollToItem(list.layoutInfo.totalItemsCount.coerceAtLeast(1) - 1) } },
            Modifier.align(Alignment.BottomEnd).padding(16.dp),
            containerColor = MaterialTheme.colorScheme.surfaceContainerHighest, contentColor = MaterialTheme.colorScheme.onSurface,
        ) { Icon(Icons.Outlined.KeyboardArrowDown, "Вниз") }
    }
    sheet?.let { blocks -> ActivitySheet(blocks, source) { sheet = null } }
}

@Composable private fun SpokenRow(item: SpokenItem, state: HubState, model: HubViewModel?, openActivity: () -> Unit) {
    val line = item.line
    val gear = item.activity.isNotEmpty()
    Column(Modifier.fillMaxWidth().padding(top = if (item.cont) 12.dp else 20.dp, bottom = 4.dp)) {
        if (line.role == "user") {
            // A person's turn is a plate on the right (ios HumanPlate): the side says who spoke.
            Row(Modifier.fillMaxWidth()) {
                Spacer(Modifier.widthIn(min = 48.dp).weight(1f, fill = false))
                // Chat bubble with a tucked corner toward the speaker (M3 messaging pattern).
                Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = androidx.compose.foundation.shape.RoundedCornerShape(24.dp, 24.dp, 6.dp, 24.dp)) {
                    Column(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), horizontalAlignment = Alignment.End) {
                        if (item.text.isNotBlank()) UserText(item.text, null, openActivity)
                        if (item.text.isNotBlank() && gear) GearButton(item.activityCount, openActivity)
                        HistoryImages(line, state, model)
                        if (item.text.isBlank() && gear) GearButton(item.activityCount, openActivity)
                        if (line.truncated) Text("Сообщение сокращено. Полный текст появится в истории.", style = MaterialTheme.typography.bodySmall)
                        line.files.forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
                        line.ts?.let { Text(hhmm(it), Modifier.padding(top = 2.dp), style = MaterialTheme.typography.labelSmall.copy(fontSize = 11.sp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                }
            }
        } else {
            if (item.text.isNotBlank()) Markdown(item.text, Modifier.fillMaxWidth())
            else if (line.streaming) Text("…", color = MaterialTheme.colorScheme.onSurfaceVariant)
            line.generation?.let { generation ->
                Text(when(generation.state) { "started" -> "Создаём изображение…"; "failed" -> generation.error ?: "Не удалось создать изображение"; else -> "Изображение готово" }, Modifier.padding(vertical = 8.dp), style = MaterialTheme.typography.labelLarge)
                if (generation.state == "started") LinearProgressIndicator(Modifier.fillMaxWidth())
                generation.prompt?.let { Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 3, overflow = TextOverflow.Ellipsis) }
            }
            HistoryImages(line, state, model)
            // Only a finished answer: the streaming tail would flicker a half-typed path.
            if (!line.streaming && item.text.isNotBlank()) FilePreviewStrip(item.text, state, model)
            if (gear) GearButton(item.activityCount, openActivity)
        }
    }
}

@Composable private fun HistoryImages(line: ChatLine, state: HubState, model: HubViewModel?) {
    line.images.forEach { ImagePreview(it, Modifier.padding(top = 8.dp).fillMaxWidth().heightIn(max = 300.dp)) }
    if (line.images.isEmpty() && model != null) line.imageRefs.forEach { ref -> HistoryImage(ref, state, model) }
}

/** Long human prompts (pasted context) collapse, like ios «Показать всё». */
@Composable private fun UserText(text: String, gear: Int?, openActivity: () -> Unit) {
    var expanded by rememberSaveable(text.hashCode()) { mutableStateOf(false) }
    val long = text.count { it == '\n' } >= 12 || text.length > 1200
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val annotated = buildAnnotatedString {
        append(text)
        if (gear != null) {
            append("  ")
            withLink(LinkAnnotation.Clickable("activity", TextLinkStyles(SpanStyle(color = muted, fontFamily = HegaiTokens.Mono))) { openActivity() }) {
                append("⚙ "); if (gear > 0) withStyle(SpanStyle(fontWeight = FontWeight.Medium)) { append(gear.toString()) }
            }
        }
    }
    Column(horizontalAlignment = Alignment.Start) {
        SelectionContainer { Text(annotated, style = MaterialTheme.typography.bodyLarge, maxLines = if (long && !expanded) 12 else Int.MAX_VALUE, overflow = TextOverflow.Ellipsis) }
        if (long) TextButton({ expanded = !expanded }, contentPadding = PaddingValues(0.dp)) { Text(if (expanded) "Свернуть" else "Показать всё") }
    }
}

/** The exchange's machinery as an assist chip under the answer («⚙ 3 действия»): a real touch target
 * with a label, where the inline «⚙ 3» was a 14sp glyph. Opens the «Действия» sheet. */
@Composable fun GearButton(count: Int, open: () -> Unit) {
    AssistChip(onClick = open, label = { Text(if (count > 0) actionCount(count) else "Действия") },
        leadingIcon = { Icon(Icons.Outlined.Settings, null, Modifier.size(AssistChipDefaults.IconSize)) },
        modifier = Modifier.padding(top = 6.dp).semantics { contentDescription = "Действия: ${actionCount(count)}" },
        colors = AssistChipDefaults.assistChipColors(containerColor = MaterialTheme.colorScheme.surfaceContainer, labelColor = MaterialTheme.colorScheme.onSurfaceVariant, leadingIconContentColor = MaterialTheme.colorScheme.onSurfaceVariant),
        border = null)
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable private fun FoldRow(item: FoldItem, state: HubState, model: HubViewModel?, openActivity: (List<Block>) -> Unit) {
    var expanded by rememberSaveable(item.id) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(top = 16.dp)) {
        FilledTonalButton({ expanded = !expanded }, shapes = ButtonDefaults.shapes(), contentPadding = PaddingValues(start = 12.dp, end = 16.dp),
            colors = ButtonDefaults.filledTonalButtonColors(containerColor = MaterialTheme.colorScheme.surfaceContainer, contentColor = MaterialTheme.colorScheme.onSurfaceVariant)) {
            Icon(if (expanded) Icons.Outlined.KeyboardArrowDown else Icons.Outlined.KeyboardArrowRight, null, Modifier.size(18.dp))
            Text("Ход работы · ${item.hidden.size}", Modifier.padding(start = 4.dp), style = MaterialTheme.typography.labelLarge)
        }
        if (expanded) item.hidden.forEach { hidden -> SpokenRow(hidden, state, model) { openActivity(hidden.activity) } }
    }
}

private fun hhmm(ms: Long): String = Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()).let { "%02d:%02d".format(it.hour, it.minute) }

// ---- «Действия» sheet (ios TranscriptRows activity sheet + ToolViews)

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun ActivitySheet(blocks: List<Block>, source: String, dismiss: () -> Unit) {
    val calls = blocks.count { it.kind == "tool_use" }
    ModalBottomSheet(onDismissRequest = dismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        LazyColumn(Modifier.fillMaxWidth().padding(horizontal = 20.dp), contentPadding = PaddingValues(bottom = 32.dp)) {
            item {
                Text("Действия", style = MaterialTheme.typography.titleLarge)
                Text(actionCount(calls), Modifier.padding(top = 4.dp, bottom = 12.dp), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            items(blocks.size) { index -> BlockRow(blocks[index], source) }
        }
    }
}

@Composable private fun BlockRow(block: Block, source: String) {
    when (block.kind) {
        "tool_use" -> ToolUseRow(block)
        "thinking" -> Collapsible(label = { Text("размышление", fontStyle = FontStyle.Italic, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }) {
            Text(block.text.orEmpty().take(4000), style = MaterialTheme.typography.bodyMedium, fontStyle = FontStyle.Italic)
        }
        "tool_result" -> Collapsible(label = {
            Text(if (block.isError == true) "ошибка инструмента" else "результат", style = MaterialTheme.typography.bodyMedium,
                color = if (block.isError == true) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
        }) { CodeText(block.text.orEmpty().take(4000)) }
        else -> {
            val text = block.text.orEmpty()
            val lines = text.count { it == '\n' } + 1
            Collapsible(label = { Text(if (lines > 1) "вывод · ${lineCount(lines)}" else text, style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis) }) { CodeText(text.take(8000)) }
        }
    }
}

private fun lineCount(n: Int) = "$n " + when { n % 100 in 11..14 -> "строк"; n % 10 == 1 -> "строка"; n % 10 in 2..4 -> "строки"; else -> "строк" }

@Composable private fun ToolUseRow(block: Block) {
    val name = block.name ?: "tool"
    val input = block.input
    val obj = input as? JsonObject
    fun field(key: String) = (obj?.get(key) as? JsonPrimitive)?.contentOrNull
    fun commandField(): String? = (obj?.get("cmd") ?: obj?.get("command"))?.let { value ->
        (value as? JsonPrimitive)?.contentOrNull ?: (value as? JsonArray)?.joinToString(" ") { (it as? JsonPrimitive)?.contentOrNull.orEmpty() }
    }
    // Codex: a live line arrives as "$ cmd"; history names the call exec_command / shell with the command inside.
    val command = when (name) {
        "$" -> (input as? JsonPrimitive)?.contentOrNull ?: commandField()
        "exec_command", "shell", "local_shell", "container.exec" -> commandField()
        else -> null
    }
    // `mcp__hegai__plan` takes TodoWrite's input; a reader sees «План», not the MCP name.
    val isPlan = name == "TodoWrite" || name == "mcp__hegai__plan"
    val title = if (name == "mcp__hegai__plan") "План" else name
    val subtitle = field("file_path") ?: field("description") ?: field("pattern") ?: field("query") ?: field("url") ?: ""
    Collapsible(startExpanded = isPlan, icon = { ToolSquare(title, toneOf = name) }, label = {
        Text(command?.let { "$ $it" } ?: if (subtitle.isEmpty()) title else "$title · $subtitle", style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }) {
        val todos = obj?.get("todos") as? JsonArray
        when {
            command != null -> CodeText(command)
            isPlan && todos != null -> Column {
                todos.forEach { todo ->
                    val t = todo as? JsonObject ?: return@forEach
                    val status = (t["status"] as? JsonPrimitive)?.contentOrNull
                    Text("${when (status) { "completed" -> "✓"; "in_progress" -> "▸"; else -> "○" }} ${(t["content"] as? JsonPrimitive)?.contentOrNull.orEmpty()}",
                        style = MaterialTheme.typography.bodyMedium, color = if (status == "completed") MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface)
                }
            }
            name == "Edit" && field("old_string") != null -> Diff(field("old_string").orEmpty(), field("new_string").orEmpty())
            (name == "Write" || name == "NotebookEdit") && field("content") != null -> CodeText(field("content").orEmpty().take(8000))
            name == "Bash" && field("command") != null -> CodeText(field("command").orEmpty())
            else -> CodeText(input?.let { prettyJson.encodeToString(JsonElement.serializer(), it) }.orEmpty().take(8000))
        }
    }
}
private val prettyJson = Json { prettyPrint = true }

/** `toneOf` is the tool's real name when the label is a display title («План»). */
@Composable private fun ToolSquare(name: String, toneOf: String = name) {
    val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f
    val (fill, ink) = when (if (toneOf == "$") ToolEffect.ACT else toolEffect(toneOf)) {
        ToolEffect.READ -> HegaiTokens.Green to HegaiTokens.Ivory
        ToolEffect.ACT -> HegaiTokens.attn(dark) to HegaiTokens.Ink
        ToolEffect.OTHER -> MaterialTheme.colorScheme.onSurfaceVariant to MaterialTheme.colorScheme.surface
    }
    Box(Modifier.size(18.dp).background(fill, HegaiTokens.Square), contentAlignment = Alignment.Center) {
        Text(name.trimStart('$').take(1).ifEmpty { "$" }.uppercase(), color = ink, fontSize = 11.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable private fun Collapsible(startExpanded: Boolean = false, icon: (@Composable () -> Unit)? = null, label: @Composable () -> Unit, content: @Composable () -> Unit) {
    var expanded by remember { mutableStateOf(startExpanded) }
    Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        Row(Modifier.fillMaxWidth().clickable { expanded = !expanded }.heightIn(min = 40.dp), verticalAlignment = Alignment.CenterVertically) {
            icon?.let { it(); Spacer(Modifier.width(10.dp)) }
            Box(Modifier.weight(1f)) { label() }
            Icon(if (expanded) Icons.Outlined.KeyboardArrowDown else Icons.Outlined.KeyboardArrowRight, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (expanded) Box(Modifier.padding(start = if (icon != null) 28.dp else 0.dp, bottom = 8.dp)) { content() }
    }
}

@Composable private fun CodeText(text: String) {
    Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = MaterialTheme.shapes.medium) {
        SelectionContainer {
            Text(text, Modifier.horizontalScroll(rememberScrollState()).padding(10.dp), fontFamily = HegaiTokens.Mono, fontSize = 12.sp, lineHeight = 17.sp)
        }
    }
}

@Composable private fun Diff(old: String, new: String) {
    val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f
    val removed = HegaiTokens.red(dark).copy(alpha = 0.14f)
    val added = HegaiTokens.Green.copy(alpha = if (dark) 0.35f else 0.12f)
    Column(Modifier.horizontalScroll(rememberScrollState())) {
        old.take(4000).lines().forEach { Text("- $it", Modifier.background(removed).padding(horizontal = 8.dp), fontFamily = HegaiTokens.Mono, fontSize = 12.sp) }
        new.take(4000).lines().forEach { Text("+ $it", Modifier.background(added).padding(horizontal = 8.dp), fontFamily = HegaiTokens.Mono, fontSize = 12.sp) }
    }
}

/** Appends the gear link to rendered Markdown: on the last line after prose, on its own line after code. */
fun appendGear(source: String, rendered: Spanned, count: Int, color: Int, open: () -> Unit): Spanned {
    val out = SpannableStringBuilder(rendered)
    val trimmed = out.trimEnd()
    out.delete(trimmed.length, out.length)
    // After a code block or a table the gear starts its own line: inline it would sit on their background.
    val lastLine = source.trimEnd().substringAfterLast('\n')
    val block = lastLine.trimStart().let { it.startsWith("```") || it.startsWith("~~~") || it.startsWith("|") } || lastLine.startsWith("    ")
    out.append(if (block) "\n" else "\u00A0\u00A0")
    val start = out.length
    out.append(if (count > 0) "⚙ $count" else "⚙")
    out.setSpan(object : ClickableSpan() {
        override fun onClick(widget: View) = open()
        override fun updateDrawState(ds: TextPaint) { ds.color = color; ds.isUnderlineText = false }
    }, start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    out.setSpan(ForegroundColorSpan(color), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    out.setSpan(TypefaceSpan("monospace"), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    return out
}
