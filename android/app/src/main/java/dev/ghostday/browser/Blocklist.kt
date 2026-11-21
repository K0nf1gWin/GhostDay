package dev.ghostday.browser

/**
 * Lista de bloqueio por dominio.
 *
 * A semente e gerada a partir de desktop/src/main/blocklist.js — os dois apps
 * bloqueiam exatamente os mesmos dominios. Listas extras (EasyList, hosts)
 * podem ser importadas em runtime por [loadFrom].
 *
 * Lida de uma thread de rede (shouldInterceptRequest), entao as estruturas sao
 * trocadas por referencia em vez de mutadas no lugar.
 */
object Blocklist {

    private val seed: Set<String> = setOf(
    "google-analytics.com",
    "analytics.google.com",
    "googletagmanager.com",
    "googletagservices.com",
    "googlesyndication.com",
    "googleadservices.com",
    "doubleclick.net",
    "adservice.google.com",
    "pagead2.googlesyndication.com",
    "connect.facebook.net",
    "graph.facebook.com",
    "pixel.facebook.com",
    "an.facebook.com",
    "analytics.tiktok.com",
    "business-api.tiktok.com",
    "ads-api.twitter.com",
    "analytics.twitter.com",
    "static.ads-twitter.com",
    "ads.linkedin.com",
    "px.ads.linkedin.com",
    "snap.licdn.com",
    "bat.bing.com",
    "clarity.ms",
    "c.clarity.ms",
    "scorecardresearch.com",
    "quantserve.com",
    "quantcount.com",
    "criteo.com",
    "criteo.net",
    "taboola.com",
    "outbrain.com",
    "pubmatic.com",
    "rubiconproject.com",
    "openx.net",
    "adnxs.com",
    "adsrvr.org",
    "casalemedia.com",
    "sharethrough.com",
    "teads.tv",
    "smartadserver.com",
    "yieldmo.com",
    "3lift.com",
    "bidswitch.net",
    "mathtag.com",
    "rlcdn.com",
    "crwdcntrl.net",
    "demdex.net",
    "omtrdc.net",
    "everesttech.net",
    "adobedtm.com",
    "hotjar.com",
    "hotjar.io",
    "fullstory.com",
    "mouseflow.com",
    "luckyorange.com",
    "smartlook.com",
    "inspectlet.com",
    "crazyegg.com",
    "mixpanel.com",
    "api.mixpanel.com",
    "segment.com",
    "api.segment.io",
    "cdn.segment.com",
    "amplitude.com",
    "api.amplitude.com",
    "heap.io",
    "heapanalytics.com",
    "braze.com",
    "appsflyer.com",
    "adjust.com",
    "branch.io",
    "kochava.com",
    "singular.net",
    "onesignal.com",
    "pushwoosh.com",
    "urbanairship.com",
    "newrelic.com",
    "nr-data.net",
    "bugsnag.com",
    "sentry.io",
    "rollbar.com",
    "loggly.com",
    "mparticle.com",
    "tealiumiq.com",
    "krxd.net",
    "exelator.com",
    "bluekai.com",
    "addthis.com",
    "sharethis.com",
    "disqus.com",
    "zopim.com",
    "intercom.io",
    "drift.com",
    "hubspot.com",
    "hs-analytics.net",
    "hsforms.net",
    "marketo.net",
    "mktoresp.com",
    "pardot.com",
    "eloqua.com",
    "yandex.ru",
    "mc.yandex.ru",
    "metrika.yandex.ru",
    "top-fwz1.mail.ru",
    "vk.com",
    "stats.wp.com",
    "pixel.wp.com",
    "moatads.com",
    "doubleverify.com",
    "adsafeprotected.com",
    "ipredictive.com",
    "zemanta.com",
    "revcontent.com",
    "mgid.com",
    "propellerads.com",
    "popads.net"
    )

    @Volatile private var hosts: Set<String> = seed
    @Volatile private var allowed: Set<String> = emptySet()

    @Volatile var blockedCount: Int = 0
        private set

    val size: Int get() = hosts.size

    /** Importa EasyList (||dominio^), formato hosts (0.0.0.0 dominio) ou um por linha. */
    fun loadFrom(text: String): Int {
        val before = hosts.size
        val merged = hosts.toMutableSet()
        text.lineSequence().forEach { raw ->
            val line = raw.trim()
            if (line.isEmpty() || line.startsWith("!") || line.startsWith("#") || line.startsWith("[")) {
                return@forEach
            }
            hostsFormat.find(line)?.let { merged += it.groupValues[1].lowercase(); return@forEach }
            easyFormat.find(line)?.let { merged += it.groupValues[1].lowercase(); return@forEach }
            if (bareDomain.matches(line) && line.contains(".")) merged += line.lowercase()
        }
        hosts = merged
        return merged.size - before
    }

    fun allow(host: String) {
        allowed = allowed + host.lowercase()
    }

    fun resetCount() { blockedCount = 0 }

    /** Casa o host e qualquer dominio pai: ads.foo.co.uk -> foo.co.uk. */
    fun matches(hostname: String?): Boolean {
        val host = hostname?.lowercase() ?: return false
        val parts = host.split('.')
        val currentHosts = hosts
        val currentAllowed = allowed
        for (i in 0 until parts.size - 1) {
            val candidate = parts.subList(i, parts.size).joinToString(".")
            if (candidate in currentAllowed) return false
            if (candidate in currentHosts) return true
        }
        return false
    }

    fun shouldBlock(url: String): Boolean {
        val host = UrlUtils.hostOf(url) ?: return false
        if (!matches(host)) return false
        blockedCount++
        return true
    }

    private val hostsFormat = Regex("""^(?:0\.0\.0\.0|127\.0\.0\.1)\s+(\S+)$""")
    private val easyFormat  = Regex("""^\|\|([a-z0-9.-]+)\^?(?:\${'$'}third-party)?$""", RegexOption.IGNORE_CASE)
    private val bareDomain  = Regex("""^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$""", RegexOption.IGNORE_CASE)
}
