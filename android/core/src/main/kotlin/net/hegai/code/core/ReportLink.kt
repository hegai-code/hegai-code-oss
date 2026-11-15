package net.hegai.code.core

import java.net.URI

/** Only the configured hub can receive the authenticated content request. */
data class ReportLink(val id: String) {
    fun webUrl(hub: String = HubUrl.DEFAULT): String = HubUrl.report(hub, id)
    val contentPath: String get() = "/api/reports/$id/content"
    companion object {
        fun parse(raw: String, hub: String = HubUrl.DEFAULT): ReportLink? {
            val uri = runCatching { URI(raw) }.getOrNull() ?: return null
            if (uri.scheme != "https" || !HubUrl.matches(hub, uri.host, uri.port) || uri.rawUserInfo != null) return null
            val id = Regex("^/w/reports/([a-fA-F0-9]{32})/?$").matchEntire(uri.rawPath)?.groupValues?.get(1) ?: return null
            return ReportLink(id.lowercase())
        }
        // Exact public libraries only. Report-controlled paths/queries must never
        // become CDN requests: script-src is also a possible exfiltration channel.
        private val chart = "https://cdn.jsdelivr.net/npm/chart.js@4.4.8/dist/chart.umd.min.js"
        private val echarts = "https://cdn.jsdelivr.net/npm/echarts@5.6.0/dist/echarts.min.js"
        private val d3 = "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"
        private val mermaid = "https://cdn.jsdelivr.net/npm/mermaid@10.9.3/dist/mermaid.min.js"
        private val assets = mapOf(
            chart to chart, "https://cdn.jsdelivr.net/npm/chart.js" to chart,
            "https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js" to chart,
            "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js" to chart,
            echarts to echarts, "https://cdn.jsdelivr.net/npm/echarts/dist/echarts.min.js" to echarts,
            d3 to d3, "https://d3js.org/d3.v7.min.js" to d3,
            mermaid to mermaid,
        )
        fun asset(raw: String): String? = assets[raw]
        private val CSP = "default-src 'none'; script-src 'unsafe-inline' ${assets.keys.joinToString(" ")}; style-src 'unsafe-inline'; font-src data:; img-src data: blob:; media-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'"
        fun hardened(html: String): String {
            val tag = "<meta http-equiv=\"Content-Security-Policy\" content=\"$CSP\">"
            val lead = html.dropWhile { it.isWhitespace() || it == '\uFEFF' }
            val end = if (lead.startsWith("<!doctype", true)) html.indexOf('>', html.length - lead.length) else -1
            return if (end >= 0) html.substring(0, end + 1) + tag + html.substring(end + 1) else tag + html
        }
    }
}
