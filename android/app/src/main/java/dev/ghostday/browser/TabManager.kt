package dev.ghostday.browser

import android.annotation.SuppressLint
import android.app.Activity
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewDatabase
import android.widget.FrameLayout
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import kotlin.random.Random

/**
 * Abas do GhostDay no Android.
 *
 * Diferenca honesta em relacao ao desktop: o WebView do Android tem UM unico
 * CookieManager e UM unico ProxyController por processo. Nao da para ter
 * sessao por aba como no Electron, entao "aba isolada" nao existe aqui — no
 * lugar dela ha o modo fantasma, que e global: nenhum cookie aceito e tudo
 * apagado ao sair.
 */
class TabManager(
    private val activity: Activity,
    private val container: FrameLayout,
    private val prefs: Prefs,
    private val onChange: () -> Unit
) {

    companion object {
        /** UA de Chrome comum no Android. O "K" e o modelo congelado do Android 14+. */
        const val GENERIC_UA =
            "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/130.0.0.0 Mobile Safari/537.36"
        const val MAX_TABS = 12
    }

    private val tabs = mutableListOf<Tab>()
    private var nextId = 1
    private val launchSeed = Random.nextLong().toString(36)

    var activeId: Int = -1
        private set

    fun list(): List<Tab> = tabs
    fun count(): Int = tabs.size
    fun active(): Tab? = tabs.firstOrNull { it.id == activeId }

    /* ---------------- ciclo de vida das abas ---------------- */

    fun newTab(url: String? = null): Tab? {
        if (tabs.size >= MAX_TABS) return null

        val id = nextId++
        val webView = WebView(activity)
        val tab = Tab(id, webView, "$launchSeed:$id")
        configure(tab)

        tabs += tab
        container.addView(
            webView,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
        select(id)
        webView.loadUrl(url ?: prefs.homepage)
        onChange()
        return tab
    }

    fun select(id: Int) {
        if (tabs.none { it.id == id }) return
        activeId = id
        for (tab in tabs) {
            tab.webView.visibility = if (tab.id == id) android.view.View.VISIBLE
                                     else android.view.View.GONE
        }
        onChange()
    }

    fun close(id: Int) {
        val index = tabs.indexOfFirst { it.id == id }
        if (index < 0) return
        val tab = tabs.removeAt(index)

        tab.webView.apply {
            stopLoading()
            loadUrl("about:blank")
            clearHistory()
            container.removeView(this)
            removeAllViews()
            destroy()
        }

        if (activeId == id) {
            val next = tabs.getOrNull(index) ?: tabs.lastOrNull()
            if (next != null) select(next.id) else newTab()
        }
        onChange()
    }

    /* ---------------- navegacao ---------------- */

    fun go(input: String) {
        val tab = active() ?: newTab() ?: return
        tab.webView.loadUrl(UrlUtils.toUrl(input, prefs.searchTemplate))
    }

    fun back(): Boolean {
        val wv = active()?.webView ?: return false
        if (!wv.canGoBack()) return false
        wv.goBack()
        return true
    }

    fun forward() { active()?.webView?.let { if (it.canGoForward()) it.goForward() } }
    fun reload()  { active()?.webView?.reload() }
    fun stop()    { active()?.webView?.stopLoading() }

    /* ---------------- configuracao de cada WebView ---------------- */

    @SuppressLint("SetJavaScriptEnabled")
    private fun configure(tab: Tab) {
        val webView = tab.webView
        val s = webView.settings

        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.setGeolocationEnabled(false)
        s.javaScriptCanOpenWindowsAutomatically = false
        s.setSupportMultipleWindows(false)
        s.allowFileAccess = false
        s.allowContentAccess = false
        s.mediaPlaybackRequiresUserGesture = true
        s.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        s.useWideViewPort = true
        s.loadWithOverviewMode = true
        s.builtInZoomControls = true
        s.displayZoomControls = false
        s.cacheMode = if (prefs.ghostMode) WebSettings.LOAD_NO_CACHE else WebSettings.LOAD_DEFAULT

        @Suppress("DEPRECATION")
        s.saveFormData = false

        if (prefs.spoofUserAgent) s.userAgentString = GENERIC_UA

        // Safe Browsing manda as URLs visitadas para o Google. Fora.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.SAFE_BROWSING_ENABLE)) {
            runCatching { WebSettingsCompat.setSafeBrowsingEnabled(s, false) }
        }

        val cookies = CookieManager.getInstance()
        cookies.setAcceptCookie(!prefs.ghostMode)
        cookies.setAcceptThirdPartyCookies(
            webView,
            !prefs.blockThirdPartyCookies && !prefs.ghostMode
        )

        tab.shieldEarly = prefs.antiFingerprint && Shield.install(webView, activity, tab.seed)

        webView.isVerticalScrollBarEnabled = true
        webView.setBackgroundColor(0xFF07090B.toInt())

        webView.webViewClient = GhostWebViewClient(
            prefs = prefs,
            tab = tab,
            onBlocked = { activity.runOnUiThread { onChange() } },
            onNavigationChanged = { onChange() }
        )

        webView.webChromeClient = object : WebChromeClient() {
            override fun onReceivedTitle(view: WebView?, title: String?) {
                if (!title.isNullOrBlank()) tab.title = title
                onChange()
            }

            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                tab.loading = newProgress < 100
                onChange()
            }

            // Camera e microfone: negados sempre. Se um dia virar opcional,
            // tem de ser pedido explicito do usuario, nunca da pagina.
            override fun onPermissionRequest(request: PermissionRequest) {
                request.deny()
            }

            override fun onGeolocationPermissionsShowPrompt(
                origin: String?,
                callback: GeolocationPermissions.Callback?
            ) {
                callback?.invoke(origin, false, false)
            }
        }
    }

    /** Reaplica as preferencias nas abas abertas (menos as que exigem recarga). */
    fun refreshSettings() {
        val cookies = CookieManager.getInstance()
        cookies.setAcceptCookie(!prefs.ghostMode)
        for (tab in tabs) {
            val s = tab.webView.settings
            s.userAgentString = if (prefs.spoofUserAgent) GENERIC_UA else null
            s.cacheMode = if (prefs.ghostMode) WebSettings.LOAD_NO_CACHE
                          else WebSettings.LOAD_DEFAULT
            cookies.setAcceptThirdPartyCookies(
                tab.webView,
                !prefs.blockThirdPartyCookies && !prefs.ghostMode
            )
        }
    }

    /* ---------------- limpeza ---------------- */

    fun wipe(reload: Boolean = true) {
        val cookies = CookieManager.getInstance()
        cookies.removeAllCookies(null)
        cookies.flush()

        WebStorage.getInstance().deleteAllData()
        WebViewDatabase.getInstance(activity).apply {
            clearHttpAuthUsernamePassword()
            @Suppress("DEPRECATION")
            clearFormData()
        }

        for (tab in tabs) {
            tab.webView.clearCache(true)
            tab.webView.clearFormData()
            tab.webView.clearSslPreferences()
            tab.blocked = 0
        }
        Blocklist.resetCount()

        if (reload) for (tab in tabs) tab.webView.reload()
        onChange()
    }

    fun onPause()  { for (tab in tabs) tab.webView.onPause() }
    fun onResume() { for (tab in tabs) tab.webView.onResume() }

    fun destroy(wipeFirst: Boolean) {
        if (wipeFirst) wipe(reload = false)
        closeAllWithoutReplacement()
    }

    private fun closeAllWithoutReplacement() {
        for (tab in tabs.toList()) {
            tab.webView.apply {
                stopLoading()
                container.removeView(this)
                removeAllViews()
                destroy()
            }
        }
        tabs.clear()
        activeId = -1
    }
}
