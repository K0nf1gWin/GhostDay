package dev.ghostday.browser

import android.content.Context

/** Mesmas chaves do config.json do desktop, guardadas em SharedPreferences. */
class Prefs(context: Context) {

    private val sp = context.getSharedPreferences("ghostday", Context.MODE_PRIVATE)

    companion object {
        const val TOR_SOCKS = "socks5://127.0.0.1:9050"   // Orbot
        const val TOR_HTTP  = "http://127.0.0.1:8118"     // Orbot, fallback
        const val DEFAULT_SEARCH = "https://duckduckgo.com/?q=%s"
        const val DEFAULT_HOME = "https://duckduckgo.com"

        const val MODE_DIRECT = "direct"
        const val MODE_TOR = "tor"
        const val MODE_CUSTOM = "custom"
    }

    var proxyMode: String
        get() = sp.getString("proxyMode", MODE_DIRECT) ?: MODE_DIRECT
        set(v) = sp.edit().putString("proxyMode", v).apply()

    var customProxy: String
        get() = sp.getString("customProxy", TOR_HTTP) ?: TOR_HTTP
        set(v) = sp.edit().putString("customProxy", v).apply()

    var torProxy: String
        get() = sp.getString("torProxy", TOR_SOCKS) ?: TOR_SOCKS
        set(v) = sp.edit().putString("torProxy", v).apply()

    var homepage: String
        get() = sp.getString("homepage", DEFAULT_HOME) ?: DEFAULT_HOME
        set(v) = sp.edit().putString("homepage", v).apply()

    var searchTemplate: String
        get() = sp.getString("searchTemplate", DEFAULT_SEARCH) ?: DEFAULT_SEARCH
        set(v) = sp.edit().putString("searchTemplate", v).apply()

    var blockTrackers: Boolean          by BoolPref(sp, "blockTrackers", true)
    var stripParams: Boolean            by BoolPref(sp, "stripParams", true)
    var httpsOnly: Boolean              by BoolPref(sp, "httpsOnly", true)
    var blockThirdPartyCookies: Boolean by BoolPref(sp, "blockThirdPartyCookies", true)
    var antiFingerprint: Boolean        by BoolPref(sp, "antiFingerprint", true)
    var spoofUserAgent: Boolean         by BoolPref(sp, "spoofUserAgent", true)
    var denyPermissions: Boolean        by BoolPref(sp, "denyPermissions", true)

    /** Modo fantasma: nenhum cookie aceito e tudo apagado ao sair. */
    var ghostMode: Boolean              by BoolPref(sp, "ghostMode", true)
}

private class BoolPref(
    private val sp: android.content.SharedPreferences,
    private val key: String,
    private val default: Boolean
) {
    operator fun getValue(thisRef: Any?, property: kotlin.reflect.KProperty<*>): Boolean =
        sp.getBoolean(key, default)

    operator fun setValue(thisRef: Any?, property: kotlin.reflect.KProperty<*>, value: Boolean) {
        sp.edit().putBoolean(key, value).apply()
    }
}
