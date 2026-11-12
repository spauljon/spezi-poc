package com.aboutobjects.healthgate.auth

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.serialization.json.Json

/** Where the tokens live between launches. Tokens are never put anywhere else: not in a log, a preference in the clear, or a URL. */
interface TokenStore {
    fun load(): TokenSet?
    fun save(tokens: TokenSet)
    fun clear()
}

/** A store held in memory, for tests. */
class InMemoryTokenStore(private var tokens: TokenSet? = null) : TokenStore {
    override fun load(): TokenSet? = tokens
    override fun save(tokens: TokenSet) { this.tokens = tokens }
    override fun clear() { tokens = null }
}

/**
 * The tokens, encrypted with an AES-256-GCM key that lives in the Android Keystore (hardware-backed where the phone has it) and can
 * never be read out of it. Only the ciphertext and its nonce are written to app-private preferences, which are not backed up.
 * A ciphertext that cannot be decrypted (a changed key, a tampered file) is dropped and reads as "signed out", never as an error screen.
 */
class KeystoreTokenStore(context: Context, private val alias: String = "healthgate-tokens", prefsName: String = "tokens") : TokenStore {
    private val prefs = context.getSharedPreferences(prefsName, Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    override fun save(tokens: TokenSet) {
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key()) }
        val ciphertext = cipher.doFinal(json.encodeToString(TokenSet.serializer(), tokens).toByteArray(Charsets.UTF_8))
        prefs.edit()
            .putString(IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .putString(DATA, Base64.encodeToString(ciphertext, Base64.NO_WRAP))
            .commit() // synchronous: a rotated refresh token must be on disk before the new access token is used, or a kill loses the session
    }

    override fun load(): TokenSet? {
        val iv = prefs.getString(IV, null) ?: return null
        val data = prefs.getString(DATA, null) ?: return null
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION).apply {
                init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
            }
            json.decodeFromString(TokenSet.serializer(), String(cipher.doFinal(Base64.decode(data, Base64.NO_WRAP)), Charsets.UTF_8))
        } catch (e: Exception) {
            clear()
            null
        }
    }

    override fun clear() {
        prefs.edit().remove(IV).remove(DATA).commit()
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV = "iv"
        const val DATA = "data"
    }
}
