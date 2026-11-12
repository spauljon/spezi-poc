package com.aboutobjects.healthgate.ingest

import com.aboutobjects.healthgate.mapping.DeviceDescriptor
import com.aboutobjects.healthgate.mapping.MetricSample
import java.time.Instant

/** One sample and the device that produced it, as a source hands them to the app. */
data class IngestItem(val sample: MetricSample, val device: DeviceDescriptor) {
    /** The queue key: one sample is one key, whichever source produced it. */
    val key: String get() = "${sample.source}|${sample.id}"
}

/**
 * Where samples come from. The synthetic generator and (M27) Health Connect sit behind this one interface, so the queue, the
 * mapper and the uploader never know which one they are serving.
 */
interface IngestSource {
    val name: String

    /** Everything this source has for [from] until [to]; [issued] is when the app produced it (the caller's clock, never the source's). */
    fun samples(from: Instant, to: Instant, issued: Instant): List<IngestItem>
}
