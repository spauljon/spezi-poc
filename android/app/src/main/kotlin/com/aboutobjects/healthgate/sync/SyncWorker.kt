package com.aboutobjects.healthgate.sync

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.aboutobjects.healthgate.HealthGateApplication
import java.util.concurrent.TimeUnit

/**
 * The scheduled background sync (WorkManager, every 15 minutes when there is a network): the same [SyncRunner] the screen uses. It asks
 * WorkManager for a retry (with its exponential back-off) only for a temporary problem; a block that needs the user (signed out, refused,
 * Health Connect not allowed in the background) ends the run quietly, with a line in the attempt history, because retrying cannot fix it.
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val container = (applicationContext as HealthGateApplication).container
        return resultFor(container.runner.run("Background"))
    }

    companion object {
        const val UNIQUE_NAME = "healthgate-sync"

        /** Success unless the run met a temporary problem (then retry, which WorkManager spaces out with back-off). */
        fun resultFor(run: RunResult): Result = if (run.worthRetrying) Result.retry() else Result.success()

        val request get() = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()

        /** Makes sure the periodic work exists (a no-op when it already does: KEEP). */
        fun schedule(context: Context) {
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(UNIQUE_NAME, ExistingPeriodicWorkPolicy.KEEP, request)
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(UNIQUE_NAME)
        }
    }
}
