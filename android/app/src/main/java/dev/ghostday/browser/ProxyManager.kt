package dev.ghostday.browser

import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import java.util.concurrent.Executor

/**
 * Rota de rede do WebView.
 *
 * ProxyController vale para TODOS os WebViews do processo, entao nao existe
 * "proxy por aba" aqui — diferente do desktop, onde cada sessao tem o seu.
 *
 * Para Tor, o Orbot expoe SOCKS5 em 9050 e HTTP em 8118. O suporte a socks5 no
 * ProxyConfig depende da versao do WebView; se a aplicacao falhar, a UI cai
 * para o HTTP do Orbot, que funciona em qualquer versao.
 */
object ProxyManager {

    val supported: Boolean
        get() = WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)

    data class Result(val ok: Boolean, val applied: String, val error: String? = null)

    fun apply(prefs: Prefs, executor: Executor, onDone: (Result) -> Unit) {
        if (!supported) {
            onDone(Result(false, "", "este WebView nao suporta proxy override"))
            return
        }

        val controller = ProxyController.getInstance()

        if (prefs.proxyMode == Prefs.MODE_DIRECT) {
            runCatching { controller.clearProxyOverride(executor) { onDone(Result(true, "direto")) } }
                .onFailure { onDone(Result(false, "", it.message)) }
            return
        }

        val rule = when (prefs.proxyMode) {
            Prefs.MODE_TOR -> prefs.torProxy
            else -> prefs.customProxy
        }

        val config = runCatching {
            ProxyConfig.Builder()
                .addProxyRule(rule)
                .addDirect()                 // se o proxy nao atender, nao fica offline mudo
                .build()
        }.getOrElse {
            onDone(Result(false, "", "regra de proxy invalida: $rule"))
            return
        }

        runCatching {
            controller.setProxyOverride(config, executor) { onDone(Result(true, rule)) }
        }.onFailure {
            onDone(Result(false, "", it.message ?: "falha ao aplicar $rule"))
        }
    }
}
