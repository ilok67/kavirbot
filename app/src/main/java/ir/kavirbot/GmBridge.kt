package ir.kavirbot

import android.webkit.JavascriptInterface

/** Exposed to page JS as `KTNative`. Values are JSON strings. */
class GmBridge(private val store: SecureStore, private val onAlarm: () -> Unit) {
    @JavascriptInterface fun get(key: String?): String? = key?.takeIf { it.length in 1..200 }?.let(store::get)
    @JavascriptInterface fun set(key: String?, json: String?) {
        if (key == null || json == null || key.length !in 1..200 || json.length > 500_000) return
        store.set(key, json)
    }
    @JavascriptInterface fun alarm() = onAlarm()
}
