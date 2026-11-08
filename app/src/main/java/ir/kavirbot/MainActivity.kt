package ir.kavirbot

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var store: SecureStore

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

    private fun isInternal(uri: Uri): Boolean {
        val host = uri.host ?: return false
        return uri.scheme == "https" && (host == "kavirtire.ir" || host.endsWith(".kavirtire.ir") ||
                host == "shaparak.ir" || host.endsWith(".shaparak.ir"))
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        startForegroundService(Intent(this, KeepAliveService::class.java))

        store = SecureStore(this)
        web = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }
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
        web.addJavascriptInterface(GmBridge(store), "KTNative")

        val script = buildScript()
        val useDocStart = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        if (useDocStart) {
            WebViewCompat.addDocumentStartJavaScript(web, script, allowedOrigins)
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean {
                if (isInternal(r.url)) return false
                // Anything else (t.me, banking apps, ...) goes to the system.
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, r.url)) }
                return true
            }

            override fun onPageStarted(v: WebView, url: String, favicon: android.graphics.Bitmap?) {
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

    override fun onSaveInstanceState(out: Bundle) {
        super.onSaveInstanceState(out)
        web.url?.let { out.putString("url", it) }
    }

    override fun onDestroy() {
        stopService(Intent(this, KeepAliveService::class.java))
        web.destroy()
        super.onDestroy()
    }
}
