package net.hegai.code

import android.content.Context
import android.media.MediaRecorder
import androidx.compose.runtime.*
import kotlinx.coroutines.*
import java.io.File
import net.hegai.code.core.insertDictation
import kotlin.math.log10

interface VoiceInput {
    val recording: Boolean
    val finishing: Boolean
    val level: Float
    val retryAvailable: Boolean get() = false
    val rawAvailable: Boolean get() = false
    val notice: String? get() = null
    fun start(draft: String, changed: (String) -> Unit, error: (String) -> Unit)
    fun stop(send: (() -> Unit)? = null)
    fun cancel(restore: Boolean = true)
    fun retry() {}
    fun useRaw() {}
}

/** Keeps the private audio on a transient server failure. No automatic send of partial phone text. */
class ServerDictation(
    private val context: Context, private val scope: CoroutineScope,
    private val transcribe: suspend (File) -> String,
    private val polish: suspend (String) -> String,
    private val currentDraft: () -> String,
) : VoiceInput {
    override var recording by mutableStateOf(false); private set
    override var finishing by mutableStateOf(false); private set
    override var level by mutableFloatStateOf(0f); private set
    override var retryAvailable by mutableStateOf(false); private set
    override var rawAvailable by mutableStateOf(false); private set
    override var notice by mutableStateOf<String?>(null); private set
    private var recorder: MediaRecorder? = null
    private var file: File? = null
    private var loop: Job? = null
    private var work: Job? = null
    private var revision = 0
    private var base = ""
    private var raw = ""
    private var applied = ""
    private var appliedBase = ""
    private var edit: ((String) -> Unit)? = null
    private var failure: ((String) -> Unit)? = null
    private var onComplete: (() -> Unit)? = null
    override fun start(draft: String, changed: (String) -> Unit, error: (String) -> Unit) {
        cancel(false); base = draft; edit = changed; failure = error
        try {
            val recordingFile = File.createTempFile("dictation-", ".m4a", context.cacheDir); file = recordingFile
            @Suppress("DEPRECATION")
            val device = if (android.os.Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else MediaRecorder()
            recorder = device
            device.apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioSamplingRate(24000); setAudioEncodingBitRate(64000)
                setMaxDuration(10 * 60_000); setMaxFileSize(24_000_000)
                setOutputFile(recordingFile.absolutePath)
                setOnInfoListener { _, what, _ -> if (what in listOf(MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED, MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED) && recording) stop() }
                prepare(); start()
            }
            recording = true
            loop = scope.launch { while (recording) {
                val amplitude = runCatching { device.maxAmplitude }.getOrDefault(0).coerceAtLeast(1)
                val db = 20 * log10(amplitude.toDouble() / 32768)
                level = ((db + 55) / 35).toFloat().coerceIn(0f, 1f); delay(100)
            } }
        } catch (e: Exception) { cancel(false); error("Не удалось начать запись: ${e.message}") }
    }
    override fun stop(send: (() -> Unit)?) {
        if (!recording) return
        recording = false; loop?.cancel(); level = 0f
        val device = recorder; recorder = null
        val stopped = runCatching { device?.stop() }.isSuccess
        runCatching { device?.release() }
        if (!stopped || file?.length() == 0L) { val report = failure; cancel(false); report?.invoke("Запись слишком короткая. Попробуйте ещё раз."); return }
        onComplete = send; recognize()
    }
    override fun retry() { if (retryAvailable && !finishing) recognize() }
    private fun recognize() {
        val audio = file ?: return
        val mine = ++revision
        finishing = true; retryAvailable = false; notice = null
        work = scope.launch {
            try {
                val text = transcribe(audio).trim()
                if (mine != revision) return@launch
                if (text.isBlank()) { notice = "В записи не удалось разобрать речь"; retryAvailable = true; onComplete = null; return@launch }
                raw = text
                val clean = try { polish(text) } catch (e: CancellationException) { throw e } catch (_: Exception) { notice = "Обработка текста недоступна — оставлен исходный текст"; text }
                if (mine != revision) return@launch
                val current = currentDraft()
                val changedWhileWaiting = current != base
                appliedBase = current
                applied = insertDictation(base, current, clean)
                edit?.invoke(applied); rawAvailable = clean != raw
                file?.delete(); file = null
                val send = onComplete; onComplete = null
                if (!changedWhileWaiting) send?.invoke() else notice = "Черновик изменился — проверьте текст перед отправкой"
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { if (mine == revision) { retryAvailable = true; onComplete = null; failure?.invoke(e.message ?: "Не удалось распознать. Запись сохранена, можно повторить.") } }
            finally { if (mine == revision) finishing = false }
        }
    }
    override fun useRaw() {
        if (rawAvailable && currentDraft() == applied) {
            applied = insertDictation(base, appliedBase, raw); edit?.invoke(applied); rawAvailable = false
        }
    }
    override fun cancel(restore: Boolean) {
        ++revision; loop?.cancel(); work?.cancel(); onComplete = null
        runCatching { recorder?.stop() }; runCatching { recorder?.release() }; recorder = null
        if (restore && currentDraft() == applied && applied.isNotEmpty()) edit?.invoke(appliedBase)
        file?.delete(); file = null
        recording = false; finishing = false; retryAvailable = false; rawAvailable = false; level = 0f; notice = null
        edit = null; failure = null; raw = ""; applied = ""; appliedBase = ""
    }
}
