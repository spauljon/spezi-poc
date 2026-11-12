package com.aboutobjects.healthgate.auth

import android.content.Context
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.security.KeyStore
import javax.crypto.SecretKey
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The token store against the real Android Keystore (a JVM test cannot reach it). */
class KeystoreTokenStoreTest {
    private val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
    private val alias = "healthgate-test-${System.nanoTime()}"
    private val prefsName = "tokens-test-$alias"
    private val store = KeystoreTokenStore(context, alias, prefsName)
    private val tokens = TokenSet("access-token-PLAINTEXT-123", "refresh-token-PLAINTEXT-456", 1_800_000_000_000, "https://macpro16.local:8444/realms/poc")

    @After fun cleanUp() {
        store.clear()
        context.deleteSharedPreferences(prefsName)
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias)
    }

    private fun prefsFileText(): String =
        File(context.applicationInfo.dataDir, "shared_prefs/$prefsName.xml").takeIf { it.isFile }?.readText() ?: ""

    @Test fun nothingStoredReadsAsNull() = assertNull(store.load())

    @Test fun tokensRoundTripThroughTheKeystore() {
        store.save(tokens)
        assertEquals(tokens, store.load())
    }

    @Test fun whatIsOnDiskIsCiphertextNotTheTokens() {
        store.save(tokens)
        val raw = prefsFileText()
        assertTrue("the control: the preferences file exists and holds the ciphertext", raw.contains("name=\"data\"") && raw.contains("name=\"iv\""))
        assertFalse(raw.contains("PLAINTEXT"))
        assertFalse(raw.contains("access-token") || raw.contains("macpro16"))
    }

    @Test fun aSecondStoreOnTheSameKeyReadsWhatTheFirstWrote() {
        store.save(tokens)
        assertEquals(tokens, KeystoreTokenStore(context, alias, prefsName).load())
    }

    @Test fun theKeyCanNotBeReadOutOfTheKeystore() {
        store.save(tokens)
        val key = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.getKey(alias, null) as SecretKey
        assertNotNull(key)
        assertNull("a Keystore secret key has no exportable bytes", key.encoded)
    }

    @Test fun aTamperedCiphertextReadsAsSignedOutAndIsDropped() {
        store.save(tokens)
        val prefs = context.getSharedPreferences(prefsName, Context.MODE_PRIVATE)
        val data = prefs.getString("data", null)!!
        val flipped = (if (data[4] == 'A') 'B' else 'A').let { data.substring(0, 4) + it + data.substring(5) }
        prefs.edit().putString("data", flipped).commit()
        assertNull(store.load())
        assertNull("and it was cleared", prefs.getString("data", null))
    }

    @Test fun clearRemovesTheTokens() {
        store.save(tokens)
        store.clear()
        assertNull(store.load())
    }
}
