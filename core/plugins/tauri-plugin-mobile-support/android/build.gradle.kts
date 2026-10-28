plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.novelist.mobilesupport"
    compileSdk = 36

    defaultConfig {
        // Matches the app (tauri.android.conf.json); Keystore AES-GCM needs >= 23.
        minSdk = 26
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    // core: FileProvider; appcompat: ActivityResult (same set as Tauri's official plugins).
    implementation("androidx.core:core-ktx:1.9.0")
    implementation("androidx.appcompat:appcompat:1.6.0")
    implementation(project(":tauri-android"))
}
