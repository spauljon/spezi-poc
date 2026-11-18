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
import com.aboutobjects.healthgate.ingest.healthconnect.AndroidHealthConnectGateway
import com.aboutobjects.healthgate.ingest.healthconnect.HealthConnectAccess
import com.aboutobjects.healthgate.ingest.healthconnect.HealthConnectCollector
import com.aboutobjects.healthgate.ingest.healthconnect.PrefsCollectorState
import com.aboutobjects.healthgate.mapping.QualityFlagger
import com.aboutobjects.healthgate.queue.SampleQueue
import com.aboutobjects.healthgate.queue.SqliteSampleQueue
import com.aboutobjects.healthgate.settings.PauseStore
import com.aboutobjects.healthgate.settings.PrefsAttemptStore
import com.aboutobjects.healthgate.settings.PrefsPauseStore
import com.aboutobjects.healthgate.sync.OkHttpTransport
import com.aboutobjects.healthgate.sync.SyncRunner
import com.aboutobjects.healthgate.sync.SyncEngine
import java.time.ZoneId

/** The app's parts, made once at launch (plain constructors, no dependency-injection library). */
class AppContainer(private val context: Context) {
    val configuration: ServerConfiguration = ServerConfiguration.forHost(BuildConfig.SERVER_HOST, BuildConfig.REAL_PATIENT)
    val registry: MetricRegistry = context.assets.open("metrics.json").bufferedReader().use { MetricRegistry.parse(it.readText()) }
    val queue: SampleQueue = SqliteSampleQueue(context)
    val appAuth = AppAuthClient(context)
    val auth = AuthService(appAuth, KeystoreTokenStore(context), configuration)
    val flagger = QualityFlagger(registry)
    val source: IngestSource = SyntheticSource(SyntheticGenerator(registry), SyntheticConfig(seed = SYNTHETIC_SEED, zone = ZoneId.systemDefault()))
    val pauseStore: PauseStore = PrefsPauseStore(context)
    val engine = SyncEngine(
        queue = queue,
        transport = OkHttpTransport(configuration.fhirBase),
        tokens = auth,
        registry = registry,
        settings = SyncEngine.Settings(
            patientIdentifier = configuration.patientIdentifier,
            realPatientIdentifier = configuration.realPatientIdentifier,
            patientSystem = registry.systems.identifier.getValue("patient"),
        ),
        attempts = PrefsAttemptStore(context),
    )

    /** Health Connect on this phone, or null when it is missing or needs an update (the screen then says why). */
    val healthConnectStatus: HealthConnectAccess.Status get() = HealthConnectAccess.status(context)

    val healthConnectClient: androidx.health.connect.client.HealthConnectClient? by lazy {
        if (HealthConnectAccess.status(context) == HealthConnectAccess.Status.AVAILABLE) androidx.health.connect.client.HealthConnectClient.getOrCreate(context) else null
    }

    /** Where the Health Connect changes token is kept. */
    val collectorState: PrefsCollectorState by lazy { PrefsCollectorState(context) }

    /** Reads Health Connect into the queue (null when Health Connect is not available). */
    val collector: HealthConnectCollector? by lazy {
        healthConnectClient?.let { HealthConnectCollector(AndroidHealthConnectGateway(it), queue, collectorState, registry) }
    }

    /** One sync (read Health Connect, then upload): the buttons, a sign-in and the scheduled background worker all use this. */
    val runner: SyncRunner by lazy { SyncRunner(collector?.let { c -> { c.collect() } }, engine, pauseStore) }

    /** True when the system lets this app run in the background without battery restrictions (Samsung's "Unrestricted"). */
    fun batteryUnrestricted(): Boolean =
        (context.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager).isIgnoringBatteryOptimizations(context.packageName)

    private companion object {
        const val SYNTHETIC_SEED = 20260301L
    }
}
