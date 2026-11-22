package net.hegai.code

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import net.hegai.code.core.*
import java.io.File

/** Current generation, most to least capable — `DEFAULT_MODELS` in shared/src/rpc.ts. The live CLI
 * reports every model it still accepts; the older ones stay one tap away under «Все модели». */
val CURRENT_CLAUDE_MODELS = listOf("claude-fable-5-1" to "Fable 5.1", "claude-opus-5-5" to "Opus 5.5", "claude-sonnet-5-5" to "Sonnet 5.5")
/** «OpenCode» for a Codex-wire chat that runs a `pool-go/` model (or starts as one), else Codex / Claude. */
fun agentName(state: HubState): String = when {
    state.target?.source != "codex" -> "Claude"
    OpenCode.isOpenCodeChat(state.target, state.runSettings?.string("activeModel"), state.options.model) -> "OpenCode"
    else -> "Codex"
}
private fun sameModel(a: String?, b: String?) = a != null && b != null && (a == b || a.substringBefore('[') == b.substringBefore('['))
/** The model a run reports, by its display name when the list knows it. */
fun modelLabel(id: String?, models: List<ModelChoice>): String? = id?.let { value ->
    models.firstOrNull { sameModel(it.id, value) || sameModel(it.resolved, value) }?.name
        ?: CURRENT_CLAUDE_MODELS.firstOrNull { sameModel(it.first, value) }?.second ?: value
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable fun RunSettings(state: HubState, model: HubViewModel?, engine: HubEngine, dismiss: () -> Unit) {
    val target = state.target
    var models by remember(target?.machineId, target?.source) { mutableStateOf(if (model != null && target != null) model.cachedModels(target.machineId, target.source) else emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var allModels by rememberSaveable { mutableStateOf(false) }
    val ready = state.connection == Connection.READY
    LaunchedEffect(target?.machineId, target?.source, ready) {
        if (model != null && target != null && ready) runCatching { model.models(target.machineId, target.source) }
            .onSuccess { models = it; error = null }.onFailure { if (models.isEmpty()) error = "Список моделей недоступен: ${it.message}" }
    }
    val codex = target?.source == "codex"
    val openCode = OpenCode.isOpenCodeChat(target, state.runSettings?.string("activeModel"), state.options.model)
    val modes = (if (codex) state.machine?.machine?.codexPermissionModes else state.machine?.machine?.permissionModes) ?: if (codex) listOf("default", "plan") else listOf("default", "plan", "acceptEdits")
    val options = state.options
    val active = state.runSettings?.string("activeModel")
    val choices = (if (codex) OpenCode.rowsFor(models, openCode) else models.filter { it.id != "default" }).ifEmpty { if (codex) emptyList() else CURRENT_CLAUDE_MODELS.map { ModelChoice(it.first, it.second) } }
    val accountModel = models.firstOrNull { it.id == "default" }?.resolved?.let { modelLabel(it, models) }?.takeUnless { it.startsWith("Default", ignoreCase = true) }
    // The live CLI names models by alias ids; the display name is what the curated list and the CLI share.
    val current = if (codex) choices else choices.filter { c -> CURRENT_CLAUDE_MODELS.any { (id, name) -> sameModel(id, c.id) || sameModel(id, c.resolved) || name.equals(c.name, ignoreCase = true) } || sameModel(c.id, options.model) || sameModel(c.id, active) }
    val older = choices - current.toSet()
    // A resumed Go run reports only `activeModel`, and it has no account row to mark instead.
    val selectedModel = options.model ?: active.takeIf { openCode } ?: if (openCode && target?.sessionId == null) OpenCode.startModel(null, models) else null
    val row = choices.firstOrNull { sameModel(it.id, selectedModel) }
    val canChange = state.connection == Connection.READY && (target?.sessionId == null || state.runId != null)
    ModalBottomSheet(onDismissRequest = dismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        LazyColumn(Modifier.fillMaxWidth().padding(horizontal = 24.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
            item { Text("Настройка", style = MaterialTheme.typography.titleLarge) }
            if (!canChange) item { Text("Настройки доступны после продолжения сессии.", Modifier.padding(top = 12.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
            item {
                Text("Разрешения", Modifier.padding(top = 20.dp, bottom = 8.dp), style = MaterialTheme.typography.titleMedium)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    modes.forEach { mode ->
                        FilterChip((options.permissionMode ?: "default") == mode, { engine.setOptions(options.copy(permissionMode = mode)) }, enabled = canChange,
                            label = { Text(when (mode) { "plan" -> "Планирование"; "acceptEdits" -> "Принимать правки"; "bypassPermissions", "dontAsk" -> "Без подтверждений"; "auto" -> "Авто"; else -> "Спрашивать" }) })
                    }
                }
            }
            item {
                Text("Рассуждение", Modifier.padding(top = 20.dp, bottom = 8.dp), style = MaterialTheme.typography.titleMedium)
                if (row?.supportsEffort == false) Text("Не поддерживается этой моделью", color = MaterialTheme.colorScheme.onSurfaceVariant)
                else FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(options.effort == null && !options.ultracode, { engine.setOptions(options.copy(effort = null, ultracode = false)) }, enabled = canChange, label = { Text("Как в аккаунте") })
                    listOf("low" to "Низкое", "medium" to "Среднее", "high" to "Высокое", "xhigh" to "Очень высокое").forEach { (id, name) ->
                        if (row?.efforts == null || id in row.efforts.orEmpty()) FilterChip(options.effort == id && !options.ultracode, { engine.setOptions(options.copy(effort = id, ultracode = false)) }, enabled = canChange, label = { Text(name) })
                    }
                    if (!codex && state.runId != null) FilterChip(options.ultracode, { engine.setOptions(options.copy(effort = null, ultracode = true)) }, enabled = canChange, label = { Text("Ultracode") })
                }
            }
            item {
                Text("Модель", Modifier.padding(top = 20.dp), style = MaterialTheme.typography.titleMedium)
                if (!openCode) RadioRow(accountModel?.let { "Как в аккаунте · $it" } ?: "Как в аккаунте", options.model == null, canChange) { engine.setOptions(options.copy(model = null)) }
            }
            fun pick(choice: ModelChoice) = engine.setOptions(options.copy(model = choice.id, effort = options.effort?.takeIf { choice.supportsEffort != false && (choice.efforts == null || it in choice.efforts.orEmpty()) }))
            items(current, key = { it.id }) { choice -> RadioRow(choice.name ?: choice.id, sameModel(choice.id, selectedModel), canChange) { pick(choice) } }
            if (older.isNotEmpty()) {
                if (allModels) items(older, key = { it.id }) { choice -> RadioRow(choice.name ?: choice.id, sameModel(choice.id, selectedModel), canChange) { pick(choice) } }
                else item { TextButton({ allModels = true }) { Text("Все модели · ${older.size}") } }
            }
            error?.let { item { Text(it, Modifier.padding(vertical = 8.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) } }
            item { Button(dismiss, Modifier.fillMaxWidth().padding(top = 16.dp), shape = HegaiTokens.Control) { Text("Готово") } }
        }
    }
}
@Composable fun RadioRow(text: String, selected: Boolean, enabled: Boolean = true, action: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = action).heightIn(min = 48.dp).padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        RadioButton(selected, null, enabled = enabled); Text(text, Modifier.padding(start = 8.dp))
    }
}

/** Decoded images by their base64 payload, bounded by bitmap bytes: a row scrolling back into view
 * reuses its bitmap instead of decoding again. */
private val decodedImages = object : android.util.LruCache<String, androidx.compose.ui.graphics.ImageBitmap>(48 * 1024 * 1024) {
    override fun sizeOf(key: String, value: androidx.compose.ui.graphics.ImageBitmap) = value.asAndroidBitmap().byteCount
}
private fun decodeImage(data: String) = runCatching {
    val bytes = Base64.decode(data, Base64.NO_WRAP)
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 2048) sample *= 2
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
}.getOrNull()

/** Decoding runs off the main thread: it used to run inside composition, so every image entering
 * the screen stalled the frame. */
@Composable fun ImagePreview(image: ImageInput, modifier: Modifier = Modifier) {
    val bitmap by produceState(decodedImages.get(image.data), image.data) {
        // A restarted producer keeps the previous key's bitmap in `value`: always resolve for this key.
        value = decodedImages.get(image.data)
            ?: withContext(Dispatchers.Default) { decodeImage(image.data)?.also { decodedImages.put(image.data, it) } }
    }
    bitmap?.let { Image(it, "Прикреплённое изображение", modifier) }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable fun EnhancedComposer(state: HubState, engine: HubEngine, model: HubViewModel?) {
    val context = LocalContext.current
    val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val voiceMode = model?.voiceMode?.collectAsStateWithLifecycle()?.value ?: "phone"
    val target = state.target
    val density = androidx.compose.ui.platform.LocalDensity.current
    val configuration = androidx.compose.ui.platform.LocalConfiguration.current
    val separateTools = density.fontScale > 1.3f || (configuration.screenWidthDp < 360 && state.busy)
    val imeHeight = with(density) { WindowInsets.ime.getBottom(this).toDp().value }
    // While typing, the model/context pills are out of the way: the field and the buttons need the room.
    val typing = imeHeight > 0f
    val fieldHeight = ((configuration.screenHeightDp - imeHeight - 200f) * .45f).coerceIn(72f, 180f).dp
    val privateTarget = state.privateTarget
    val dictation: VoiceInput = remember(model, target?.key, voiceMode, privateTarget) {
        // A private machine's words never go to the hub's speech service: the phone's own recogniser instead.
        if (model != null && target != null && voiceMode == "server" && !privateTarget) ServerDictation(context, scope,
            transcribe = { model.transcribe(it, target) }, polish = { model.polish(it, target) },
            currentDraft = { engine.state.drafts[target.key].orEmpty() }) else Dictation(context)
    }
    var settings by rememberSaveable { mutableStateOf(false) }
    var attachmentsMenu by remember { mutableStateOf(false) }
    var takeover by remember { mutableStateOf(false) }
    var contextSheet by remember { mutableStateOf(false) }
    var importing by remember { mutableStateOf(false) }
    val targetKey = state.target?.key
    DisposableEffect(dictation) { onDispose { dictation.cancel(false) } }
    val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, dictation) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event -> if (event == androidx.lifecycle.Lifecycle.Event.ON_STOP && dictation.recording) dictation.stop() }
        lifecycle.addObserver(observer); onDispose { lifecycle.removeObserver(observer); dictation.cancel(false) }
    }
    fun startVoice() {
        if (model != null && !model.requestAIDataConsent()) return
        val key = engine.state.target?.key ?: return
        dictation.start(engine.state.draft, { engine.editDraftFor(key, it) }, engine::error)
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
        if (allowed) startVoice() else engine.error("Доступ к микрофону не разрешён")
    }
    fun import(uris: List<android.net.Uri>) {
        val key = engine.state.target?.key ?: return
        importing = true
        scope.launch { try {
            if (model != null) model.importImages(key, uris)
            else engine.importShare(key, "", withContext(Dispatchers.IO) { uris.take(4).map { Attachments.read(context, it) } })
        } catch (e: Exception) { engine.error(e.message ?: "Не удалось прочитать изображение") } finally { importing = false } }
    }
    val files = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { import(it) }
    val cameraFile = remember { File(context.cacheDir, "camera").apply { mkdirs() }.let { File(it, "capture.jpg") } }
    val cameraUri = remember { FileProvider.getUriForFile(context, "${context.packageName}.files", cameraFile) }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok -> if (ok) import(listOf(cameraUri)) }
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
        state.readOnlyReason?.let { Text(if (state.canTakeover) "Сессия открыта на компьютере. Отправка перенесёт управление сюда." else it,
            Modifier.padding(8.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        // White/graphite composer plate; burgundy is reserved for send and stop.
        Surface(shape = androidx.compose.foundation.shape.RoundedCornerShape(28.dp), color = MaterialTheme.colorScheme.surfaceContainerLowest, border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = .5f))) {
            Column(Modifier.padding(8.dp)) {
                if (state.images.isNotEmpty()) Row(Modifier.horizontalScroll(rememberScrollState())) {
                    state.images.forEachIndexed { index, image -> Box(Modifier.padding(4.dp)) {
                        ImagePreview(image, Modifier.size(72.dp)); IconButton({ engine.removeImage(index) }, Modifier.align(Alignment.TopEnd)) { Icon(Icons.Outlined.Close, "Убрать изображение ${index + 1}") }
                    } }
                }
                TextField(state.draft, engine::editDraft, Modifier.fillMaxWidth().heightIn(max = fieldHeight), placeholder = { Text(if (state.target?.sessionId == null) "Опиши задачу…" else "Сообщение…") }, minLines = 1, maxLines = 6,
                    enabled = !dictation.recording && !dictation.finishing,
                    colors = TextFieldDefaults.colors(focusedContainerColor = androidx.compose.ui.graphics.Color.Transparent, unfocusedContainerColor = androidx.compose.ui.graphics.Color.Transparent, disabledContainerColor = androidx.compose.ui.graphics.Color.Transparent,
                        focusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent, unfocusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent))
                if (dictation.recording || dictation.finishing) {
                    Text(if (dictation.finishing) "Дописываю…" else "Слушаю…", Modifier.padding(horizontal = 16.dp))
                    LinearWavyProgressIndicator(progress = { dictation.level }, modifier = Modifier.fillMaxWidth().padding(8.dp))
                }
                if (dictation.retryAvailable) Row {
                    TextButton(dictation::retry) { Text("Повторить распознавание") }
                    TextButton({ dictation.cancel(false) }) { Text("Удалить запись") }
                }
                if (dictation.rawAvailable) TextButton(dictation::useRaw) { Text("Вернуть исходный текст") }
                dictation.notice?.let { Text(it, Modifier.padding(horizontal = 16.dp), style = MaterialTheme.typography.bodySmall) }
                if (importing) LinearWavyProgressIndicator(Modifier.fillMaxWidth())
                val contextControl: @Composable () -> Unit = {
                    state.contextUsage?.let { usage ->
                        TextButton({ contextSheet = true }, contentPadding = PaddingValues(0.dp)) { Text("${usage["percentage"]?.jsonPrimitive?.doubleOrNull?.toInt() ?: 0}%") }
                    }
                }
                val modelControl: @Composable () -> Unit = {
                    val cached = state.target?.let { t -> model?.cachedModels(t.machineId, t.source) }.orEmpty()
                    // The model is a chip with a menu arrow (ChatGPT/Gemini: the model lives on the composer).
                    AssistChip(onClick = { settings = true }, border = null,
                        label = { Text(modelLabel(state.runSettings?.string("activeModel") ?: state.options.model, cached) ?: agentName(state),
                            maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis) },
                        trailingIcon = { Icon(Icons.Outlined.ArrowDropDown, null, Modifier.size(AssistChipDefaults.IconSize)) },
                        colors = AssistChipDefaults.assistChipColors(containerColor = MaterialTheme.colorScheme.surfaceContainer))
                }
                if (separateTools && !typing) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f).padding(horizontal = 8.dp)) { modelControl() }
                    contextControl()
                }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Box {
                        IconButton({ if (dictation.recording || dictation.finishing) dictation.cancel() else attachmentsMenu = true }) {
                            Icon(if (dictation.recording || dictation.finishing) Icons.Outlined.Close else Icons.Outlined.Add, if (dictation.recording || dictation.finishing) "Отменить диктовку" else "Прикрепить изображение") }
                        DropdownMenu(attachmentsMenu, { attachmentsMenu = false }) {
                            DropdownMenuItem(text = { Text("Галерея и файлы") }, onClick = { attachmentsMenu = false; files.launch("image/*") })
                            DropdownMenuItem(text = { Text("Камера") }, onClick = { attachmentsMenu = false; runCatching { camera.launch(cameraUri) }.onFailure { engine.error("Камера недоступна") } })
                        }
                    }
                    if (!separateTools && !typing) contextControl()
                    Box(Modifier.weight(1f)) { if (!separateTools && !typing) modelControl() }
                    IconButton({
                        if (dictation.recording) dictation.stop()
                        else if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) startVoice()
                        else permission.launch(Manifest.permission.RECORD_AUDIO)
                    }, enabled = !dictation.finishing) { Icon(if (dictation.recording) Icons.Outlined.Stop else Icons.Outlined.Mic, if (dictation.recording) "Закончить диктовку" else "Диктовать") }
                    if (state.busy && !dictation.recording && !dictation.finishing) FilledTonalIconButton(engine::interrupt, enabled = state.connection == Connection.READY, shapes = IconButtonDefaults.shapes(), colors = IconButtonDefaults.filledTonalIconButtonColors(containerColor = BrandColors.action, contentColor = BrandColors.onAction)) { Icon(Icons.Outlined.Stop, "Остановить ответ") }
                    FilledIconButton(shapes = IconButtonDefaults.shapes(), colors = IconButtonDefaults.filledIconButtonColors(containerColor = BrandColors.action, contentColor = BrandColors.onAction), onClick = {
                        haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.Confirm)
                        if (state.canTakeover) takeover = true
                        else if (dictation.recording) dictation.stop { engine.submit() }
                        else engine.submit()
                    }, enabled = (state.canSend || state.canTakeover) && (state.draft.isNotBlank() || state.images.isNotEmpty() || dictation.recording) && !importing && !dictation.finishing && !dictation.retryAvailable) {
                        Icon(Icons.AutoMirrored.Outlined.Send, "Отправить")
                    }
                }
            }
        }
    }
    if (settings) RunSettings(state, model, engine) { settings = false }
    if (takeover) AlertDialog(onDismissRequest = { takeover = false }, title = { Text("Продолжить на телефоне?") },
        text = { Text("Текущий процесс редактора будет остановлен. Сообщение отправится после передачи управления.") },
        confirmButton = { TextButton({ takeover = false; engine.submit(takeover = true) }) { Text("Продолжить") } },
        dismissButton = { TextButton({ takeover = false }) { Text("Отмена") } })
    if (contextSheet) AlertDialog(onDismissRequest = { contextSheet = false }, title = { Text("Контекст") },
        text = { Column {
            Text("${state.contextUsage?.get("totalTokens")} из ${state.contextUsage?.get("maxTokens")} токенов")
            Text(when(state.compaction) { "requested" -> "Запросили сжатие…"; "running" -> "Сжимаем контекст…"; "completed" -> "Контекст сжат"; "failed" -> "Сжатие не подтвердилось. Можно повторить."; else -> "" })
            if (state.compaction in listOf("requested", "running")) LinearProgressIndicator(Modifier.fillMaxWidth())
        } },
        confirmButton = { TextButton(engine::compact, enabled = state.runId != null && state.canSend && !state.busy) { Text("Сжать контекст") } },
        dismissButton = { TextButton({ contextSheet = false }) { Text("Закрыть") } })
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun SessionMenu(state: HubState, model: HubViewModel?, engine: HubEngine, dismiss: () -> Unit) {
    val target = state.target ?: return
    var title by remember(target.key) { mutableStateOf(target.title) }
    var query by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var stagePicker by remember { mutableStateOf(false) }
    var ending by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    fun markdown() = "# ${target.title}\n\n" + state.messages.joinToString("\n\n") { "## ${if (it.role == "user") "Вы" else it.role}\n\n${it.text}" }
    ModalBottomSheet(onDismissRequest = dismiss) {
        LazyColumn(Modifier.fillMaxWidth().padding(horizontal = 24.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
            item {
                Text("Сессия", style = MaterialTheme.typography.titleLarge)
                Text("${state.machine?.machine?.name.orEmpty()} · ${target.cwd}", Modifier.padding(vertical = 8.dp), style = MaterialTheme.typography.bodyMedium)
                Text("${agentName(state)} · ${state.session?.gitBranch ?: "Без ветки"}", style = MaterialTheme.typography.bodySmall)
                if (target.sessionId != null) TextButton({ engine.toggleFavorite(target.key) }) { Text(if (target.key in state.favorites) "Убрать из избранного" else "В избранное") }
                OutlinedTextField(title, { title = it.take(200) }, label = { Text("Название") }, modifier = Modifier.fillMaxWidth())
                TextButton({ scope.launch {
                    saving = true
                    try { model?.rpc(target.machineId, "session.rename", buildJsonObject {
                        put("cwd", target.cwd); put("sessionId", target.sessionId); put("title", title.trim()); put("source", target.source)
                    }); engine.renamed(title.trim(), target.key) } catch (e: Exception) { error = e.message } finally { saving = false }
                } }, enabled = model != null && target.sessionId != null && title.isNotBlank() && !saving) { Text("Переименовать") }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                val deleteActions = LocalDeleteActions.current
                val deletable = state.machine?.let { m -> state.session?.takeIf { target.sessionId != null && state.canDeleteSession(m, it) }?.let { m to it } }
                if (deleteActions != null && deletable != null) TextButton({ dismiss(); deleteActions.deleteSession(deletable.first.machine.machineId, deletable.second) }) { Text("Удалить сессию", color = MaterialTheme.colorScheme.error) }
                Row {
                    TextButton({ clipboard.setText(AnnotatedString(markdown())) }) { Text("Копировать") }
                    TextButton({ context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply { type = "text/markdown"; putExtra(Intent.EXTRA_TEXT, markdown()) }, "Экспорт Markdown")) }) { Text("Поделиться") }
                }
                OutlinedTextField(query, { query = it }, label = { Text("Поиск в разговоре") }, modifier = Modifier.fillMaxWidth())
                // The explicit refresh (pull-to-refresh has no accessibility action; the history timeout points here).
                TextButton({ engine.refresh(); dismiss() }, enabled = !state.loadingHistory && !state.opening) { Text("Обновить историю") }
                TextButton(engine::loadMore, enabled = !state.loadingHistory && state.connection == Connection.READY) { Text("Загрузить до 2000 сообщений") }
                if (model != null && (state.privateTarget || state.machine?.machine?.isPrivate == true)) TextButton({ dismiss(); model.requestPair(target.machineId) }) { Text("Ключ шифрования машины") }
                if (state.machine?.let { machine -> state.session?.let { state.canSetStage(machine, it) } } == true) TextButton({ stagePicker = true }) { Text("Этап · " + (sessionStages.firstOrNull { it.first == state.session?.stage }?.second ?: "Без этапа")) }
                TextButton({ ending = true }, enabled = state.runId != null || state.canTakeover) { Text("Завершить запуск", color = MaterialTheme.colorScheme.error) }
            }
            if (query.isNotBlank()) items(state.messages.filter { it.text.contains(query, true) }) { line ->
                Text(line.text, Modifier.padding(vertical = 12.dp), maxLines = 12)
                HorizontalDivider()
            }
        }
    }
    if (stagePicker) StageDialog(state.session?.stage, { engine.setStage(target.machineId, target.sessionId ?: return@StageDialog, it); stagePicker = false }) { stagePicker = false }
    if (ending) AlertDialog(onDismissRequest = { ending = false }, title = { Text("Завершить запуск?") }, text = { Text("История сохранится. Текущая работа агента будет остановлена.") },
        confirmButton = { TextButton({ ending = false; engine.endSession(); dismiss() }) { Text("Завершить") } }, dismissButton = { TextButton({ ending = false }) { Text("Отмена") } })
}

