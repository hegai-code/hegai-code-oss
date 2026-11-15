package net.hegai.code

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.*
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.shape.RoundedCornerShape

// Android Material 3 Expressive canon: android/DESIGN.md. Keep light/dark roles paired.
object HegaiTokens {
    val Space = 8.dp
    val Gutter = 16.dp
    val Card = RoundedCornerShape(20.dp)
    val Control = RoundedCornerShape(12.dp)
    val Onest = FontFamily(Font(R.font.onest_regular), Font(R.font.onest_medium, FontWeight.Medium), Font(R.font.onest_semibold, FontWeight.SemiBold))
    val Mono = FontFamily(Font(R.font.ibm_plex_mono))
    /** Human plate and folded-code radius (iOS Theme.radiusLg / radiusSm). */
    val Plate = RoundedCornerShape(16.dp)
    val Square = RoundedCornerShape(4.dp)
    // Tool squares answer «with consequences?» — iOS ToolTone: read = green + ivory,
    // act = ember + INK (ivory on ember is 2.7:1), fail = red + ivory, unknown = faint grey.
    val Green = Color(0xFF06463D)
    val Ivory = Color(0xFFFCFAF1)
    val Ink = Color(0xFF101F18)
    fun attn(dark: Boolean) = if (dark) Color(0xFFFF7F57) else Color(0xFFFF6A3D)
    fun red(dark: Boolean) = if (dark) Color(0xFFB4322A) else Color(0xFFBD3223)
    // a.test palette mapped onto the full Material 3 role set: Expressive surfaces are built from the
    // surfaceContainer ladder, so every rung is defined (a missing rung falls back to Material purple).
    val Light = lightColorScheme(
        primary = Color(0xFF101F18), onPrimary = Color(0xFFFCFAF1),
        primaryContainer = Color(0xFFE3E8E5), onPrimaryContainer = Color(0xFF101F18),
        secondary = Color(0xFF3F4A44), onSecondary = Color(0xFFFCFAF1),
        secondaryContainer = Color(0xFFE3E6E3), onSecondaryContainer = Color(0xFF101F18),
        tertiary = Color(0xFFB2431F), onTertiary = Color(0xFFFFFFFF),
        tertiaryContainer = Color(0xFFFFDBCD), onTertiaryContainer = Color(0xFF3A0B00),
        background = Color(0xFFF6F7F6), onBackground = Color(0xFF101F18),
        surface = Color(0xFFF6F7F6), onSurface = Color(0xFF101F18),
        surfaceVariant = Color(0xFFE6E9E6), onSurfaceVariant = Color(0xFF55605A),
        surfaceContainerLowest = Color(0xFFFFFFFF), surfaceContainerLow = Color(0xFFFBFCFB),
        surfaceContainer = Color(0xFFF0F2F0), surfaceContainerHigh = Color(0xFFEAEDEA), surfaceContainerHighest = Color(0xFFE3E6E3),
        surfaceBright = Color(0xFFFFFFFF), surfaceDim = Color(0xFFDADDDA),
        outline = Color(0xFF79827D), outlineVariant = Color(0xFFD3D8D4),
        inverseSurface = Color(0xFF1F2522), inverseOnSurface = Color(0xFFEFF1EF), inversePrimary = Color(0xFFB9CCC2),
        error = Color(0xFFBD3223), onError = Color(0xFFFFFFFF), errorContainer = Color(0xFFFFE4DA), onErrorContainer = Color(0xFF410002),
        scrim = Color(0xFF000000),
    )
    val Dark = darkColorScheme(
        primary = Color(0xFFECEEED), onPrimary = Color(0xFF101F18),
        primaryContainer = Color(0xFF1F3A31), onPrimaryContainer = Color(0xFFD6EADF),
        secondary = Color(0xFFC3CCC6), onSecondary = Color(0xFF1C2420),
        secondaryContainer = Color(0xFF2C3234), onSecondaryContainer = Color(0xFFFCFAF1),
        tertiary = Color(0xFFFF9C7A), onTertiary = Color(0xFF3A0B00),
        tertiaryContainer = Color(0xFF5C2413), onTertiaryContainer = Color(0xFFFFDBCD),
        background = Color(0xFF161819), onBackground = Color(0xFFECEEED),
        surface = Color(0xFF161819), onSurface = Color(0xFFECEEED),
        surfaceVariant = Color(0xFF2A2E2F), onSurfaceVariant = Color(0xFFB4B4AC),
        surfaceContainerLowest = Color(0xFF222627), surfaceContainerLow = Color(0xFF1B1E1F),
        surfaceContainer = Color(0xFF222627), surfaceContainerHigh = Color(0xFF2B3031), surfaceContainerHighest = Color(0xFF353B3C),
        surfaceBright = Color(0xFF323637), surfaceDim = Color(0xFF161819),
        outline = Color(0xFF8A918D), outlineVariant = Color(0xFF3A3F40),
        inverseSurface = Color(0xFFE3E6E3), inverseOnSurface = Color(0xFF1F2522), inversePrimary = Color(0xFF3F5C51),
        error = Color(0xFFFF8577), onError = Color(0xFF410002), errorContainer = Color(0xFF402318), onErrorContainer = Color(0xFFFFDAD4),
        scrim = Color(0xFF000000),
    )
}
/** Material 3 Expressive: spring motion (MotionScheme.expressive), the Expressive shape scale and the full
 * type scale — every style, including the emphasized ones, set in Onest (Material's own face would
 * otherwise show wherever a component picks a style we did not name). */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable fun HegaiTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialExpressiveTheme(colorScheme = if (dark) HegaiTokens.Dark else HegaiTokens.Light,
        motionScheme = MotionScheme.expressive(), typography = OnestTypography, content = content)
}

