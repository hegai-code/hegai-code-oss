package net.hegai.code.core

/**
 * Which files an assistant answer NAMED so that they are worth previewing: a screenshot or a
 * markdown note. Port of ios `PreviewPaths.swift` / web `render/filePaths.ts` (and the
 * `FS_PEEK_EXTENSIONS` list in shared/src/rpc.ts): the rules change together.
 *
 *  - absolute POSIX path, Windows `C:\…`, or relative with at least one `/`;
 *  - extension png jpg jpeg gif webp md markdown, case-insensitive;
 *  - works inside backticks and markdown links `[x](/a/b.png)`;
 *  - trailing punctuation `.,;:)»"'` is not part of the path; URLs are ignored;
 *  - spaces: inside backticks, `](<…>)`, "…" and «…» the path is the whole span; in prose one
 *    space after a rooted fragment is bridged (`/srv/my dir/a.png`), more is ambiguous;
 *  - no repeats, order of appearance, at most six.
 *
 * Linear scan, no nested quantifiers: the text comes from a model.
 */
object PreviewPaths {
    val extensions = setOf("png", "jpg", "jpeg", "gif", "webp", "md", "markdown")
    private val imageExtensions = setOf("png", "jpg", "jpeg", "gif", "webp")
    const val LIMIT = 6
    const val IMAGE_MAX_BYTES = 16 * 1024 * 1024
    const val MARKDOWN_MAX_BYTES = 512 * 1024

    private val urlRe = Regex("https?://\\S+", RegexOption.IGNORE_CASE)
    private val delimiters = setOf('`', '(', ')', '[', ']', '{', '}', '<', '>', '"', '\'', '«', '»', '“', '”', '„',
        ',', ';', '|', '*', '!', '?', '=', '#')
    private val trailing = setOf('.', ',', ';', ':', ')', '»', '"', '\'')

    private class Word(val start: Int, val end: Int, val text: String)

    fun find(text: String): List<String> {
        if (!text.contains('.')) return emptyList()
        val chars = stripUrls(text).toCharArray()
        val hits = mutableListOf<Pair<Int, String>>()
        var i = 0
        while (i < chars.size) {
            val c = chars[i]
            var close: Char? = null
            var start = i + 1
            when {
                c == '`' -> close = '`'
                c == '"' -> close = '"'
                c == '«' -> close = '»'
                c == ']' && i + 2 < chars.size && chars[i + 1] == '(' && chars[i + 2] == '<' -> { close = '>'; start = i + 3 }
            }
            if (close == null || start > chars.size) { i++; continue }
            var end = -1
            for (k in start until chars.size) if (chars[k] == close || chars[k] == '\n') { end = k; break }
            if (end < 0 || chars[end] != close || (c == ']' && !(end + 1 < chars.size && chars[end + 1] == ')'))) { i++; continue }
            val stop = if (c == ']') end + 1 else end
            val inner = String(chars, start, end - start).trim(' ', '\t')
            if (inner.contains(' ')) spanPath(inner)?.let { path ->
                hits += i to path
                for (k in i..stop) chars[k] = ' '
            }
            i = stop + 1
        }
        val words = tokens(chars)
        for ((n, w) in words.withIndex()) {
            var path = candidate(w.text) ?: continue
            var at = w.start
            if (!isAbsolute(path) && n > 0) {
                val prev = words[n - 1]
                if (prev.end == w.start - 1 && chars[prev.end] == ' ' && bridges(prev.text)) {
                    path = prev.text + " " + path; at = prev.start
                }
            }
            hits += at to path
        }
        val found = mutableListOf<String>()
        for ((_, path) in hits.sortedBy { it.first }) {
            if (path in found) continue
            found += path
            if (found.size >= LIMIT) break
        }
        return found
    }

    fun isImage(path: String) = extensionOf(path) in imageExtensions
    fun isAbsolute(path: String) = path.startsWith("/") || isWindowsDrive(path)
    fun fileName(path: String): String = path.split('/', '\\').lastOrNull { it.isNotEmpty() } ?: path

    private fun stripUrls(text: String) = if (text.contains("://")) urlRe.replace(text, " ") else text

    private fun tokens(chars: CharArray): List<Word> {
        val out = mutableListOf<Word>()
        var start = -1
        for (k in chars.indices) {
            val cut = chars[k].isWhitespace() || chars[k] in delimiters
            if (cut && start >= 0) { out += Word(start, k, String(chars, start, k - start)); start = -1 }
            if (!cut && start < 0) start = k
        }
        if (start >= 0) out += Word(start, chars.size, String(chars, start, chars.size - start))
        return out
    }

