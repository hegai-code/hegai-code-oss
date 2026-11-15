package net.hegai.code

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import androidx.exifinterface.media.ExifInterface
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.serialization.json.*
import net.hegai.code.core.*
import java.io.ByteArrayInputStream

/** Where a preview reads from. `scope` = account + workspace, so another account never sees this cache. */
data class PreviewKey(val scope: String, val machineId: String, val cwd: String, val path: String) {
    val id get() = listOf(scope, machineId, cwd, path).joinToString("") { "${it.length}:$it" }
}

/**
 * In-memory previews of files an answer named (ios FilePreviewStore): only successes are cached
 * (5 min — a path is often overwritten by the next screenshot), a failure is remembered for 30 s
 * so a dead path in a long answer does not hit the agent on every scroll. At most 3 reads run at
 * once (the hub refuses a connection past 32 requests in flight); equal requests share one read.
 * Used from the main thread only.
 */
class FilePreviewStore(
    private val scope: CoroutineScope,
    private val rpc: suspend (machineId: String, method: String, params: JsonObject) -> JsonObject,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private class Entry(val value: Any, val at: Long, val cost: Long)
    private val cache = LinkedHashMap<String, Entry>(32, 0.75f, true)
    private val failedAt = mutableMapOf<String, Long>()
    private val pending = mutableMapOf<String, Deferred<Any?>>()
    private val gate = Semaphore(3)
    private var owner: String? = null

    fun cachedImage(key: PreviewKey): Bitmap? = fresh(key.id)?.value as? Bitmap
    fun cachedText(key: PreviewKey): String? = fresh(key.id)?.value as? String
    private fun fresh(id: String): Entry? = cache[id]?.takeIf { now() - it.at < SUCCESS_MS }

    suspend fun image(key: PreviewKey, force: Boolean = false): Bitmap? = run(key, force) {
        val data = peek(key, PreviewPaths.IMAGE_MAX_BYTES, clip = false)
        withContext(Dispatchers.Default) { decode(data) }
    } as? Bitmap

    suspend fun text(key: PreviewKey, force: Boolean = false): String? = run(key, force) {
        val data = peek(key, PreviewPaths.MARKDOWN_MAX_BYTES, clip = true)
        val head = String(data, Charsets.UTF_8)
        if (data.size >= PreviewPaths.MARKDOWN_MAX_BYTES) "$head\n\n_Показано начало файла._" else head
    } as? String

    private suspend fun run(key: PreviewKey, force: Boolean, make: suspend () -> Any?): Any? {
        if (owner != key.scope) {
            pending.values.forEach { it.cancel() }; pending.clear(); cache.clear(); failedAt.clear(); owner = key.scope
        }
        val id = key.id
        if (force) failedAt.remove(id)
        if (!force) fresh(id)?.let { return it.value }
        failedAt[id]?.let { if (now() - it < FAILURE_MS) return null }
        pending[id]?.let { return wait(it, key) }
        // The job outlives a cancelled caller (the row scrolled away) and stores its own result.
        // LAZY, started only once it is in `pending`: on Main.immediate a read that
        // fails synchronously (no access, mid-reconnect) would otherwise finish and
        // clear `pending` BEFORE being stored there, leaving a dead job forever.
        val job = scope.async(start = CoroutineStart.LAZY) {
            val value = gate.withPermit { try { make() } catch (e: CancellationException) { throw e } catch (e: Exception) { null } }
            if (owner == key.scope) {
                pending.remove(id)
                if (value != null) {
                    val cost = if (value is Bitmap) value.allocationByteCount.toLong() else (value as String).length * 2L
                    cache[id] = Entry(value, now(), cost)
                    failedAt.remove(id)
                    while (cache.size > 40 || (cache.size > 1 && cache.values.sumOf { it.cost } > 96L * 1024 * 1024)) cache.remove(cache.keys.first())
                } else {
                    cache.remove(id); failedAt[id] = now()
                }
            }
            value
        }
        pending[id] = job
        job.start()
        return wait(job, key)
    }

    /** A job cancelled by a scope change is an answer («nothing»), not a cancellation of the caller. */
    private suspend fun wait(job: Deferred<Any?>, key: PreviewKey): Any? =
        try { job.await().takeIf { owner == key.scope } } catch (e: CancellationException) { currentCoroutineContext().ensureActive(); null }

    private suspend fun peek(key: PreviewKey, maxBytes: Int, clip: Boolean): ByteArray {
        val assembler = PeekAssembler(maxBytes, clip)
        while (!assembler.done) {
            val (offset, length) = assembler.next()
            val r = rpc(key.machineId, "fs.peek", buildJsonObject {
                put("cwd", key.cwd); put("path", key.path); put("offset", offset); put("length", length)
            })
            val bytes = (r["bytes"] as? JsonPrimitive)?.intOrNull ?: throw PreviewReadException("bad window")
            val data = withContext(Dispatchers.Default) { android.util.Base64.decode(r.string("data").orEmpty(), android.util.Base64.DEFAULT) }
            assembler.accept(PeekWindow(
                offset = (r["offset"] as? JsonPrimitive)?.intOrNull ?: -1, bytes = bytes,
                size = (r["size"] as? JsonPrimitive)?.longOrNull ?: -1, mtime = (r["mtime"] as? JsonPrimitive)?.doubleOrNull ?: Double.NaN,
                eof = (r["eof"] as? JsonPrimitive)?.booleanOrNull ?: false, data = data,
            ))
        }
        return assembler.result!!
    }

    /** 2400 px on the long side: enough for a 4x pinch on a phone, ~23 MB decoded at worst. */
    private fun decode(bytes: ByteArray): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        val longest = maxOf(bounds.outWidth, bounds.outHeight)
        // Decoded long side never above 2400 px (a 4799 px picture is sampled too).
        while (longest / sample > 2400) sample *= 2
        var bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
        val orientation = runCatching { ExifInterface(ByteArrayInputStream(bytes)).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1) }.getOrDefault(1)
        val matrix = Matrix().apply { when (orientation) {
            2 -> setScale(-1f, 1f); 3 -> setRotate(180f); 4 -> setScale(1f, -1f)
            5 -> { setRotate(90f); postScale(-1f, 1f) }; 6 -> setRotate(90f)
            7 -> { setRotate(270f); postScale(-1f, 1f) }; 8 -> setRotate(270f)
        } }
        if (!matrix.isIdentity) {
            val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
            if (rotated !== bitmap) bitmap.recycle(); bitmap = rotated
        }
        return bitmap
    }

    private companion object { const val SUCCESS_MS = 300_000L; const val FAILURE_MS = 30_000L }
}