// Onest is set wider than Roboto: Material's tracking (0.5sp on body) makes Cyrillic look loose, so body
// and titles run at 0 and labels keep a hair of tracking.
private fun TextStyle.onest() = copy(fontFamily = HegaiTokens.Onest, letterSpacing = if (letterSpacing.value > 0.2f) 0.1.sp else 0.sp)
private val OnestTypography: Typography = Typography().let { t ->
    Typography(
        displayLarge = t.displayLarge.onest(), displayMedium = t.displayMedium.onest(), displaySmall = t.displaySmall.onest(),
        headlineLarge = t.headlineLarge.onest(), headlineMedium = t.headlineMedium.onest(), headlineSmall = t.headlineSmall.onest(),
        titleLarge = t.titleLarge.onest(), titleMedium = t.titleMedium.onest(), titleSmall = t.titleSmall.onest(),
        bodyLarge = t.bodyLarge.onest(), bodyMedium = t.bodyMedium.onest(), bodySmall = t.bodySmall.onest(),
        labelLarge = t.labelLarge.onest(), labelMedium = t.labelMedium.onest(), labelSmall = t.labelSmall.onest(),
        displayLargeEmphasized = t.displayLargeEmphasized.onest(), displayMediumEmphasized = t.displayMediumEmphasized.onest(), displaySmallEmphasized = t.displaySmallEmphasized.onest(),
        headlineLargeEmphasized = t.headlineLargeEmphasized.onest(), headlineMediumEmphasized = t.headlineMediumEmphasized.onest(), headlineSmallEmphasized = t.headlineSmallEmphasized.onest(),
        titleLargeEmphasized = t.titleLargeEmphasized.onest(), titleMediumEmphasized = t.titleMediumEmphasized.onest(), titleSmallEmphasized = t.titleSmallEmphasized.onest(),
        bodyLargeEmphasized = t.bodyLargeEmphasized.onest(), bodyMediumEmphasized = t.bodyMediumEmphasized.onest(), bodySmallEmphasized = t.bodySmallEmphasized.onest(),
        labelLargeEmphasized = t.labelLargeEmphasized.onest(), labelMediumEmphasized = t.labelMediumEmphasized.onest(), labelSmallEmphasized = t.labelSmallEmphasized.onest(),
    )
}
