package net.hegai.code

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import net.hegai.code.core.*

sealed interface TelegramPhase {
    data class Starting(val link: Boolean) : TelegramPhase
    data class Waiting(val login: TelegramLogin, val link: Boolean) : TelegramPhase
    data class Confirm(val login: TelegramLogin, val telegram: String) : TelegramPhase
    data object Linking : TelegramPhase
    data class Failed(val message: String, val link: Boolean) : TelegramPhase
}

@Composable fun TelegramDialog(model: HubViewModel) {
    val phase by model.telegram.collectAsStateWithLifecycle()
    val current = phase ?: return
    val context = LocalContext.current
    var openError by remember { mutableStateOf<String?>(null) }
    AlertDialog(onDismissRequest = { if (current != TelegramPhase.Linking) model.closeTelegram() },
        title = { Text(if (current is TelegramPhase.Starting && !current.link || current is TelegramPhase.Waiting && !current.link || current is TelegramPhase.Failed && !current.link) "Вход через Telegram" else "Привязка Telegram") },
        text = { Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
            when (current) {
                is TelegramPhase.Starting -> { CircularProgressIndicator(); Text("Готовим вход…") }
                is TelegramPhase.Waiting -> {
                    Text("Откройте бота @${current.login.bot} и нажмите в нём это число:")
                    Text(current.login.match, style = MaterialTheme.typography.displayLarge)
                    Button({ runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(current.login.safeLink))) }
                        .onFailure { openError = "Не удалось открыть Telegram. Установите Telegram или браузер." } }) { Text("Открыть Telegram") }
                    Text("Ждём подтверждения в Telegram…")
                }
                is TelegramPhase.Confirm -> Text("В Telegram подтвердил ${current.telegram}. Это ваш аккаунт? После привязки через него можно будет входить в эту учётку.")
                TelegramPhase.Linking -> { CircularProgressIndicator(); Text("Привязываем…") }
                is TelegramPhase.Failed -> Text(current.message)
            }
            ErrorNote(openError)
        } },
        confirmButton = { when (current) {
            is TelegramPhase.Confirm -> TextButton(model::confirmTelegramLink) { Text("Да, привязать") }
            is TelegramPhase.Failed -> TextButton({ model.startTelegram(current.link) }) { Text("Начать заново") }
            else -> Unit
        } },
        dismissButton = { TextButton(model::closeTelegram, enabled = current != TelegramPhase.Linking) { Text(if (current is TelegramPhase.Confirm) "Нет, не мой" else "Отмена") } })
}

@Composable fun TelegramAccountBanner(model: HubViewModel, userId: String?) {
    val memo by model.telegramMemo.collectAsStateWithLifecycle()
    val value = memo ?: return
    LaunchedEffect(userId, value) { if (userId != null && value.string("userId") != userId) model.forgetTelegramMemo() }
    if (userId != null && value.string("userId") != userId) return
    Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth().padding(12.dp)) {
        Column(Modifier.padding(16.dp)) {
            Text("Вы вошли через Telegram как ${value.string("telegram").orEmpty()} · ${value.string("name").orEmpty()}")
            Row { TextButton(model::logout) { Text("Это не я — выйти") }; TextButton(model::forgetTelegramMemo) { Text("Понятно") } }
        }
    }
}

@Composable fun SignInMethods(model: HubViewModel, active: Boolean) {
    val revision by model.identityRevision.collectAsStateWithLifecycle()
    var response by remember { mutableStateOf<Identities?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var attempt by remember { mutableIntStateOf(0) }
    var unlink by remember { mutableStateOf<LinkedIdentity?>(null) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    LaunchedEffect(revision, attempt) {
        try { response = wireJson.decodeFromJsonElement(model.api("/api/me/identities")); error = null }
        catch (e: Exception) { error = identityError(e.message) }
    }
    Section("Способы входа") {
        response?.let { data ->
            data.identities.forEach { identity ->
                Row(Modifier.fillMaxWidth()) {
                    Column(Modifier.weight(1f)) { Text(identity.name); identity.label?.let { Text(it, style = MaterialTheme.typography.bodySmall) } }
                    TextButton({ unlink = identity }, enabled = !busy && data.identities.size > 1) { Text("Отвязать") }
                }
            }
            if (data.identities.size == 1) Text("Последний способ входа можно отвязать после добавления другого.", style = MaterialTheme.typography.bodySmall)
            if (data.available.telegram && data.identities.none { it.provider == "telegram" }) OutlinedButton({ model.startTelegram(true) }, enabled = active && !busy) { Text("Привязать Telegram") }
            if (data.available.google && data.identities.none { it.provider == "google" }) OutlinedButton({ busy = true; scope.launch {
                try { model.linkGoogle(context) } catch (e: Exception) { error = identityError(e.message) } finally { busy = false }
            } }, enabled = active && !busy) { Text("Привязать Google") }
        }
        ErrorNote(error)
        if (response == null) TextButton({ attempt++ }) { Text("Обновить") }
    }
    unlink?.let { identity -> AlertDialog(onDismissRequest = { if (!busy) unlink = null },
        title = { Text("Отвязать ${identity.name}?") }, text = { Text("Через ${identity.label ?: identity.name} больше нельзя будет войти в эту учётку.") },
        confirmButton = { TextButton({ busy = true; scope.launch {
            try { model.api("/api/me/identities/unlink", "POST", buildJsonObject { put("provider", identity.provider); put("subject", identity.subject) }); unlink = null; attempt++ }
            catch (e: Exception) { error = identityError(e.message); unlink = null } finally { busy = false }
        } }, enabled = !busy) { Text("Отвязать") } },
        dismissButton = { TextButton({ unlink = null }, enabled = !busy) { Text("Отмена") } }) }
}
