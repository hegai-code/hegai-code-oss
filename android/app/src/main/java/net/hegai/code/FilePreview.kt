package net.hegai.code

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import net.hegai.code.core.Connection
import net.hegai.code.core.HubState
import net.hegai.code.core.PreviewPaths

/**
 * Under a FINISHED assistant answer: one row per file it named (ios FilePreviewStrip). An image is a
 * lazily loaded thumbnail that opens full screen with pinch-zoom; a .md is a chip that opens a sheet.
 * Needs a session folder (machine + cwd) — without it nothing is drawn.
 */
@Composable fun FilePreviewStrip(text: String, state: HubState, model: HubViewModel?) {
    val target = state.target ?: return
    if (model == null || target.cwd.isBlank()) return
    val paths = remember(text) { PreviewPaths.find(text) }
    if (paths.isEmpty()) return
    val scope = model.previewScope() ?: return
    Column(Modifier.fillMaxWidth().padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        paths.forEach { path ->
            val key = PreviewKey(scope, target.machineId, target.cwd, path)
            // Identity is the whole key: the same path in another folder or account is another file.
            key(key.id) { FilePreviewItem(key, state.connection == Connection.READY, model.previews) }
        }
    }
}

@Composable private fun FilePreviewItem(key: PreviewKey, ready: Boolean, store: FilePreviewStore) {
    val path = key.path
    val image = PreviewPaths.isImage(path)
    val name = PreviewPaths.fileName(path)
    var bitmap by remember { mutableStateOf(if (image) store.cachedImage(key) else null) }
    var markdown by remember { mutableStateOf(if (!image) store.cachedText(key) else null) }
    var failed by remember { mutableStateOf(false) }
    var attempt by remember { mutableIntStateOf(0) }
    var open by remember { mutableStateOf(false) }
    LaunchedEffect(attempt, ready) {
        if (!ready) return@LaunchedEffect
        val force = attempt > 0
        if (image) { if (bitmap == null) failed = false; bitmap = store.image(key, force); failed = bitmap == null }
        else { if (markdown == null) failed = false; markdown = store.text(key, force); failed = markdown == null }
    }
    val chip = MaterialTheme.colorScheme.surfaceContainer
    when {
        image && bitmap != null -> {
            val picture = bitmap!!
            Image(picture.asImageBitmap(), "Открыть изображение $name", Modifier
                .widthIn(max = 320.dp).heightIn(max = 240.dp)
                .clip(MaterialTheme.shapes.medium)
                .border(0.5.dp, MaterialTheme.colorScheme.outlineVariant, MaterialTheme.shapes.medium)
                .clickable { open = true }, contentScale = ContentScale.Fit)
            if (open) ZoomableImageDialog(picture, name) { open = false }
        }
        !image && markdown != null -> {
            FileChip(name, Icons.Outlined.Description, MaterialTheme.colorScheme.onSurface, chip, "Открыть файл $name") { open = true }
            if (open) MarkdownSheet(name, markdown!!) { open = false }
        }
        failed -> if (PreviewPaths.isAbsolute(path)) FileChip(name, if (image) Icons.Outlined.Image else Icons.Outlined.Description,
            MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f), chip.copy(alpha = 0.5f), "$name, недоступен. Повторить", suffix = "· недоступен") { attempt++ }
        // A relative path in prose is usually a word with a slash, not a file: it vanishes on failure.
        image -> Box(Modifier.widthIn(max = 240.dp).fillMaxWidth().height(120.dp).clip(MaterialTheme.shapes.medium).background(chip)
            .semantics { contentDescription = "Загрузка изображения $name" }, contentAlignment = Alignment.Center) {
            CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
        }
        else -> FileChip(name, Icons.Outlined.Description, MaterialTheme.colorScheme.onSurfaceVariant, chip, "Загрузка файла $name", alpha = 0.6f) {}
    }
}

@Composable private fun FileChip(name: String, icon: androidx.compose.ui.graphics.vector.ImageVector, tone: Color, container: Color,
    label: String, suffix: String? = null, alpha: Float = 1f, onClick: () -> Unit) {
    Surface(onClick, Modifier.semantics { contentDescription = label }.graphicsLayer { this.alpha = alpha }, shape = HegaiTokens.Control, color = container) {
        Row(Modifier.heightIn(min = 48.dp).padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, Modifier.size(18.dp), tint = tone)
            Text(name, Modifier.padding(start = 6.dp).weight(1f, fill = false), color = tone, fontFamily = HegaiTokens.Mono,
                style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
            if (suffix != null) Text(suffix, Modifier.padding(start = 6.dp), color = tone, style = MaterialTheme.typography.labelMedium)
        }
    }
}

@Composable private fun ZoomableImageDialog(bitmap: android.graphics.Bitmap, title: String, dismiss: () -> Unit) {
    Dialog(dismiss, DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        var scale by remember { mutableFloatStateOf(1f) }
        var offsetX by remember { mutableFloatStateOf(0f) }
        var offsetY by remember { mutableFloatStateOf(0f) }
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            Image(bitmap.asImageBitmap(), title, Modifier.fillMaxSize()
                .pointerInput(Unit) {
                    detectTransformGestures { _, pan, zoom, _ ->
                        scale = (scale * zoom).coerceIn(1f, 6f)
                        if (scale == 1f) { offsetX = 0f; offsetY = 0f } else { offsetX += pan.x; offsetY += pan.y }
                    }
                }
                .pointerInput(Unit) {
                    detectTapGestures(onDoubleTap = { if (scale > 1f) { scale = 1f; offsetX = 0f; offsetY = 0f } else scale = 2.5f })
                }
                .graphicsLayer { scaleX = scale; scaleY = scale; translationX = offsetX; translationY = offsetY },
                contentScale = ContentScale.Fit)
            Row(Modifier.fillMaxWidth().statusBarsPadding().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(dismiss) { Icon(Icons.Outlined.Close, "Закрыть", tint = Color.White) }
                Text(title, Modifier.weight(1f), color = Color.White, fontFamily = HegaiTokens.Mono, style = MaterialTheme.typography.labelLarge,
                    maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun MarkdownSheet(name: String, text: String, dismiss: () -> Unit) {
    ModalBottomSheet(dismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 32.dp)) {
            Text(name, Modifier.padding(bottom = 12.dp), fontFamily = HegaiTokens.Mono, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
            Markdown(text, Modifier.fillMaxWidth())
        }
    }
}
