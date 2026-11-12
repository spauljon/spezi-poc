package com.aboutobjects.healthgate.queue

/** The contract, run against the fake: the fake that the engine tests rely on behaves as the interface says. */
class InMemorySampleQueueTest : SampleQueueContract() {
    override fun newQueue(): SampleQueue = InMemorySampleQueue()
}
