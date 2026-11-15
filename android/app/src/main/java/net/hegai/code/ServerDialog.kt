package net.hegai.code

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import net.hegai.code.core.HubUrl

/**
 * «Сервер»: the hub this phone talks to. Customers who run their own hub set it here — before signing
 * in (login screen) or later (Settings). The address is only saved once the hub answers `/health`.
 */
@Composable fun HubServerDialog(model: HubViewModel, signedIn: Boolean, dismiss: () -> Unit) {
    val current by model.hubBase.collectAsStateWithLifecycle()
    var input by rememberSaveable { mutableStateOf(HubUrl.label(current)) }
    var busy by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val submit = {
        busy = true; failure = null
        scope.launch {
            val message = model.switchHub(input)
            busy = false
            if (message == null) dismiss() else failure = message
        }
        Unit
    }
    AlertDialog(onDismissRequest = { if (!busy) dismiss() },
        title = { Text("Сервер") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Адрес вашего сервера Hegai Code. По умолчанию — ${HubUrl.label(HubUrl.DEFAULT)}.", style = MaterialTheme.typography.bodyMedium)
                OutlinedTextField(input, { input = it.take(253) }, Modifier.fillMaxWidth(), label = { Text("Адрес") },
                    placeholder = { Text("hub.example.com") }, singleLine = true, enabled = !busy,
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Uri))
                if (signedIn) Text("При смене сервера вы выйдете из аккаунта на этом телефоне.", style = MaterialTheme.typography.bodyMedium)
                failure?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 4.dp))
            }
        },
        confirmButton = { TextButton(submit, enabled = !busy && input.isNotBlank()) { Text("Проверить и сохранить") } },
        dismissButton = { TextButton(dismiss, enabled = !busy) { Text("Отмена") } })
}
