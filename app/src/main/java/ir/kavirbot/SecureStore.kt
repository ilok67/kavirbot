package ir.kavirbot

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Backing store for the GM_getValue / GM_setValue shim.
 * - Normal keys: encrypted at rest (AES-256, key in Android Keystore).
 * - Keys containing "CVV": memory only, never written to disk.
 */
class SecureStore(context: Context) {
    private val prefs: SharedPreferences = run {
        val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            context, "kavirbot_store", key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }
    private val volatileMap = HashMap<String, String>()

    private fun isVolatile(key: String) = key.contains("CVV", ignoreCase = true)

    @Synchronized fun get(key: String): String? =
        if (isVolatile(key)) volatileMap[key] else prefs.getString(key, null)

    @Synchronized fun set(key: String, json: String) {
        if (isVolatile(key)) volatileMap[key] = json else prefs.edit().putString(key, json).apply()
    }

    @Synchronized fun clearAll() {
        volatileMap.clear()
        prefs.edit().clear().apply()
    }
}
