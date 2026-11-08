package ir.kavirbot

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslCertificate
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.security.MessageDigest

class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var store: SecureStore
    private lateinit var alarm: AlarmPlayer

    private val startUrl = "https://kavirtire.ir/esale/products"
    private val allowedOrigins = setOf("https://kavirtire.ir", "https://sep.shaparak.ir")

    // Same scope as the userscript's @match lines.
    private val pageGuard = """
        if (!/^https:\/\/kavirtire\.ir\/esale\//.test(location.href) &&
            !/^https:\/\/sep\.shaparak\.ir\/OnlinePG\/(OnlinePG|SendToken)/.test(location.href)) return;
    """.trimIndent()

    private fun asset(name: String) = assets.open(name).bufferedReader().use { it.readText() }

    private fun buildScript(): String =
        "(function(){\n$pageGuard\n${asset("gm_shim.js")}\n${asset("KT12-_Panel.js")}\n})();"

    private fun isGateway(host: String) = host == "shaparak.ir" || host.endsWith(".shaparak.ir")
    private fun isKavir(host: String) = host == "kavirtire.ir" || host.endsWith(".kavirtire.ir")

    private fun isInternal(uri: Uri): Boolean {
        val host = uri.host ?: return false
        return uri.scheme == "https" && (isKavir(host) || isGateway(host))
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        startForegroundService(Intent(this, KeepAliveService::class.java))

        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }
        else window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)

        store = SecureStore(this)
        alarm = AlarmPlayer(this)
        web = WebView(this)

        setContentView(web)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(web, true) // gateway redirects need it
        }
        web.addJavascriptInterface(GmBridge(store) { runOnUiThread { onStockFound() } }, "KTNative")
        // Look like normal mobile Chrome (some WAFs reject the WebView "wv" marker).
        web.settings.userAgentString = web.settings.userAgentString
            .replace("; wv", "").replace(Regex("Version/\\d+\\.\\d+ "), "")
        WebView.setWebContentsDebuggingEnabled(true)

        val script = buildScript()
        val useDocStart = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        if (useDocStart) WebViewCompat.addDocumentStartJavaScript(web, script, allowedOrigins)

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean {
                if (isInternal(r.url)) return false
                // Anything else (t.me, banking apps, ...) goes to the system.
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, r.url)) }
                return true
            }

            private fun showError(v: WebView, title: String, detail: String, hint: String = "") {
                val hintHtml = if (hint.isEmpty()) "" else "<p dir='rtl' style='font-size:18px'>$hint</p>"
                val html = "<html><body style='font-family:sans-serif;padding:24px'>" +
                    "<h3>$title</h3><p style='word-break:break-all'>$detail</p>$hintHtml" +
                    "<p><a href='$startUrl' style='display:inline-block;padding:12px 28px;" +
                    "background:#0891b2;color:#fff;border-radius:8px;text-decoration:none'>Retry</a></p>" +
                    "</body></html>"
                v.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
            }

            override fun onReceivedError(v: WebView, r: WebResourceRequest, e: WebResourceError) {
                if (!r.isForMainFrame) return
                showError(v, "Load error", "${e.errorCode}: ${e.description}<br>${r.url}")
            }

            override fun onReceivedHttpError(v: WebView, r: WebResourceRequest, resp: WebResourceResponse) {
                if (!r.isForMainFrame || resp.statusCode < 400) return
                val hint = if (resp.statusCode == 403) "فیلترشکن را خاموش کن و روی دکمه‌ی زیر بزن." else ""
                showError(v, "HTTP ${resp.statusCode}", "${resp.reasonPhrase}<br>${r.url}", hint)
            }

            private fun fingerprint(e: SslError): String? = runCatching {
                val der = SslCertificate.saveState(e.certificate).getByteArray("x509-certificate")!!
                MessageDigest.getInstance("SHA-256").digest(der).joinToString(":") { "%02X".format(it) }
            }.getOrNull()

            override fun onReceivedSslError(v: WebView, h: SslErrorHandler, e: SslError) {
                val host = Uri.parse(e.url).host ?: ""
                val ours = isKavir(host)
                val fp = fingerprint(e)
                // Trust-on-first-use for kavirtire.ir only: confirm once, then that exact certificate is pinned.
                if (ours && e.primaryError == SslError.SSL_UNTRUSTED && fp != null) {
                    val pins = getSharedPreferences("pins", MODE_PRIVATE)
                    val pinned = pins.getString(host, null)
                    if (pinned == fp) { h.proceed(); return }
                    AlertDialog.Builder(this@MainActivity)
                        .setTitle(if (pinned != null) "Certificate CHANGED for $host" else "Trust certificate for $host?")
                        .setMessage("SHA-256:\n$fp\n\nOnly continue if you are on a trusted network.")
                        .setCancelable(false)
                        .setPositiveButton("Trust") { _, _ -> pins.edit().putString(host, fp).apply(); h.proceed() }
                        .setNegativeButton("Cancel") { _, _ -> h.cancel() }
                        .show()
                    return
                }
                h.cancel()
                if (ours || isGateway(host)) showError(v, "SSL error", "${e.primaryError} - ${e.url}")
            }

            override fun onPageStarted(v: WebView, url: String, favicon: Bitmap?) {
                // Fallback for old WebView versions without document-start scripts.
                if (!useDocStart) v.evaluateJavascript(script, null)
            }
        }
        web.webChromeClient = WebChromeClient()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { if (web.canGoBack()) web.goBack() else finish() }
        })

        web.loadUrl(savedInstanceState?.getString("url") ?: startUrl)
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun onStockFound() {
        if (alarm.isPlaying || isFinishing) return
        alarm.start()
        AlertDialog.Builder(this)
            .setTitle("🚀 موجودی پیدا شد!")
            .setMessage("لاستیک موجود شد و ربات در حال خرید است.")
            .setCancelable(false)
            .setPositiveButton("قطع آلارم") { _, _ -> alarm.stop() }
            .show()
    }

    override fun onSaveInstanceState(out: Bundle) {
        super.onSaveInstanceState(out)
        web.url?.let { out.putString("url", it) }
    }

    override fun onDestroy() {
        alarm.stop()
        stopService(Intent(this, KeepAliveService::class.java))
        web.destroy()
        super.onDestroy()
    }
}
