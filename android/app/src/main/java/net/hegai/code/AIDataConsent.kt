package net.hegai.code

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.serialization.json.jsonObject
import net.hegai.code.core.string
import net.hegai.code.core.wireJson

/** Read again for notification actions: consent can be revoked while the app is closed. */
internal fun hasAIConsent(context: android.content.Context, user: String): Boolean = runCatching {
    val key = java.security.MessageDigest.getInstance("SHA-256").digest(user.toByteArray()).joinToString("") { "%02x".format(it) }
    wireJson.parseToJsonElement(SessionVault(context, "ai-consent").read() ?: "{}").jsonObject.string(key) == "2026-09-26"
}.getOrDefault(false)

@Composable fun AIDataConsentDialog(model: HubViewModel) {
    val show by model.consentDialog.collectAsStateWithLifecycle()
    var error by remember { mutableStateOf<String?>(null) }
    if (!show) return
    AlertDialog(onDismissRequest = model::closeConsentDialog, title = { Text("Как используются данные") },
        text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Для выполнения задачи сообщения, изображения, выбранный код и контекст чата передаются хабу и подключённому компьютеру, затем настроенному AI-провайдеру.")
            Text("Claude Code использует Anthropic. Codex — OpenAI или провайдера компьютера/шлюза. Заголовки, подсказки и обработка диктовки используют сервисы AI хаба. При распознавании на телефоне данные может обрабатывать служба Android.")
            Text("Данные нужны для ответов, выполнения команд, сжатия контекста, заголовков и диктовки. Условия хранения зависят от провайдера и настроек аккаунта.")
            Text("Без согласия можно читать историю и останавливать работу. Согласие можно отозвать в настройках; это остановит новые запросы из приложения, но не уже запущенную работу на компьютере.")
            ErrorNote(error)
        } },
        confirmButton = { TextButton({ runCatching { model.setAIConsent(true) }.onFailure { error = "Не удалось сохранить согласие" } }) { Text("Разрешить передачу данных AI") } },
        dismissButton = { TextButton(model::closeConsentDialog) { Text("Не сейчас") } })
}
