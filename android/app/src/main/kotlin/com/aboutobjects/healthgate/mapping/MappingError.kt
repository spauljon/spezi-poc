package com.aboutobjects.healthgate.mapping

/** Why a sample or device was refused. [code] is stable: it is what the golden fixtures' `expectedError` names. */
enum class MappingError(val code: String) {
    EMPTY_PATIENT_ID("emptyPatientID"),
    EMPTY_SAMPLE_ID("emptySampleID"),

    /** A Health Connect record without an id cannot be identified (contract healthConnect.sampleIdentity). */
    EMPTY_RECORD_ID("emptyRecordId"),
    NON_FINITE_VALUE("nonFiniteValue"),
    NON_POSITIVE_VALUE("nonPositiveValue"),

    /** A negative intake: always refused, even though zero is allowed for an intake. */
    NEGATIVE_VALUE("negativeValue"),
    END_BEFORE_START("endBeforeStart"),
    EMPTY_SLEEP_INTERVAL("emptySleepInterval"),
    OFFSET_NOT_WHOLE_MINUTES("offsetNotWholeMinutes"),
    EMPTY_DEVICE_DESCRIPTOR("emptyDeviceDescriptor"),

    /** A Health Connect record whose writing app has no package name (contract healthConnect.appSource). */
    BLANK_PACKAGE_NAME("blankPackageName"),

    /** The registry has no entry for something the mapper needs (a backstop: it would have failed to load). */
    CONTRACT_MISSING("contractMissing"),
}

class MappingException(val error: MappingError, detail: String? = null) :
    Exception(if (detail == null) error.code else "${error.code}: $detail")
