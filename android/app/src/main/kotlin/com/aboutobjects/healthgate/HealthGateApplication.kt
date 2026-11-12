package com.aboutobjects.healthgate

import android.app.Application

class HealthGateApplication : Application() {
    val container: AppContainer by lazy { AppContainer(this) }
}
