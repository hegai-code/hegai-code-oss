package net.hegai.code

import android.widget.TextView
import android.text.method.LinkMovementMethod
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import io.noties.markwon.Markwon
import io.noties.markwon.ext.tables.TablePlugin
import io.noties.markwon.ext.strikethrough.StrikethroughPlugin

/** Native text selection, accessible links, headings, code and horizontally scrolling tables. */
@Composable fun Markdown(text: String, modifier: Modifier = Modifier, activity: Int? = null, onActivity: () -> Unit = {}) {
    val context = LocalContext.current
    val openReport by rememberUpdatedState(LocalReportOpener.current)
    val color = MaterialTheme.colorScheme.onSurface.toArgb()
    val scheme = MaterialTheme.colorScheme
    val codeBackground = scheme.surfaceContainerHigh.toArgb()
    val linkColor = scheme.tertiary.toArgb()
    val onest = remember(context) { androidx.core.content.res.ResourcesCompat.getFont(context, R.font.onest) }
    val mono = remember(context) { androidx.core.content.res.ResourcesCompat.getFont(context, R.font.ibm_plex_mono) }
    val density = context.resources.displayMetrics.density
    val markwon = remember(context, codeBackground, linkColor) { Markwon.builder(context)
        .usePlugin(object : io.noties.markwon.AbstractMarkwonPlugin() {
            // Code in Plex Mono on the container rung, links in the accent: the answer reads as one
            // typeset page instead of Roboto with grey slabs.
            override fun configureTheme(builder: io.noties.markwon.core.MarkwonTheme.Builder) {
                builder.codeTypeface(mono ?: android.graphics.Typeface.MONOSPACE).codeBlockTypeface(mono ?: android.graphics.Typeface.MONOSPACE)
                    .codeTextSize((13 * density).toInt()).codeBlockTextSize((13 * density).toInt())
                    .codeBackgroundColor(codeBackground).codeBlockBackgroundColor(codeBackground)
                    .codeBlockMargin((12 * density).toInt()).blockMargin((20 * density).toInt())
                    .linkColor(linkColor).isLinkUnderlined(false)
                    .headingBreakHeight(0).headingTextSizeMultipliers(floatArrayOf(1.5f, 1.3f, 1.15f, 1f, 0.9f, 0.85f))
                    .headingTypeface(onest ?: android.graphics.Typeface.DEFAULT_BOLD)
            }
        })
        .usePlugin(object : io.noties.markwon.AbstractMarkwonPlugin() {
            override fun configureConfiguration(builder: io.noties.markwon.MarkwonConfiguration.Builder) {
                builder.linkResolver { view, link ->
                    if (openReport(link)) return@linkResolver
                    val uri = android.net.Uri.parse(link)
                    if (uri.scheme?.lowercase() in listOf("https", "http", "mailto")) runCatching {
                        view.context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, uri))
                    }
                }
            }
        })
        .usePlugin(TablePlugin.create(context)).usePlugin(StrikethroughPlugin.create()).build() }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant.toArgb()
    val openActivity by rememberUpdatedState(onActivity)
    val rendered = remember(text, markwon, activity, muted) {
        markwon.toMarkdown(text).let { if (activity == null) it else appendGear(text, it, activity, muted) { openActivity() } }
    }
    AndroidView(modifier = modifier, factory = { ctx -> TextView(ctx).apply {
        textSize = 16f; setLineSpacing(0f, 1.3f); setTextIsSelectable(true); onest?.let { typeface = it }
        movementMethod = LinkMovementMethod.getInstance()
    } }, update = { view -> view.setTextColor(color); view.setLinkTextColor(linkColor); markwon.setParsedMarkdown(view, rendered) })
}
