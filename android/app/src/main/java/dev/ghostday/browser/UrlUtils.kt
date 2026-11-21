package dev.ghostday.browser

import android.net.Uri

/**
 * Mesmas regras de URL do desktop (desktop/src/main/privacy.js e tabs.js):
 * limpeza de parametros de rastreio, upgrade para HTTPS, eTLD+1 e a decisao
 * entre "isso e um endereco" e "isso e uma busca".
 */
object UrlUtils {

    private val TRACKING_PARAMS = setOf(
        "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
        "utm_name", "utm_cid", "utm_reader", "utm_referrer", "utm_social", "utm_brand",
        "fbclid", "gclid", "gclsrc", "dclid", "gbraid", "wbraid", "msclkid", "twclid",
        "ttclid", "igshid", "igsh", "li_fat_id", "mc_cid", "mc_eid", "vero_id",
        "_hsenc", "_hsmi", "hsCtaTracking", "mkt_tok", "yclid", "_openstat",
        "wickedid", "oly_anon_id", "oly_enc_id", "rb_clickid", "s_cid", "ss_email_id",
        "ref_src", "ref_url", "spm", "scm", "share_source"
    )

    // Heuristica, nao Public Suffix List: cobre os sufixos de dois niveis comuns.
    private val TWO_LEVEL = setOf(
        "com.br", "net.br", "org.br", "gov.br", "edu.br", "art.br", "blog.br",
        "co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "co.kr", "co.in", "co.za",
        "com.ar", "com.mx", "com.au", "com.pt", "com.es", "com.tr", "com.cn"
    )

    private val PRIVATE_HOST = Regex(
        """^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|""" +
        """172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)$""",
        RegexOption.IGNORE_CASE
    )

    private val IPV4 = Regex("""^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#].*)?$""")
    private val HOSTISH = Regex("""^[^\s/?#]+\.[a-z]{2,}(:\d+)?([/?#].*)?$""", RegexOption.IGNORE_CASE)
    private val LOCALISH = Regex(
        """^(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|""" +
        """172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?([/?#].*)?$""",
        RegexOption.IGNORE_CASE
    )
    private val SCHEME = Regex("""^[a-z][a-z0-9+.\-]*://""", RegexOption.IGNORE_CASE)

    fun hostOf(url: String): String? = runCatching { Uri.parse(url).host?.lowercase() }.getOrNull()

    fun isPrivateHost(host: String?): Boolean = host != null && PRIVATE_HOST.matches(host)

    /** eTLD+1 aproximado, para decidir o que e requisicao de terceiro. */
    fun siteOf(hostname: String?): String {
        val host = hostname?.lowercase() ?: return ""
        val parts = host.split('.')
        if (parts.size <= 2) return host
        val last2 = parts.takeLast(2).joinToString(".")
        return if (last2 in TWO_LEVEL) parts.takeLast(3).joinToString(".") else last2
    }

    fun siteOfUrl(url: String?): String = siteOf(url?.let { hostOf(it) })

    /** Remove parametros de rastreio. Devolve null se nada mudou. */
    fun clean(url: String): String? {
        val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return null
        val names = runCatching { uri.queryParameterNames }.getOrNull() ?: return null
        if (names.isEmpty()) return null
        if (names.none { it in TRACKING_PARAMS }) return null

        val builder = uri.buildUpon().clearQuery()
        for (name in names) {
            if (name in TRACKING_PARAMS) continue
            for (value in uri.getQueryParameters(name)) builder.appendQueryParameter(name, value)
        }
        return builder.build().toString()
    }

    /** http:// -> https://, exceto em loopback/rede local. Null se nao se aplica. */
    fun upgrade(url: String): String? {
        val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return null
        if (!"http".equals(uri.scheme, ignoreCase = true)) return null
        if (isPrivateHost(uri.host?.lowercase())) return null
        return uri.buildUpon().scheme("https").build().toString()
    }

    /** O texto da barra: endereco ou busca? */
    fun toUrl(input: String, searchTemplate: String): String {
        val text = input.trim()
        if (text.isEmpty()) return "about:blank"
        if (SCHEME.containsMatchIn(text)) return text
        if (text.startsWith("about:") || text.startsWith("data:")) return text
        if (LOCALISH.matches(text)) return "http://$text"      // LAN quase nunca tem TLS
        if (HOSTISH.matches(text) || IPV4.matches(text)) return "https://$text"
        return searchTemplate.replace("%s", Uri.encode(text))
    }
}
