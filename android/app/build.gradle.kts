plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.ghostday.browser"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.ghostday.browser"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // Assine com sua propria chave antes de distribuir:
            //   signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources.excludes += setOf("META-INF/*.version", "DebugProbesKt.bin")
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    // ProxyController, addDocumentStartJavaScript, WebSettingsCompat
    implementation("androidx.webkit:webkit:1.12.1")
}

/*
 * shield.js tem UMA fonte: ../../shared/shield.js, o mesmo arquivo que o app
 * desktop injeta por CDP. Copiado para assets a cada build, para os dois nunca
 * sairem de sincronia.
 */
val copyShield by tasks.registering(Copy::class) {
    val shield = rootProject.file("../shared/shield.js")
    from(shield)
    into(layout.projectDirectory.dir("src/main/assets"))
    doFirst {
        if (!shield.exists()) {
            throw GradleException("shared/shield.js nao encontrado em ${shield.absolutePath}")
        }
    }
}

tasks.named("preBuild") {
    dependsOn(copyShield)
}
