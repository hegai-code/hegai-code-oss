package net.hegai.code

import android.Manifest
import android.app.*
import android.content.*
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import net.hegai.code.core.*
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class HegaiApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        if (BuildConfig.FIREBASE_APP_ID.isNotBlank()) FirebaseApp.initializeApp(this, FirebaseOptions.Builder()
            .setApplicationId(BuildConfig.FIREBASE_APP_ID).setApiKey(BuildConfig.FIREBASE_API_KEY)
            .setProjectId(BuildConfig.FIREBASE_PROJECT_ID).setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID).build())
        PushNotifications.channel(this)
    }
}
object PushNotifications {
    const val CHANNEL = "session-attention"
    fun available(context: Context) = FirebaseApp.getApps(context).isNotEmpty()
    fun enabled(context: Context) = context.getSharedPreferences("appearance", 0).getBoolean("notifications", false) &&
        (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
    fun channel(context: Context) {
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL, "Сессии и ответы", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Завершение работы, ошибки и вопросы агента"; lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        })
    }
    fun owner(context: Context) = SessionVault(context, "push-owner").read()
    /** Private machine ids the app last saw in a snapshot (written by HubViewModel): the fallback when a push lacks the flag. */
    fun cachedPrivate(context: Context, machineId: String): Boolean =
        runCatching { (wireJson.parseToJsonElement(SessionVault(context, "private-machines").read() ?: "[]") as JsonArray).any { it.jsonPrimitive.content == machineId } }.getOrDefault(false)
    fun display(context: Context, data: Map<String, String>) {
        if (!enabled(context) || data["userId"] != owner(context) || HubSession(context).bound() == null) return
        val runId = data["runId"]?.takeIf { it.length <= 200 } ?: return
        val open = Intent(context, MainActivity::class.java).apply {
            action = "net.hegai.code.OPEN_SESSION"
            putExtra("workspaceId", data["workspaceId"]); putExtra("machineId", data["machineId"]); putExtra("sessionId", data["sessionId"]); putExtra("userId", data["userId"])
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val content = PendingIntent.getActivity(context, runId.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val text = when(data["state"]) { "needs_attention" -> "Нужен ваш ответ"; "error" -> "В сессии произошла ошибка"; else -> "Работа завершена" }
        val builder = NotificationCompat.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(data["title"]?.take(180) ?: "Hegai Code").setContentText(text)
            .setAutoCancel(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setContentIntent(content)
        // A machine with a key takes decisions only sealed, from inside the app: no one-tap action from a notification.
        // `private` comes from the hub's payload; the cached machine snapshot (restored account cache) is the fallback for an older hub.
        val keyed = data["machineId"]?.let { E2eeStore.get(context).has(it) } == true || data["private"] == "true" ||
            (data["private"] == null && data["machineId"]?.let { PushNotifications.cachedPrivate(context, it) } == true)
        if (data["state"] == "needs_attention" && !data["requestId"].isNullOrBlank() && data["tool"] !in listOf("AskUserQuestion", "ExitPlanMode") && !keyed) {
            listOf(true to "Разрешить", false to "Отклонить").forEach { (allow, label) ->
                val intent = Intent(context, PushActionReceiver::class.java).apply {
                    action = "net.hegai.code.DECISION"; putExtra("runId", runId); putExtra("requestId", data["requestId"])
                    putExtra("userId", data["userId"]); putExtra("workspaceId", data["workspaceId"]); putExtra("allow", allow)
                }
                val pending = PendingIntent.getBroadcast(context, "$runId:${data["requestId"]}:$allow".hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                if (Build.VERSION.SDK_INT >= 31 && hasAIConsent(context, data["userId"].orEmpty())) builder.addAction(NotificationCompat.Action.Builder(0, label, pending).setAuthenticationRequired(true).build())
                else builder.addAction(0, "$label в приложении", content)
            }
        }
        // Android 13+ may revoke POST_NOTIFICATIONS at any time: check, then still guard the call.
        if (Build.VERSION.SDK_INT >= 33 && androidx.core.content.ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) return
        try { NotificationManagerCompat.from(context).notify(runId.hashCode(), builder.build()) } catch (_: SecurityException) {}
    }
}
class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) { SessionVault(this, "push-token").write(token); PushRegistration.enqueue(this) }
    override fun onMessageReceived(message: RemoteMessage) { PushNotifications.display(this, message.data) }
}

/** Explicit, non-exported action. Re-authenticate and match the live request before sending. */
class PushActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (context.getSystemService(KeyguardManager::class.java).isDeviceLocked) return
        val owner = intent.getStringExtra("userId") ?: return
        if (owner != PushNotifications.owner(context)) return
        if (!hasAIConsent(context, owner)) return
        val (hub, token) = HubSession(context).bound() ?: return
        val run = intent.getStringExtra("runId") ?: return
        val request = intent.getStringExtra("requestId") ?: return
        val pending = goAsync()
        val http = OkHttpClient.Builder().connectTimeout(5, TimeUnit.SECONDS).readTimeout(8, TimeUnit.SECONDS).build()
        val finished = AtomicBoolean(false)
        var socket: WebSocket? = null
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        fun finish(success: Boolean) {
            if (!finished.compareAndSet(false, true)) return
            socket?.close(1000, null)
            if (success) NotificationManagerCompat.from(context).cancel(run.hashCode())
            http.connectionPool.evictAll(); http.dispatcher.executorService.shutdown(); pending.finish()
        }
        handler.postDelayed({ finish(false) }, 9000)
        val url = HubUrl.ui(hub).toHttpUrl().newBuilder().apply { intent.getStringExtra("workspaceId")?.takeIf(String::isNotBlank)?.let { addQueryParameter("workspaceId", it) } }.build()
        var sent = false
        socket = http.newWebSocket(Request.Builder().url(url).header("Authorization", "Bearer $token").build(), object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (finished.get() || owner != PushNotifications.owner(context)) { finish(false); return }
                val value = runCatching { wireJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
                when(value.string("type")) {
                    "snapshot" -> {
                        val viewer = value.objectValue("viewer")
                        if (viewer?.string("userId") != owner || viewer.objectValue("access")?.string("state").let { it != null && it != "active" }) { finish(false); return }
                        // A private machine takes decisions only sealed (docs/E2EE.md): answer in the app, never from here.
                        val machine = (value["activeRuns"] as? JsonArray).orEmpty().firstNotNullOfOrNull { (it as? JsonObject)?.takeIf { r -> r.string("runId") == run }?.string("machineId") }
                        val privateMachine = machine == null || (value["machines"] as? JsonArray).orEmpty().any { m -> (m as? JsonObject)?.objectValue("machine")?.let { info -> info.string("machineId") == machine && (info["private"] as? JsonPrimitive)?.booleanOrNull == true } == true } || E2eeStore.get(context).has(machine)
                        if (privateMachine) { finish(false); return }
                        webSocket.send(frame("subscribe") { put("runId", run) }.toString())
                    }
                    "tool_request" -> if (!sent && value.string("runId") == run && value.string("requestId") == request && value.string("tool") !in listOf("AskUserQuestion", "ExitPlanMode")) {
                        if (!hasAIConsent(context, owner)) { finish(false); return }
                        sent = true
                        webSocket.send(frame("tool_decision") { put("runId", run); put("requestId", request); put("allow", intent.getBooleanExtra("allow", false)) }.toString())
                    }
                    "tool_resolved" -> if (sent && value.string("runId") == run && value.string("requestId") == request) finish(true)
                    "error" -> finish(false)
                }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { response?.close(); finish(false) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { finish(false) }
        })
    }
}
