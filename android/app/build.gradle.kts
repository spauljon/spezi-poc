import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
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
    namespace = "com.aboutobjects.healthgate"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.aboutobjects.healthgate"
        minSdk = 31
        targetSdk = 36
        versionCode = 1
        versionName = "0.1"
        // AppAuth's redirect scheme: the android-capture client's redirect URI is "<scheme>:/oauth2redirect" (idp/realm/poc-realm.json)
        manifestPlaceholders["appAuthRedirectScheme"] = "com.aboutobjects.healthgate.android"
        // The developer's Mac: its mDNS name by default; override with -Phealthgate.host=... or in ~/.gradle/gradle.properties (never a secret).
        buildConfigField("String", "SERVER_HOST", "\"${providers.gradleProperty("healthgate.host").orNull ?: "macpro16.local"}\"")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release { isMinifyEnabled = false }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }

    // The queue's behaviour is specified once (src/sharedTest) and run against the in-memory fake on the JVM and the SQLite queue on the phone.
    sourceSets {
        getByName("test").java.srcDir("src/sharedTest/kotlin")
        getByName("androidTest").java.srcDir("src/sharedTest/kotlin")
    }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.core.ktx)
    implementation(libs.appauth)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    androidTestImplementation(libs.junit)
    androidTestImplementation(libs.kotlinx.serialization.json)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
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
