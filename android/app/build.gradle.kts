import java.util.Properties

plugins {
    id("com.android.application")
    kotlin("android")
    id("org.jetbrains.kotlin.plugin.compose")
}
val firebaseConfig = Properties().apply {
    val local = rootProject.file("firebase.properties")
    if (local.exists()) local.inputStream().use { load(it) }
}
fun firebaseValue(key: String): String = "\"" + (System.getenv(key) ?: firebaseConfig.getProperty(key, "")).replace("\\", "\\\\").replace("\"", "\\\"") + "\""

val releaseConfig = Properties().apply {
    val path = System.getenv("HEGAI_ANDROID_SIGNING_PROPERTIES")
    if (!path.isNullOrBlank()) file(path).inputStream().use { load(it) }
}

android {
    namespace = "net.hegai.code"
    compileSdk = 36
    defaultConfig {
        applicationId = "net.hegai.code"
        minSdk = 26
        targetSdk = 36
        buildConfigField("String", "FIREBASE_APP_ID", firebaseValue("FIREBASE_APP_ID"))
        buildConfigField("String", "FIREBASE_API_KEY", firebaseValue("FIREBASE_API_KEY"))
        buildConfigField("String", "FIREBASE_PROJECT_ID", firebaseValue("FIREBASE_PROJECT_ID"))
        buildConfigField("String", "FIREBASE_SENDER_ID", firebaseValue("FIREBASE_SENDER_ID"))
        versionCode = 26
        versionName = "1.0.6"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    signingConfigs {
        if (releaseConfig.isNotEmpty()) create("distribution") {
            storeFile = file(releaseConfig.getProperty("storeFile"))
            storePassword = releaseConfig.getProperty("storePassword")
            keyAlias = releaseConfig.getProperty("keyAlias")
            keyPassword = releaseConfig.getProperty("keyPassword")
        }
    }
    buildTypes {
        debug { applicationIdSuffix = ".debug"; versionNameSuffix = "-dev" }
        release { isMinifyEnabled = false; signingConfig = signingConfigs.findByName("distribution") }
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}
dependencies {
    implementation(project(":core"))
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    implementation("com.google.firebase:firebase-messaging:24.0.2")
    implementation("androidx.browser:browser:1.8.0")
    // Google code scanner (private-machine pairing QR): a system dialog, so the app needs no CAMERA permission and never sees a frame.
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
    implementation("io.noties.markwon:core:4.6.2")
    implementation("io.noties.markwon:ext-tables:4.6.2")
    implementation("io.noties.markwon:ext-strikethrough:4.6.2")
    implementation("androidx.exifinterface:exifinterface:1.3.7")
    implementation(platform("androidx.compose:compose-bom:2026.06.00"))
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.core:core-splashscreen:1.2.0")
    // Material 3 Expressive (MotionScheme, ButtonGroup, flexible top bars, loading indicators) ships only in 1.5 alpha; alpha18 is the last on Compose 1.11 — alpha19+ needs compileSdk 37 and AGP 9.1.
    implementation("androidx.compose.material3:material3:1.5.0-alpha18")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.4")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    androidTestImplementation(platform("androidx.compose:compose-bom:2026.06.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