/** A transcript image: loads itself when its row is composed (LazyColumn composes only what is
 * on screen — the web's IntersectionObserver), cached per ref; a ref with no bytes is a quiet plate. */
@Composable fun HistoryImage(ref: String, state: HubState, model: HubViewModel) {
    val target = state.target ?: return
    val ready = state.connection == Connection.READY
    var load by remember(target.key, ref) { mutableStateOf(model.cachedImage(target, ref)) }
    var attempt by remember(target.key, ref) { mutableIntStateOf(0) }
    LaunchedEffect(target.key, ref, attempt, ready) {
        if (load is HubViewModel.ImageLoad.Loaded || load is HubViewModel.ImageLoad.Missing || !ready) return@LaunchedEffect
        load = HubViewModel.ImageLoad.Loading
        load = model.historyImage(target, ref)
    }
    when (val current = load) {
        is HubViewModel.ImageLoad.Loaded -> ImagePreview(current.image, Modifier.padding(top = 8.dp).fillMaxWidth().heightIn(max = 320.dp))
        is HubViewModel.ImageLoad.Missing -> ImagePlate("изображение недоступно")
        is HubViewModel.ImageLoad.Failed -> Row(verticalAlignment = Alignment.CenterVertically) {
            ImagePlate("изображение не загрузилось")
            TextButton({ load = null; attempt++ }, enabled = ready) { Text("Повторить") }
        }
        else -> Box(Modifier.padding(top = 8.dp).fillMaxWidth().height(160.dp).background(MaterialTheme.colorScheme.surfaceVariant, HegaiTokens.Control), contentAlignment = Alignment.Center) {
            Icon(Icons.Outlined.Image, "Загрузка изображения", tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
@Composable private fun ImagePlate(text: String) {
    Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Outlined.Image, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(text, Modifier.padding(start = 6.dp), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
