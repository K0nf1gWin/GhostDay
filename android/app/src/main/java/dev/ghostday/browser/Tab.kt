package dev.ghostday.browser

import android.webkit.WebView

/** Uma aba: a WebView mais o estado que a UI mostra. */
class Tab(
    val id: Int,
    val webView: WebView,
    val seed: String
) {
    var title: String = "nova aba"
    var url: String = ""
    var loading: Boolean = false
    var blocked: Int = 0

    /** true se o shield foi registrado como document-start (antes da pagina). */
    var shieldEarly: Boolean = false

    val secure: Boolean get() = url.startsWith("https://")

    /** Rotulo curto para a lista de abas: o host, ou o titulo se nao houver. */
    fun label(): String {
        val host = UrlUtils.hostOf(url)
        return when {
            !host.isNullOrBlank() -> host.removePrefix("www.")
            title.isNotBlank() -> title
            else -> "nova aba"
        }
    }
}
