package com.aboutobjects.healthgate.writer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Lets a script drive the same scenarios as the buttons: `adb shell am broadcast -n com.aboutobjects.healthgate.writer/.ControlReceiver
 * -a com.aboutobjects.healthgate.writer.<ACTION>` with ACTION one of HR_WRITE, HR_DELETE, HR_LARGE, HR_LARGE_DELETE, MEAL_WRITE, DELETE_ALL.
 * The answer (a sentence of counts) goes to logcat under the tag HGWriter. Synthetic records only; nothing is read.
 */
class ControlReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (HealthConnectClient.getSdkStatus(context) != HealthConnectClient.SDK_AVAILABLE) { Log.i(TAG, "Health Connect is not available"); return }
        val prefs = context.getSharedPreferences("writer_ids", Context.MODE_PRIVATE)
        val book = object : IdBook {
            override fun get(name: String) = prefs.getString(name, null)
            override fun put(name: String, id: String) { prefs.edit().putString(name, id).commit() }
            override fun remove(name: String) { prefs.edit().remove(name).commit() }
            override fun names() = prefs.all.keys.toSet()
        }
        val s = Scenarios(HealthConnectClient.getOrCreate(context), book)
        val action = intent.action?.substringAfterLast('.')
        val pending = goAsync()
        CoroutineScope(Dispatchers.Default).launch {
            try {
                val answer = when (action) {
                    "HR_WRITE" -> s.heartRateWrite()
                    "HR_DELETE" -> s.heartRateDelete()
                    "HR_LARGE" -> s.heartRateLarge()
                    "HR_LARGE_DELETE" -> s.heartRateLargeDelete()
                    "MEAL_WRITE" -> s.mealWrite()
                    "DELETE_ALL" -> s.deleteAll()
                    else -> "unknown action $action"
                }
                Log.i(TAG, answer)
            } catch (e: Exception) {
                Log.i(TAG, "failed: ${e.javaClass.simpleName}")
            } finally {
                pending.finish()
            }
        }
    }

    private companion object {
        const val TAG = "HGWriter"
    }
}
