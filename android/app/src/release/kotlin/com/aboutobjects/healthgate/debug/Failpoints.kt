package com.aboutobjects.healthgate.debug

/** The release build's failpoints: nothing. (The debug build's twin of this object can stop the process for the process-death test.) */
object Failpoints {
    @Suppress("UNUSED_PARAMETER")
    fun hit(name: String) = Unit
}
