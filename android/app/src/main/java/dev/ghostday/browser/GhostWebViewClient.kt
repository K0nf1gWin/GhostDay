package dev.ghostday.browser

import android.graphics.Bitmap
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.ByteArrayInputStream

/**
 * Bloqueio, limpeza de URL e upgrade de esquema — o equivalente Android do
 * webRequest.onBeforeRequest do desktop.
 *
 * shouldInterceptRequest roda em thread de rede: nada de tocar em View aqui.
 * O que a UI precisa saber vai pelos callbacks, que a Activity reposta na
 * main thread.
 */
class GhostWebViewClient(
    private val prefs: Prefs,
    private val tab: Tab,
    private val onBlocked: () -> Unit,
    private val onNavigationChanged: () -> Unit
) : WebViewClient() {

    override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest
    ): WebResourceResponse? {
        if (!prefs.blockTrackers) return null
        if (request.isForMainFrame) return null      // navegacao direta nunca e bloqueada

        val url = request.url?.toString() ?: return null
        val scheme = request.url.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") return null

        if (!Blocklist.shouldBlock(url)) return null

        tab.blocked++
        onBlocked()
        return WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        if (!request.isForMainFrame) return false
        val url = request.url?.toString() ?: return false

        // mailto:, tel:, intent:, market:... nao saem do navegador sozinhos
        val scheme = request.url.scheme?.lowercase()
        if (scheme != "http" && scheme != "https" && scheme != "about" && scheme != "data") {
            return true
        }

        if (prefs.stripParams) {
            UrlUtils.clean(url)?.let { view.loadUrl(it); return true }
        }
        if (prefs.httpsOnly) {
            UrlUtils.upgrade(url)?.let { view.loadUrl(it); return true }
        }
        return false
    }

    override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        tab.loading = true
        tab.url = url ?: ""
        tab.blocked = 0
        // Se o registro document-start falhou, injeta agora: pior momento,
        // mas melhor que deixar a pagina sem shield.
        if (prefs.antiFingerprint && !tab.shieldEarly) {
            Shield.injectLate(view, view.context, tab.seed)
        }
        onNavigationChanged()
    }

    override fun onPageFinished(view: WebView, url: String?) {
        tab.loading = false
        tab.url = url ?: tab.url
        tab.title = view.title ?: tab.title
        onNavigationChanged()
    }

    override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: WebResourceError
    ) {
        if (!request.isForMainFrame) return
        tab.loading = false
        tab.title = "falha na requisicao"
        val message = runCatching { error.description?.toString() }.getOrNull() ?: "erro de rede"
        view.loadDataWithBaseURL(
            null,
            errorPage(request.url?.toString() ?: "", message),
            "text/html",
            "utf-8",
            null
        )
        onNavigationChanged()
    }

    private fun errorPage(url: String, message: String) = """
        <!doctype html><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>
          body{background:#07090b;color:#d9ffe9;margin:0;min-height:100vh;
               display:grid;place-items:center;font:14px/1.6 monospace;padding:24px}
          div{border-left:2px solid #ff4d5e;padding:4px 0 4px 16px;max-width:36rem}
          h1{font-size:13px;margin:0 0 12px;color:#ff4d5e;letter-spacing:1.5px;
             text-transform:uppercase}
          p{color:#5d8c77;margin:6px 0}
          code{color:#00e676;word-break:break-all}
          .h{color:#39594b;margin-top:18px;font-size:12px}
        </style>
        <div>
          <h1>[ falha na requisicao ]</h1>
          <p>${escape(message)}</p>
          <p><code>${escape(url)}</code></p>
          <p class="h">Se o proxy ou o Orbot estiver ligado, confirme que esta de pe.</p>
        </div>
    """.trimIndent()

    private fun escape(s: String) = s
        .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace("\"", "&quot;").replace("'", "&#39;")
}
