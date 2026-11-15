package net.hegai.code

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.compose.runtime.*

/** Owns a single explicit microphone gesture, bound to its draft by the UI. */
class Dictation(private val context: Context) : VoiceInput {
    override var recording by mutableStateOf(false); private set
    override var finishing by mutableStateOf(false); private set
    override var level by mutableFloatStateOf(0f); private set
    private var recognizer: SpeechRecognizer? = null
    private val handler = Handler(Looper.getMainLooper())
    private var edit: ((String) -> Unit)? = null
    private var failure: ((String) -> Unit)? = null
    private var base = ""
    private var onComplete: (() -> Unit)? = null
    override fun start(draft: String, changed: (String) -> Unit, error: (String) -> Unit) {
        if (!SpeechRecognizer.isRecognitionAvailable(context)) { error("На телефоне не установлена служба распознавания речи"); return }
        cancel(false); base = draft; edit = changed; failure = error
        recognizer = SpeechRecognizer.createSpeechRecognizer(context).apply {
            setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) { recording = true }
                override fun onBeginningOfSpeech() {}
                override fun onRmsChanged(rmsdB: Float) { level = ((rmsdB + 2) / 12).coerceIn(0f, 1f) }
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() { recording = false; finishing = true; timeout() }
                override fun onError(code: Int) { val report = failure; cancel(false)
                    report?.invoke(when(code) { SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "Речь не распознана"
                        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Разрешите доступ к микрофону"
                        else -> "Не удалось распознать речь. Попробуйте снова" }) }
                private fun apply(results: Bundle?) { results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let {
                    edit?.invoke(listOf(base, it).filter(String::isNotBlank).joinToString(" ")) } }
                override fun onResults(results: Bundle?) { apply(results); val done = onComplete; cancel(false); done?.invoke() }
                override fun onPartialResults(partialResults: Bundle?) { apply(partialResults) }
                override fun onEvent(eventType: Int, params: Bundle?) {}
            })
            recording = true
            startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, java.util.Locale.getDefault().toLanguageTag())
            })
        }
    }
    override fun stop(send: (() -> Unit)?) { onComplete = send; recording = false; finishing = true; recognizer?.stopListening(); timeout() }
    private fun timeout() { handler.removeCallbacksAndMessages(null); handler.postDelayed({
        val report = failure; cancel(false); report?.invoke("Распознавание завершено без итогового ответа. Проверьте текст перед отправкой")
    }, 5000) }
    override fun cancel(restore: Boolean) {
        if (restore) edit?.invoke(base)
        handler.removeCallbacksAndMessages(null); recognizer?.cancel(); recognizer?.destroy(); recognizer = null
        recording = false; finishing = false; level = 0f; edit = null; failure = null; onComplete = null
    }
}
