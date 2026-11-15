package net.hegai.code

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import android.util.Base64
import androidx.exifinterface.media.ExifInterface
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import net.hegai.code.core.ImageInput

object Attachments {
    fun read(context: Context, uri: Uri): ImageInput {
        require(uri.scheme == "content") { "Выберите изображение через системное меню" }
        val bytes = context.contentResolver.openInputStream(uri)?.use { input ->
            val output = ByteArrayOutputStream(); val buffer = ByteArray(16_384)
            while (true) { val count = input.read(buffer); if (count < 0) break
                require(output.size() + count <= 24_000_000) { "Исходное изображение больше 24 МБ" }; output.write(buffer, 0, count) }
            output.toByteArray()
        } ?: error("Файл недоступен")
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        require(bounds.outWidth > 0 && bounds.outHeight > 0) { "Файл не является изображением" }
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 2048) sample *= 2
        var bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: error("Не удалось прочитать изображение")
        val orientation = runCatching { ExifInterface(ByteArrayInputStream(bytes)).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1) }.getOrDefault(1)
        val matrix = Matrix().apply { when (orientation) {
            2 -> setScale(-1f, 1f); 3 -> setRotate(180f); 4 -> setScale(1f, -1f)
            5 -> { setRotate(90f); postScale(-1f, 1f) }; 6 -> setRotate(90f)
            7 -> { setRotate(270f); postScale(-1f, 1f) }; 8 -> setRotate(270f)
        } }
        if (!matrix.isIdentity) {
            val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
            if (rotated !== bitmap) bitmap.recycle(); bitmap = rotated
        }
        val max = maxOf(bitmap.width, bitmap.height)
        if (max > 1568) { val scaled = Bitmap.createScaledBitmap(bitmap, bitmap.width * 1568 / max, bitmap.height * 1568 / max, true)
            if (scaled !== bitmap) bitmap.recycle(); bitmap = scaled }
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 85, out); bitmap.recycle()
        require(out.size() <= 2_000_000) { "Изображение слишком большое после сжатия" }
        return ImageInput("image/jpeg", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
    }
}
