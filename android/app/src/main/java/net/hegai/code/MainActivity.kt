package net.hegai.code

import android.content.Intent
import android.os.Bundle
import androidx.compose.runtime.getValue
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.activity.viewModels

class MainActivity : ComponentActivity() {
    private val model: HubViewModel by viewModels()
    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handleIntent(intent)
        setContent {
            val theme by model.theme.collectAsStateWithLifecycle()
            // Largest system font (Samsung/Android go to 2.0) makes the composer and bars eat the screen:
            // text stays clearly larger than default, layout stays usable.
            val base = androidx.compose.ui.platform.LocalDensity.current
            androidx.compose.runtime.CompositionLocalProvider(androidx.compose.ui.platform.LocalDensity provides androidx.compose.ui.unit.Density(base.density, base.fontScale.coerceAtMost(1.45f))) {
            HegaiTheme(dark = when(theme) { "light" -> false; "dark" -> true; else -> isSystemInDarkTheme() }) {
                HegaiApp(model) { model.beginSignIn(this) }
            }
            }
        }
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); handleIntent(intent) }
    private fun handleIntent(intent: Intent?) {
        intent ?: return
        intent.data?.let(model::authCallback)
        if (intent.action == "net.hegai.code.OPEN_SESSION") model.openNotification(intent.getStringExtra("userId"), intent.getStringExtra("machineId"), intent.getStringExtra("sessionId"), intent.getStringExtra("workspaceId"))
        if (intent.action == Intent.ACTION_SEND || intent.action == Intent.ACTION_SEND_MULTIPLE) {
            val uris = mutableListOf<android.net.Uri>()
            @Suppress("DEPRECATION")
            if (intent.action == Intent.ACTION_SEND_MULTIPLE) uris += intent.getParcelableArrayListExtra<android.net.Uri>(Intent.EXTRA_STREAM).orEmpty()
            else intent.getParcelableExtra<android.net.Uri>(Intent.EXTRA_STREAM)?.let(uris::add)
            model.receiveShare(intent.getStringExtra(Intent.EXTRA_TEXT).orEmpty(), uris)
        }
        // ViewModel owns pending work; recreation must not replay one-shot intents.
        setIntent(Intent(this, MainActivity::class.java))
    }
    override fun onStart() { super.onStart(); model.foreground(true) }
    override fun onStop() { model.foreground(false); super.onStop() }
}