    private fun bridges(word: String): Boolean {
        if (!(word.startsWith("/") || isWindowsDrive(word))) return false
        val last = word.last()
        if (last in trailing || last == '!' || last == '?') return false
        val name = fileName(word)
        val dot = name.lastIndexOf('.')
        if (dot > 0) {
            val ext = name.substring(dot + 1)
            if (ext.length in 1..8 && ext.all { it.code < 128 && it.isLetterOrDigit() }) return false
        }
        return true
    }

    private fun spanPath(inner: String): String? {
        if (inner.length > 4096 || inner.any { it in "<>\"`|*?\n" }) return null
        if (extensionOf(inner) !in extensions) return null
        if (fileName(inner).length <= extensionOf(inner).length + 1) return null
        if (isAbsolute(inner)) return if (inner.startsWith("//")) null else inner
        if (inner.lowercase().startsWith("www.")) return null
        val sep = inner.indexOfFirst { it == '/' || it == '\\' }
        val space = inner.indexOf(' ')
        if (sep < 0 || space < 0 || sep > space) return null
        return inner
    }

    private fun candidate(token: String): String? {
        var s = token
        val colon = s.indexOf(':')
        if (colon > 0) {
            val after = colon + 1
            val label = s.substring(0, colon)
            if (after < s.length && s[after] == '/' && label.length > 1 && !label.contains('/') && !label.contains('\\')) s = s.substring(after)
        }
        while (s.isNotEmpty() && s.last() in trailing) s = s.dropLast(1)
        while (s.startsWith(":")) s = s.drop(1)
        if (s.length > 4096) return null
        val ext = extensionOf(s)
        if (ext !in extensions) return null
        if (fileName(s).length <= ext.length + 1) return null
        if (isWindowsDrive(s)) return s
        if (s.startsWith("/")) return if (s.startsWith("//")) null else s
        if (s.lowercase().startsWith("www.")) return null
        return if (s.contains('/') || s.contains('\\')) s else null
    }

    private fun isWindowsDrive(path: String): Boolean {
        if (path.length < 3) return false
        return path[0].code < 128 && path[0].isLetter() && path[1] == ':' && (path[2] == '\\' || path[2] == '/')
    }

    private fun extensionOf(path: String): String {
        val name = fileName(path)
        val dot = name.lastIndexOf('.')
        return if (dot <= 0) "" else name.substring(dot + 1).lowercase()
    }
}

/** One `fs.peek` window: shared/src/rpc.ts result. */
data class PeekWindow(val offset: Int, val bytes: Int, val size: Long, val mtime: Double, val eof: Boolean, val data: ByteArray)

class PreviewReadException(message: String) : Exception(message)

/**
 * The windowed read of one file (ios `peekFile`): ask `next()`, feed the reply to `accept`.
 * Stops with an error — never a truncated copy — when the file exceeds `maxBytes`, changes
 * (mtime/size) between windows or a window lies about its offset. `clip`: take the first
 * `maxBytes` of a longer file instead of refusing it (text preview).
 */
class PeekAssembler(private val maxBytes: Int, private val clip: Boolean, private val window: Int = 512 * 1024) {
    private val out = java.io.ByteArrayOutputStream()
    private var first: PeekWindow? = null
    var result: ByteArray? = null
        private set
    val done get() = result != null
    /** (offset, length) of the next window. */
    fun next(): Pair<Int, Int> = out.size() to (if (clip) minOf(window, maxOf(1, maxBytes - out.size())) else window)
    fun accept(part: PeekWindow) {
        val f = first
        if (f != null) {
            if (f.mtime != part.mtime || f.size != part.size) throw PreviewReadException("file changed while reading")
        } else {
            if (!clip && part.size > maxBytes) throw PreviewReadException("file too large")
            first = part
        }
        if (part.offset != out.size() || part.data.size != part.bytes) throw PreviewReadException("bad window")
        out.write(part.data)
        if (part.eof) { result = out.toByteArray(); return }
        if (clip && out.size() >= maxBytes) { result = out.toByteArray().copyOf(maxBytes); return }
        if (part.bytes <= 0 || out.size() > maxBytes) throw PreviewReadException("bad window")
    }
}
