package ir.kavirbot

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.net.http.SslCertificate
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
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

    private val ui = Handler(Looper.getMainLooper())
    private var failedUrl = startUrl
    private var lastStartedUrl = startUrl
    private var failed = false
    private var netCallback: ConnectivityManager.NetworkCallback? = null
    private val retryRunnable = Runnable { retryNow() }
    private val loadWatchdog = Runnable { onLoadTimeout() }
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
                if (r.url.scheme == "kb") { retryNow(); return true }
                if (isInternal(r.url)) return false
                // Anything else (t.me, banking apps, ...) goes to the system.
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, r.url)) }
                return true
            }

            override fun onReceivedError(v: WebView, r: WebResourceRequest, e: WebResourceError) {
                if (!r.isForMainFrame) return
                describeLoadError(e.errorCode, r.url.toString(), e.description.toString())
            }

            override fun onReceivedHttpError(v: WebView, r: WebResourceRequest, resp: WebResourceResponse) {
                if (!r.isForMainFrame || resp.statusCode < 400) return
                describeHttpError(resp.statusCode, r.url.toString(), resp.reasonPhrase)
            }

            override fun onRenderProcessGone(v: WebView, detail: RenderProcessGoneDetail): Boolean {
                runOnUiThread { recreate() }
                return true
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
                if (ours || isGateway(host))
                    showErrorPage(e.url, "🔒 خطای گواهی امنیتی", "ساعت و تاریخ گوشی را بررسی کن و فیلترشکن را خاموش کن.", "SSL ${e.primaryError} ${e.url}", 10000)
            }

            override fun onPageStarted(v: WebView, url: String, favicon: Bitmap?) {
                if (url.startsWith("http")) {
                    failed = false
                    lastStartedUrl = url
                    ui.removeCallbacks(loadWatchdog)
                    ui.postDelayed(loadWatchdog, 40_000)
                }
                // Fallback for old WebView versions without document-start scripts.
                if (!useDocStart) v.evaluateJavascript(script, null)
            }

            override fun onPageFinished(v: WebView, url: String?) {
                if (!failed && url?.startsWith("http") == true) {
                    ui.removeCallbacks(loadWatchdog)
                    ui.removeCallbacks(retryRunnable)
                }
            }
        }
        web.webChromeClient = WebChromeClient()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { if (web.canGoBack()) web.goBack() else finish() }
        })

        getSystemService(ConnectivityManager::class.java)?.let { cm ->
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) { runOnUiThread { if (failed) retryNow() } }
            }
            netCallback = cb
            runCatching { cm.registerDefaultNetworkCallback(cb) }
        }

        web.loadUrl(savedInstanceState?.getString("url")?.takeIf { it.startsWith("http") } ?: startUrl)
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun isOnline(): Boolean {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return true
        val caps = cm.getNetworkCapabilities(cm.activeNetwork ?: return false) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun retryNow() {
        ui.removeCallbacks(retryRunnable)
        web.loadUrl(failedUrl)
    }

    private fun onLoadTimeout() {
        if (failed) return
        web.stopLoading()
        showErrorPage(
            lastStartedUrl, "⏱️ پاسخ سایت دیر شد", "سایت بیش از ۴۰ ثانیه جواب نداد. اینترنت یا فیلترشکن را بررسی کن.",
            "timeout", 5000
        )
    }

    /** Friendly Persian error page. autoRetryMs = null means manual retry only. */
    private fun showErrorPage(url: String?, title: String, message: String, detail: String, autoRetryMs: Long?, retryStart: Boolean = false) {
        ui.removeCallbacks(loadWatchdog)
        ui.removeCallbacks(retryRunnable)
        failed = true
        failedUrl = if (retryStart || url == null || !url.startsWith("http")) startUrl else url
        val auto = if (autoRetryMs == null) "" else
            "<p class='s'>تلاش مجدد خودکار هر ${autoRetryMs / 1000} ثانیه (و به‌محض وصل شدن اینترنت)</p>"
        val html = "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head>" +
            "<body dir='rtl' style='margin:0;padding:28px;background:#0b1b2b;color:#e6fbff;" +
            "font-family:Tahoma,sans-serif;text-align:center'>" +
            "<h2 style='margin-top:48px'>$title</h2><p style='font-size:18px;line-height:1.9'>$message</p>$auto" +
            "<p><a href='kb://retry' style='display:inline-block;padding:14px 38px;background:#0891b2;color:#fff;" +
            "border-radius:10px;text-decoration:none;font-size:18px'>تلاش دوباره</a></p>" +
            "<p style='color:#7fa6bd;font-size:12px;word-break:break-all;direction:ltr'>$detail</p>" +
            "<style>.s{color:#7fa6bd;font-size:14px}</style></body></html>"
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
        if (autoRetryMs != null) ui.postDelayed(retryRunnable, autoRetryMs)
    }

    private fun describeLoadError(code: Int, url: String?, desc: String): Unit {
        val detail = "$code: $desc  $url"
        when (code) {
            WebViewClient.ERROR_HOST_LOOKUP, WebViewClient.ERROR_CONNECT, WebViewClient.ERROR_IO, WebViewClient.ERROR_TIMEOUT ->
                if (!isOnline()) showErrorPage(url, "📡 اینترنت قطع است",
                    "اینترنت گوشی (وای‌فای یا دیتا) را بررسی کن. به‌محض وصل شدن، خودکار ادامه می‌دهم.", detail, 5000)
                else showErrorPage(url, "⚠️ اتصال به سایت برقرار نشد",
                    "اینترنت وصل است ولی سایت جواب نمی‌دهد. اگر فیلترشکن روشن است خاموشش کن (یا اگر خاموش است روشنش کن).", detail, 5000)
            WebViewClient.ERROR_FAILED_SSL_HANDSHAKE ->
                showErrorPage(url, "🔒 خطای اتصال امن",
                    "ساعت و تاریخ گوشی را بررسی کن و فیلترشکن را خاموش کن.", detail, 10000)
            WebViewClient.ERROR_TOO_MANY_REQUESTS ->
                showErrorPage(url, "🚦 درخواست‌ها زیاد است", "سایت موقتاً محدود کرده؛ چند لحظه صبر می‌کنم.", detail, 20000)
            WebViewClient.ERROR_REDIRECT_LOOP ->
                showErrorPage(url, "🔁 حلقه‌ی انتقال", "سایت در حلقه‌ی انتقال افتاده؛ معمولاً باید دوباره وارد حساب شوی.", detail, 10000, retryStart = true)
            else ->
                showErrorPage(url, "❗ خطا در بارگذاری", "مشکل نامشخصی پیش آمد.", detail, 10000)
        }
    }

    private fun describeHttpError(status: Int, url: String?, reason: String?) {
        val detail = "HTTP $status $reason  $url"
        when {
            status == 401 -> showErrorPage(url, "🔑 نیاز به ورود (401)", "دوباره وارد حساب خودت شو.", detail, null, retryStart = true)
            status == 403 -> showErrorPage(url, "⛔ دسترسی رد شد (403)", "فیلترشکن را خاموش کن و روی دکمه‌ی زیر بزن.", detail, null)
            status == 404 -> showErrorPage(url, "🔍 صفحه پیدا نشد (404)", "این صفحه وجود ندارد.", detail, null, retryStart = true)
            status == 419 -> showErrorPage(url, "⌛ نشست منقضی شد (419)", "صفحه منقضی شده؛ دوباره باز می‌کنم. اگر نشد وارد حساب شو.", detail, 5000, retryStart = true)
            status == 408 || status == 429 -> showErrorPage(url, "🚦 درخواست‌ها زیاد است ($status)", "سایت موقتاً محدود کرده؛ چند لحظه صبر می‌کنم.", detail, 20000)
            status >= 500 -> showErrorPage(url, "🛠️ مشکل از سمت سرور ($status)", "سرور سایت خطا داد؛ خودکار دوباره تلاش می‌کنم.", detail, 5000)
            else -> showErrorPage(url, "❗ خطای $status", "درخواست انجام نشد.", detail, 10000)
        }
    }

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
        ui.removeCallbacksAndMessages(null)
        netCallback?.let { cb -> runCatching { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(cb) } }
        stopService(Intent(this, KeepAliveService::class.java))
        web.destroy()
        super.onDestroy()
    }
}
