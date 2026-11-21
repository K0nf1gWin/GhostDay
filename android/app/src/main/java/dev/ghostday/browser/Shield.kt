package dev.ghostday.browser

import android.content.Context
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * Injeta o shield de fingerprint no mundo principal da pagina, antes de
 * qualquer script dela.
 *
 * O arquivo vem de shared/shield.js — o MESMO que o desktop injeta por CDP.
 * O Gradle copia para assets/ no preBuild (ver app/build.gradle.kts).
 *
 * addDocumentStartJavaScript e o equivalente exato do
 * Page.addScriptToEvaluateOnNewDocument do CDP. Exige WebView 110+; abaixo
 * disso cai para injecao em onPageStarted, que e pior (a pagina ja comecou a
 * rodar) mas melhor que nada.
 */
object Shield {

    private var source: String? = null

    private fun source(context: Context): String {
        source?.let { return it }
        val js = context.assets.open("shield.js").bufferedReader().use { it.readText() }
        source = js
        return js
    }

    /** IIFE em volta: a declaracao de ghostdayShield nao vaza para window. */
    fun script(context: Context, seed: String): String =
        "(function(){${source(context)}\nghostdayShield(${quote(seed)});})();"

    val supportsDocumentStart: Boolean
        get() = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)

    /**
     * @return true se o script foi registrado para rodar ANTES da pagina.
     *         false significa que o chamador precisa usar [injectLate].
     */
    fun install(webView: WebView, context: Context, seed: String): Boolean {
        if (!supportsDocumentStart) return false
        return runCatching {
            WebViewCompat.addDocumentStartJavaScript(webView, script(context, seed), setOf("*"))
            true
        }.getOrDefault(false)
    }

    /** Plano B para WebView antigo. */
    fun injectLate(webView: WebView, context: Context, seed: String) {
        runCatching { webView.evaluateJavascript(script(context, seed), null) }
    }

    private fun quote(s: String): String =
        "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
}
