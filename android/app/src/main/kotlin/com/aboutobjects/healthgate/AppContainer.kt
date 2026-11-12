package com.aboutobjects.healthgate

import android.content.Context
import com.aboutobjects.healthgate.auth.AppAuthClient
import com.aboutobjects.healthgate.auth.AuthService
import com.aboutobjects.healthgate.auth.KeystoreTokenStore
import com.aboutobjects.healthgate.config.ServerConfiguration
import com.aboutobjects.healthgate.contract.MetricRegistry
import com.aboutobjects.healthgate.ingest.IngestSource
import com.aboutobjects.healthgate.ingest.SyntheticConfig
import com.aboutobjects.healthgate.ingest.SyntheticGenerator
import com.aboutobjects.healthgate.ingest.SyntheticSource
import com.aboutobjects.healthgate.mapping.QualityFlagger
import com.aboutobjects.healthgate.queue.SampleQueue
import com.aboutobjects.healthgate.queue.SqliteSampleQueue
import com.aboutobjects.healthgate.sync.OkHttpTransport
import com.aboutobjects.healthgate.sync.SyncEngine
import java.time.ZoneId

/** The app's parts, made once at launch (plain constructors, no dependency-injection library). */
class AppContainer(context: Context) {
    val configuration: ServerConfiguration = ServerConfiguration.forHost(BuildConfig.SERVER_HOST)
    val registry: MetricRegistry = context.assets.open("metrics.json").bufferedReader().use { MetricRegistry.parse(it.readText()) }
    val queue: SampleQueue = SqliteSampleQueue(context)
    val appAuth = AppAuthClient(context)
    val auth = AuthService(appAuth, KeystoreTokenStore(context), configuration)
    val flagger = QualityFlagger(registry)
    val source: IngestSource = SyntheticSource(SyntheticGenerator(registry), SyntheticConfig(seed = SYNTHETIC_SEED, zone = ZoneId.systemDefault()))
    val engine = SyncEngine(
        queue = queue,
        transport = OkHttpTransport(configuration.fhirBase),
        tokens = auth,
        registry = registry,
        settings = SyncEngine.Settings(
            patientIdentifier = configuration.patientIdentifier,
            patientSystem = registry.systems.identifier.getValue("patient"),
        ),
    )

    private companion object {
        const val SYNTHETIC_SEED = 20260301L
    }
}
