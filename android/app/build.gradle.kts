import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

// The local POC CA's PUBLIC certificate, copied into a generated resource directory for debug builds only.
// The key never leaves ~/.poc-ca. Override the directory with POC_TLS_DIR, as scripts/ios-sim-trust.sh does.
abstract class CopyPocCaTask : DefaultTask() {
    @get:Input abstract val caPath: Property<String>
    @get:OutputDirectory abstract val outputDir: DirectoryProperty

    @TaskAction
    fun copy() {
        val ca = File(caPath.get())
        if (!ca.isFile) {
            throw GradleException("POC CA certificate not found at $ca: run the stack bootstrap (scripts/make-tls.sh) or set POC_TLS_DIR")
        }
        val raw = outputDir.get().asFile.resolve("raw").apply { mkdirs() }
        ca.copyTo(raw.resolve("poc_ca.crt"), overwrite = true)
    }
}

android {
    namespace = "com.aboutobjects.healthgate.probe"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.aboutobjects.healthgate.probe"
        minSdk = 31
        targetSdk = 36
        versionCode = 1
        versionName = "0.1"
    }

    buildTypes {
        release { isMinifyEnabled = false }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures { buildConfig = true }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    implementation(libs.health.connect.client)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    testImplementation(libs.junit)
}

androidComponents {
    onVariants { variant ->
        if (variant.buildType == "debug") {
            val copyPocCa = tasks.register<CopyPocCaTask>("copyPocCa${variant.name.replaceFirstChar { it.uppercase() }}") {
                caPath.set(File(System.getenv("POC_TLS_DIR") ?: "${System.getProperty("user.home")}/.poc-ca", "ca.crt").path)
            }
            variant.sources.res?.addGeneratedSourceDirectory(copyPocCa, CopyPocCaTask::outputDir)
        }
    }
}
