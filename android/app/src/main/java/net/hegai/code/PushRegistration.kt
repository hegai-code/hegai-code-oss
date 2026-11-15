package net.hegai.code

import android.content.Context
import androidx.work.*
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.*
import net.hegai.code.core.*
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

/** Retry token rotation with network constraints, even while the UI is closed. */
class PushRegistration(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    companion object {
        fun enqueue(context: Context) {
            WorkManager.getInstance(context).enqueueUniqueWork("push-registration", ExistingWorkPolicy.REPLACE,
                OneTimeWorkRequestBuilder<PushRegistration>().setConstraints(Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED).build()).build())
        }
    }
    override suspend fun doWork(): Result {
        val context = applicationContext
        val owner = PushNotifications.owner(context) ?: return Result.success()
        val session = HubSession(context)
        val (hub, credential) = session.bound() ?: return Result.success()
        val device = SessionVault(context, "push-token").read() ?: return Result.success()
        if (!PushNotifications.enabled(context)) return Result.success()
        val client = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).build()
        var socket: WebSocket? = null
        val success = try {
            withTimeoutOrNull(20_000) {
                suspendCancellableCoroutine<Boolean> { continuation ->
                    val finished = java.util.concurrent.atomic.AtomicBoolean(false)
                    fun finish(value: Boolean) { if (finished.compareAndSet(false, true)) continuation.resume(value) }
                    val url = HubUrl.ui(hub).toHttpUrl()
                    var registered = false
                    socket = client.newWebSocket(Request.Builder().url(url).header("Authorization", "Bearer $credential").build(), object : WebSocketListener() {
                        override fun onMessage(webSocket: WebSocket, text: String) {
                            if (owner != PushNotifications.owner(context) || credential != session.bound()?.takeIf { it.hub == hub }?.token || !PushNotifications.enabled(context)) { finish(true); return }
                            val value = runCatching { wireJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
                            when (value.string("type")) {
                                "snapshot" -> {
                                    val viewer = value.objectValue("viewer")
                                    if (viewer?.string("userId") != owner || viewer.objectValue("access")?.string("state").let { it != null && it != "active" }) { finish(true); return }
                                    if (registered) { finish(true); return }
                                    registered = webSocket.send(frame("register_push") { put("deviceToken", device); put("platform", "android") }.toString())
                                    // pause/resume queues a fresh snapshot after the preceding registration.
                                    webSocket.send(frame("pause").toString())
                                    webSocket.send(frame("resume").toString())
                                }
                                "error" -> finish(false)
                            }
                        }
                        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { response?.close(); finish(response?.code in listOf(401, 403)) }
                        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { finish(false) }
                    })
                    continuation.invokeOnCancellation { socket?.cancel() }
                }
            } == true
        } finally { socket?.close(1000, null); client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
        // A customer hub may have no FCM at all: a few quiet retries, then give up instead of retrying forever.
        return if (success || !HubUrl.isDefault(hub) && runAttemptCount >= 4) Result.success() else Result.retry()
    }
}
