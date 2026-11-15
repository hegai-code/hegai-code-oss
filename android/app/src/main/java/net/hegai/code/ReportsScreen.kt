package net.hegai.code

import android.content.Intent
import android.net.Uri
import android.webkit.*
import androidx.compose.foundation.clickable
import androidx.compose.ui.draw.clip
import androidx.compose.ui.Alignment
import androidx.compose.material.icons.outlined.Description
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import net.hegai.code.core.*
import kotlinx.serialization.json.*
import java.io.ByteArrayInputStream

/** No WebView networking. Only fixed library URLs are fetched, without auth/cookies/referrer. */
private object ReportAssets {
    private val http = okhttp3.OkHttpClient.Builder().followRedirects(false)
        .callTimeout(15, java.util.concurrent.TimeUnit.SECONDS).build()
    private val cache = java.util.concurrent.ConcurrentHashMap<String, ByteArray>()
    fun response(raw: String): WebResourceResponse {
        val asset = ReportLink.asset(raw)
        val bytes = if (asset == null) ByteArray(0) else runCatching {
            cache[asset] ?: http.newCall(okhttp3.Request.Builder().url(asset).build()).execute().use { response ->
                check(response.isSuccessful)
                val source = response.body?.source() ?: error("empty asset")
                source.request(4_000_001)
                source.buffer.readByteArray().also { check(it.size <= 4_000_000); cache[asset] = it }
            }
        }.getOrDefault(ByteArray(0))
        return WebResourceResponse("text/javascript", "UTF-8", ByteArrayInputStream(bytes))
    }
}

val LocalReportOpener = staticCompositionLocalOf<(String) -> Boolean> { { false } }

@Composable fun ReportsScreen(model: HubViewModel) {
    val hubBase by model.hubBase.collectAsStateWithLifecycle()
    var reports by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    var query by remember { mutableStateOf("") }
    LaunchedEffect(attempt) {
        loading = true
        try { reports = model.api("/api/reports").rows("reports"); error = null }
        catch (e: Exception) { error = e.message }
        finally { loading = false }
    }
    Column(Modifier.fillMaxSize().padding(horizontal = 20.dp)) {
        OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), label = { Text("Найти отчёт") }, singleLine = true)
        Row { TextButton({ attempt++ }, enabled = !loading) { Text("Обновить") }; if (loading) CircularProgressIndicator(Modifier.size(32.dp)) }
        ErrorNote(error)
        val groups = reports.filter { "${it.string("title")} ${it.string("description")}".contains(query, true) }
            .groupBy { it.string("folder").orEmpty() }.entries.sortedWith(compareBy<Map.Entry<String, List<JsonObject>>> { it.key.isNotEmpty() }
                .thenByDescending { it.value.maxOf { row -> row.number("updatedAt") ?: row.number("createdAt") ?: 0.0 } })
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            groups.forEach { (folder, rows) ->
                item { Text(folder.ifEmpty { "Hegai Code" }, Modifier.padding(vertical = 16.dp), style = MaterialTheme.typography.titleMedium) }
                items(rows.sortedByDescending { it.number("updatedAt") ?: it.number("createdAt") ?: 0.0 }, key = { it.string("id").orEmpty() }) { row ->
                    ListItem(leadingContent = { Surface(shape = HegaiTokens.Control, color = BrandColors.lilac) { Box(Modifier.size(44.dp), contentAlignment = Alignment.Center) { Icon(Icons.Outlined.Description, null, tint = BrandColors.onLilac) } } },
                        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainerLowest),
                        headlineContent = { Text(row.string("title")?.ifEmpty { "Без названия" } ?: "Без названия") },
                        supportingContent = { Column { row.string("description")?.let { Text(it, maxLines = 2) }; Text(dateLabel(row.number("updatedAt") ?: row.number("createdAt"))) } },
                        modifier = Modifier.clip(HegaiTokens.Card).clickable { model.openReport(HubUrl.report(hubBase, row.string("id").orEmpty())) })
                }
            }
            if (!loading && groups.isEmpty()) item { Text(if (query.isBlank()) "Отчётов пока нет" else "Ничего не найдено", Modifier.padding(vertical = 24.dp)) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun ReportDialog(model: HubViewModel) {
    val link by model.report.collectAsStateWithLifecycle()
    val hubBase by model.hubBase.collectAsStateWithLifecycle()
    val current = link ?: return
    val context = LocalContext.current
    var html by remember(current) { mutableStateOf<String?>(null) }
    var error by remember(current) { mutableStateOf<String?>(null) }
    var title by remember(current) { mutableStateOf("Отчёт") }
    var attempt by remember(current) { mutableIntStateOf(0) }
    LaunchedEffect(current, attempt) {
        try { html = model.reportContent(current); error = null }
        catch (e: Exception) { error = e.message }
        runCatching { model.api("/api/reports/${current.id}").string("title") }.onSuccess { title = it ?: "Отчёт" }
    }
    Dialog(model::closeReport, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Surface(Modifier.fillMaxSize()) { Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            TopAppBar(title = { Text(title, maxLines = 1) }, navigationIcon = {
                IconButton({ context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply { type = "text/plain"; putExtra(Intent.EXTRA_TEXT, current.webUrl(hubBase)) }, "Поделиться отчётом")) }) { Icon(Icons.Outlined.Share, "Поделиться") }
            }, actions = { IconButton(model::closeReport) { Icon(Icons.Outlined.Close, "Закрыть отчёт") } }, windowInsets = WindowInsets(0))
            if (html == null) { ErrorNote(error); if (error != null) TextButton({ attempt++ }) { Text("Повторить") } else CircularProgressIndicator() }
            html?.let { document -> key(current, document) {
                AndroidView(modifier = Modifier.fillMaxWidth().weight(1f), factory = { ctx -> WebView(ctx).apply {
                    settings.javaScriptEnabled = true
                    settings.allowFileAccess = false; settings.allowContentAccess = false
                    settings.domStorageEnabled = false; settings.setSupportMultipleWindows(false)
                    settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                    CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
                    webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                            val raw = request.url.toString()
                            if (raw.startsWith("about:blank#")) return false
                            if (!request.isForMainFrame || !request.hasGesture()) return true
                            if (!model.openReport(raw) && request.url.scheme in listOf("https", "http", "mailto"))
                                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                            return true
                        }
                        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                            return ReportAssets.response(request.url.toString())
                        }
                    }
                    loadDataWithBaseURL(null, document, "text/html", "UTF-8", null)
                } }, onRelease = { it.stopLoading(); it.destroy() })
            } }
        } }
    }
}
