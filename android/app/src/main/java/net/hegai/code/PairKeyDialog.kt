package net.hegai.code

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning

/** What the pairing dialog is for: the machine the person is looking at, if any. */
data class PairRequest(val machineId: String?, val machineName: String? = null)

/**
 * «Ввести код пары» (web/src/components/PairKeyDialog.tsx): pairs this phone with a private machine. The code is the
 * machine's key (`hcp1.<machine>.<key>`, printed by `--pair` as text and QR). Two ways in: the Google code scanner
 * (a system dialog; the app needs no camera permission and sees no image) or paste. «Забыть ключ» when it holds one.
 */
@Composable fun PairKeyDialog(model: HubViewModel) {
    val request by model.pairRequest.collectAsStateWithLifecycle()
    val keyed by model.e2ee.machines.collectAsStateWithLifecycle()
    val req = request ?: return
    val context = LocalContext.current
    var code by remember(req) { mutableStateOf("") }
    var error by remember(req) { mutableStateOf<String?>(null) }
    var busy by remember(req) { mutableStateOf(false) }
    val holds = req.machineId != null && req.machineId in keyed
    fun submit(value: String) {
        busy = true; error = null
        model.pair(value, req.machineId) { problem -> busy = false; error = problem }
    }
    fun scan() {
        error = null
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).enableAutoZoom().build()
        GmsBarcodeScanning.getClient(context, options).startScan()
            .addOnSuccessListener { barcode -> barcode.rawValue?.let { code = it; submit(it) } ?: run { error = "В QR нет текста. Вставьте код вручную." } }
            .addOnCanceledListener { }
            .addOnFailureListener { error = "Сканер недоступен на этом телефоне (нужны сервисы Google Play). Вставьте код вручную." }
    }
    AlertDialog(
        onDismissRequest = { if (!busy) model.closePair() },
        icon = { Icon(Icons.Outlined.Lock, null) },
        title = { Text("Код пары" + (req.machineName?.let { " · $it" } ?: "")) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Сессии этой машины зашифрованы: сервер хранит и передаёт их, но прочитать не может. Выполните на машине node agent.mjs --pair и отсканируйте QR или вставьте код. Кто видит код, тот читает сессии — не пересылайте его открытым текстом.", style = MaterialTheme.typography.bodyMedium)
                OutlinedButton({ scan() }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Outlined.QrCodeScanner, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("Сканировать QR")
                }
                OutlinedTextField(code, { code = it }, label = { Text("Код") }, placeholder = { Text("hcp1.…") }, singleLine = true, enabled = !busy,
                    isError = error != null, supportingText = error?.let { { Text(it) } }, modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false))
                if (holds) Row(verticalAlignment = Alignment.CenterVertically) {
                    TextButton({ model.forgetKey(req.machineId!!) }, enabled = !busy) { Text("Забыть ключ этой машины") }
                }
            }
        },
        confirmButton = { TextButton({ submit(code) }, enabled = !busy && code.isNotBlank()) { Text("Сохранить ключ") } },
        dismissButton = { TextButton({ model.closePair() }, enabled = !busy) { Text("Отмена") } },
    )
}
