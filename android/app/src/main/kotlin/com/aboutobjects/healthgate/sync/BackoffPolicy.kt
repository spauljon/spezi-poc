package com.aboutobjects.healthgate.sync

import kotlin.math.min
import kotlin.math.pow

/** How long to wait after a failed attempt: exponential from [baseSeconds], capped, with a little jitter so devices do not retry in step. */
data class BackoffPolicy(val baseSeconds: Double = 5.0, val capSeconds: Double = 15 * 60.0, val jitter: Double = 0.2) {
    /**
     * @param attempt 1 for the first retry.
     * @param random uniform in [0, 1); injected so the result is reproducible in tests.
     */
    fun delaySeconds(attempt: Int, random: Double): Double {
        val exponent = min(maxOf(attempt, 1) - 1, 30)
        val nominal = min(baseSeconds * 2.0.pow(exponent), capSeconds)
        val factor = 1 + jitter * (2 * random.coerceIn(0.0, 1.0) - 1)
        return min(nominal * factor, capSeconds)
    }
}
