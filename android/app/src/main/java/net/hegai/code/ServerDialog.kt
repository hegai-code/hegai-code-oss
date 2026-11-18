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
import net.hegai.code.core.HubLink
import net.hegai.code.core.HubUrl
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.ui.platform.LocalContext
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning

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
    val context = LocalContext.current
    fun scan() {
        failure = null
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).enableAutoZoom().build()
        GmsBarcodeScanning.getClient(context, options).startScan()
            .addOnSuccessListener { barcode ->
                val hub = barcode.rawValue?.let(HubLink::parse)
                if (hub != null) input = HubUrl.label(hub) else failure = "Это не адрес сервера Hegai Code"
            }
            .addOnCanceledListener { }
            .addOnFailureListener { failure = "Сканер недоступен на этом телефоне (нужны сервисы Google Play). Введите адрес вручную." }
    }
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
                OutlinedButton({ scan() }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Outlined.QrCodeScanner, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("Сканировать QR-код")
                }
                if (signedIn) Text("При смене сервера вы выйдете из аккаунта на этом телефоне.", style = MaterialTheme.typography.bodyMedium)
                failure?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 4.dp))
            }
        },
        confirmButton = { TextButton(submit, enabled = !busy && input.isNotBlank()) { Text("Проверить и сохранить") } },
        dismissButton = { TextButton(dismiss, enabled = !busy) { Text("Отмена") } })
}
