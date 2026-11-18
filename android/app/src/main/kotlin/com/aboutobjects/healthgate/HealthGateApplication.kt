package com.aboutobjects.healthgate

import android.app.Application
import com.aboutobjects.healthgate.sync.SyncWorker

class HealthGateApplication : Application() {
    val container: AppContainer by lazy { AppContainer(this) }

    override fun onCreate() {
        super.onCreate()
        // the background sync exists whenever the user has not paused it (WorkManager keeps it across reboots; KEEP makes this a no-op)
        if (!container.pauseStore.paused) SyncWorker.schedule(this)
    }
}
