plugins { kotlin("jvm"); kotlin("plugin.serialization") }
kotlin { jvmToolchain(17) }
dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    testImplementation("junit:junit:4.13.2")
}


tasks.test { systemProperty("hegai.frames", layout.buildDirectory.file("protocol-frames.json").get().asFile.absolutePath) }
