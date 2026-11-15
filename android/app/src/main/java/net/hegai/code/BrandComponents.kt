package net.hegai.code

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.*

/** Separate semantic roles: ordinary Material buttons keep the ink primary. */
object BrandColors {
    val action: Color @Composable get() = if (MaterialTheme.colorScheme.surface.luminance() < .5f) Color(0xFF9E3D4E) else Color(0xFF7A2E3A)
    val onAction = Color.White
    val peach: Color @Composable get() = if (MaterialTheme.colorScheme.surface.luminance() < .5f) Color(0xFF584032) else Color(0xFFF3DECC)
    val onPeach: Color @Composable get() = if (MaterialTheme.colorScheme.surface.luminance() < .5f) Color(0xFFFFDCC4) else Color(0xFF573721)
    val lilac: Color @Composable get() = if (MaterialTheme.colorScheme.surface.luminance() < .5f) Color(0xFF433C53) else Color(0xFFE5DFF3)
    val onLilac: Color @Composable get() = if (MaterialTheme.colorScheme.surface.luminance() < .5f) Color(0xFFE8DDFB) else Color(0xFF45365B)
}

@Composable fun HegaiWordmark(modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    Text(buildAnnotatedString {
        withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = colors.onSurface)) { append("hegai") }
        withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = BrandColors.action)) { append(".") }
        withStyle(SpanStyle(fontWeight = FontWeight.Normal, color = colors.onSurfaceVariant)) { append("code") }
    }, modifier.clearAndSetSemantics { contentDescription = "Hegai Code" }, style = MaterialTheme.typography.titleLarge, letterSpacing = (-.3).sp, maxLines = 1)
}

/** Stable across ordering/reconnects; the identity is machine + project path. */
@Composable fun ProjectAvatar(name: String, identity: String, size: Dp = 40.dp) {
    val peach = identity.hashCode().and(1) == 0
    Surface(Modifier.size(size).clearAndSetSemantics {}, shape = RoundedCornerShape(14.dp, 14.dp, 6.dp, 14.dp),
        color = if (peach) BrandColors.peach else BrandColors.lilac,
        contentColor = if (peach) BrandColors.onPeach else BrandColors.onLilac) {
        Box(contentAlignment = Alignment.Center) { Text(name.firstOrNull { it.isLetterOrDigit() }?.uppercase() ?: "/", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold) }
    }
}

@Composable fun AccountAvatar(name: String, modifier: Modifier = Modifier) {
    Surface(modifier.size(36.dp).clearAndSetSemantics {}, shape = MaterialTheme.shapes.extraLarge, color = BrandColors.action, contentColor = BrandColors.onAction) {
        Box(contentAlignment = Alignment.Center) { Text(name.firstOrNull()?.uppercase() ?: "H", style = MaterialTheme.typography.titleSmall) }
    }
}

/** Decorative vector composition, deliberately outside the accessibility tree. */
@Composable fun ProjectArtwork(modifier: Modifier = Modifier, compact: Boolean = false) {
    val peach = BrandColors.peach
    val lilac = BrandColors.lilac
    val card = if (compact) MaterialTheme.colorScheme.surfaceContainerLowest else HegaiTokens.Ink
    val line = if (compact) MaterialTheme.colorScheme.outlineVariant else HegaiTokens.Ivory.copy(alpha = .45f)
    val ink = if (compact) MaterialTheme.colorScheme.onSurface else HegaiTokens.Ivory
    val accent = BrandColors.action
    BoxWithConstraints(modifier.clearAndSetSemantics {}) {
    val unit = min(maxWidth.value / 300f, maxHeight.value / 215f)
    val fontScale = LocalDensity.current.fontScale
    Canvas(Modifier.matchParentSize()) {
        val scale = min(size.width / 300f, size.height / 215f)
        withTransform({ translate((size.width - 300 * scale) / 2, (size.height - 215 * scale) / 2); scale(scale, scale, Offset.Zero) }) {
            rotate(-10f, Offset(115f, 90f)) {
                drawRoundRect(lilac, Offset(28f, 24f), Size(165f, 137f), CornerRadius(23f))
                drawRoundRect(ink.copy(alpha = .5f), Offset(47f, 47f), Size(39f, 5f), CornerRadius(2f))
            }
            // Soft six-lobed Expressive shape.
            val bloom = Path()
            for (i in 0..120) {
                val angle = i * 2 * PI / 120
                val radius = 44 + 7 * cos(6 * angle)
                val x = 244f + (cos(angle) * radius).toFloat()
                val y = 151f + (sin(angle) * radius).toFloat()
                if (i == 0) bloom.moveTo(x, y) else bloom.lineTo(x, y)
            }
            bloom.close(); drawPath(bloom, peach)
            rotate(5f, Offset(155f, 123f)) {
                drawRoundRect(line.copy(alpha = .15f), Offset(68f, 59f), Size(178f, 134f), CornerRadius(22f))
                drawRoundRect(card, Offset(68f, 57f), Size(178f, 132f), CornerRadius(22f))
                drawCircle(accent, 5f, Offset(88f, 77f))
                if (compact) drawRoundRect(ink.copy(alpha = .7f), Offset(101f, 74f), Size(58f, 5f), CornerRadius(2f))
                // Abstract code/result lines, no fictional progress or content.
                if (compact) drawRoundRect(ink, Offset(88f, 101f), Size(83f, 7f), CornerRadius(3f))
                if (compact) drawRoundRect(ink.copy(alpha = .65f), Offset(88f, 115f), Size(75f, 7f), CornerRadius(3f))
                drawRoundRect(line, Offset(88f, 143f), Size(133f, 4f), CornerRadius(2f))
                drawRoundRect(line, Offset(88f, 154f), Size(108f, 4f), CornerRadius(2f))
                drawRoundRect(line, Offset(88f, 165f), Size(117f, 4f), CornerRadius(2f))
            }
        }
    }
    if (!compact) Column(Modifier.offset(x = ((maxWidth.value - 300 * unit) / 2 + 100 * unit).dp, y = ((maxHeight.value - 215 * unit) / 2 + 72 * unit).dp).width((139 * unit).dp).graphicsLayer { rotationZ = 5f }) {
        Text("hegai.code", color = ink, fontFamily = HegaiTokens.Onest, fontSize = (9 * unit / fontScale).sp, lineHeight = (13 * unit / fontScale).sp)
        Spacer(Modifier.height((14 * unit).dp))
        Text("Есть идея?\nДавайте сделаем.", color = ink, fontFamily = HegaiTokens.Onest, fontWeight = FontWeight.SemiBold, fontSize = (15 * unit / fontScale).sp, lineHeight = (20 * unit / fontScale).sp)
    }
    }
}
