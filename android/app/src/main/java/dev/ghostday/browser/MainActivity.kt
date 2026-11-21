package dev.ghostday.browser

import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat
import java.util.concurrent.Executor

class MainActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private lateinit var tabs: TabManager

    private lateinit var content: FrameLayout
    private lateinit var address: EditText
    private lateinit var scheme: TextView
    private lateinit var shield: TextView
    private lateinit var progress: ProgressBar
    private lateinit var tabCount: TextView
    private lateinit var btnBack: ImageButton
    private lateinit var btnForward: ImageButton
    private lateinit var panel: View
    private lateinit var statusRows: LinearLayout
    private lateinit var toggleRows: LinearLayout
    private lateinit var proxyLabel: TextView

    private var addressFocused = false
    private val uiExecutor = Executor { command -> runOnUiThread(command) }

    /** Chave de pref, rotulo, dica, e se exige recarregar para valer. */
    private val toggles = listOf(
        Toggle("blockTrackers", "Bloquear rastreadores",
            "Cancela requisicoes a dominios de analytics e anuncio.", false),
        Toggle("stripParams", "Limpar URLs",
            "Remove utm_*, fbclid, gclid e companhia.", false),
        Toggle("httpsOnly", "Forcar HTTPS",
            "Sobe http:// para https:// (menos em rede local).", false),
        Toggle("blockThirdPartyCookies", "Barrar cookies de terceiro",
            "Bloqueio nativo do WebView para cookies cross-site.", false),
        Toggle("antiFingerprint", "Anti-fingerprint",
            "Ruido em canvas/WebGL/audio, navigator generico.", true),
        Toggle("spoofUserAgent", "User agent generico",
            "Finge um Chrome comum no Android.", false),
        Toggle("denyPermissions", "Negar permissoes",
            "Camera, microfone e geolocalizacao.", false),
        Toggle("ghostMode", "Modo fantasma",
            "Nenhum cookie aceito; tudo apagado ao sair.", true)
    )

    data class Toggle(val key: String, val label: String, val hint: String, val needsReload: Boolean)

    /* ------------------------------------------------------------------ */

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = Prefs(this)
        bindViews()

        tabs = TabManager(this, content, prefs) { render() }
        applyProxy(announce = false)
        tabs.newTab(intent?.dataString)

        wireToolbar()
        wireAddressBar()
        wirePanel()
        wireBackButton()
        render()
    }

    private fun bindViews() {
        content = findViewById(R.id.content)
        address = findViewById(R.id.address)
        scheme = findViewById(R.id.scheme)
        shield = findViewById(R.id.shield)
        progress = findViewById(R.id.progress)
        tabCount = findViewById(R.id.tab_count)
        btnBack = findViewById(R.id.btn_back)
        btnForward = findViewById(R.id.btn_forward)
        panel = findViewById(R.id.panel)
        statusRows = findViewById(R.id.status_rows)
        toggleRows = findViewById(R.id.toggle_rows)
        proxyLabel = findViewById(R.id.proxy_label)
    }

    /* ---------------- barra inferior ---------------- */

    private fun wireToolbar() {
        btnBack.setOnClickListener { tabs.back() }
        btnForward.setOnClickListener { tabs.forward() }
        findViewById<ImageButton>(R.id.btn_reload).setOnClickListener {
            if (tabs.active()?.loading == true) tabs.stop() else tabs.reload()
        }
        findViewById<View>(R.id.btn_tabs).setOnClickListener { showTabSwitcher() }
        findViewById<ImageButton>(R.id.btn_panel).setOnClickListener { togglePanel() }
        shield.setOnClickListener { togglePanel() }
    }

    private fun wireAddressBar() {
        address.setOnFocusChangeListener { _, hasFocus ->
            addressFocused = hasFocus
            if (hasFocus) address.selectAll() else render()
        }
        address.setOnEditorActionListener { _, actionId, event ->
            val done = actionId == EditorInfo.IME_ACTION_GO ||
                actionId == EditorInfo.IME_ACTION_DONE ||
                event?.keyCode == KeyEvent.KEYCODE_ENTER
            if (done) {
                tabs.go(address.text.toString())
                hideKeyboard()
                address.clearFocus()
            }
            done
        }
    }

    private fun wireBackButton() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    panel.visibility == View.VISIBLE -> togglePanel()
                    tabs.back() -> Unit
                    tabs.count() > 1 -> tabs.active()?.let { tabs.close(it.id) }
                    else -> finish()
                }
            }
        })
    }

    /* ---------------- painel ---------------- */

    private fun wirePanel() {
        findViewById<Button>(R.id.btn_proxy_direct).setOnClickListener { setProxy(Prefs.MODE_DIRECT) }
        findViewById<Button>(R.id.btn_proxy_tor).setOnClickListener { setProxy(Prefs.MODE_TOR) }
        findViewById<Button>(R.id.btn_proxy_custom).setOnClickListener { askCustomProxy() }
        findViewById<Button>(R.id.btn_wipe).setOnClickListener {
            tabs.wipe()
            toast("Cookies, cache e storage apagados.")
            renderPanel()
        }
        findViewById<Button>(R.id.btn_panel_close).setOnClickListener { togglePanel() }
        buildToggles()
    }

    private fun buildToggles() {
        toggleRows.removeAllViews()
        val inflater = layoutInflater
        for (t in toggles) {
            val row = inflater.inflate(R.layout.row_toggle, toggleRows, false)
            val sw = row.findViewById<SwitchCompat>(R.id.toggle_switch)
            row.findViewById<TextView>(R.id.toggle_label).text = t.label
            row.findViewById<TextView>(R.id.toggle_hint).text = t.hint
            sw.isChecked = readPref(t.key)
            sw.setOnCheckedChangeListener { _, checked ->
                writePref(t.key, checked)
                tabs.refreshSettings()
                if (t.needsReload) toast("Vale para as abas abertas a partir de agora.")
                renderPanel()
            }
            row.setOnClickListener { sw.toggle() }
            toggleRows.addView(row)
        }
    }

    private fun readPref(key: String): Boolean = when (key) {
        "blockTrackers" -> prefs.blockTrackers
        "stripParams" -> prefs.stripParams
        "httpsOnly" -> prefs.httpsOnly
        "blockThirdPartyCookies" -> prefs.blockThirdPartyCookies
        "antiFingerprint" -> prefs.antiFingerprint
        "spoofUserAgent" -> prefs.spoofUserAgent
        "denyPermissions" -> prefs.denyPermissions
        "ghostMode" -> prefs.ghostMode
        else -> false
    }

    private fun writePref(key: String, value: Boolean) {
        when (key) {
            "blockTrackers" -> prefs.blockTrackers = value
            "stripParams" -> prefs.stripParams = value
            "httpsOnly" -> prefs.httpsOnly = value
            "blockThirdPartyCookies" -> prefs.blockThirdPartyCookies = value
            "antiFingerprint" -> prefs.antiFingerprint = value
            "spoofUserAgent" -> prefs.spoofUserAgent = value
            "denyPermissions" -> prefs.denyPermissions = value
            "ghostMode" -> prefs.ghostMode = value
        }
    }

    private fun togglePanel() {
        val opening = panel.visibility != View.VISIBLE
        panel.visibility = if (opening) View.VISIBLE else View.GONE
        if (opening) renderPanel()
    }

    /* ---------------- proxy ---------------- */

    private fun setProxy(mode: String) {
        prefs.proxyMode = mode
        applyProxy(announce = true)
    }

    private fun askCustomProxy() {
        val input = EditText(this).apply {
            setText(prefs.customProxy)
            hint = "http://127.0.0.1:8118"
            setTextColor(0xFFD9FFE9.toInt())
            setHintTextColor(0xFF39594B.toInt())
        }
        AlertDialog.Builder(this)
            .setTitle("Proxy personalizado")
            .setView(input)
            .setPositiveButton("Aplicar") { _, _ ->
                prefs.customProxy = input.text.toString().trim()
                setProxy(Prefs.MODE_CUSTOM)
            }
            .setNegativeButton("Cancelar", null)
            .show()
    }

    private fun applyProxy(announce: Boolean) {
        ProxyManager.apply(prefs, uiExecutor) { result ->
            if (!result.ok) {
                val hint = if (prefs.proxyMode == Prefs.MODE_TOR)
                    " Se o Orbot so expuser HTTP, use o proxy personalizado ${Prefs.TOR_HTTP}."
                else ""
                toast("Proxy nao aplicado: ${result.error ?: "erro"}.$hint")
                prefs.proxyMode = Prefs.MODE_DIRECT
            } else if (announce) {
                toast(if (result.applied == "direto") "Rota direta." else "Rota via ${result.applied}.")
            }
            renderPanel()
            render()
        }
    }

    /* ---------------- abas ---------------- */

    private fun showTabSwitcher() {
        val list = tabs.list()
        val labels = list.map { tab ->
            (if (tab.id == tabs.activeId) "> " else "  ") + tab.label()
        }.toMutableList()
        labels.add("+ nova aba")

        AlertDialog.Builder(this)
            .setTitle("Abas (${list.size}/${TabManager.MAX_TABS})")
            .setItems(labels.toTypedArray()) { _, which ->
                if (which == list.size) {
                    if (tabs.newTab() == null) toast("Limite de ${TabManager.MAX_TABS} abas.")
                } else {
                    tabs.select(list[which].id)
                }
            }
            .setNeutralButton("Fechar aba atual") { _, _ ->
                tabs.active()?.let { tabs.close(it.id) }
            }
            .setNegativeButton("Voltar", null)
            .show()
    }

    /* ---------------- render ---------------- */

    private fun render() {
        val tab = tabs.active()

        if (!addressFocused) {
            val url = tab?.url.orEmpty()
            address.setText(if (url == "about:blank") "" else url)
        }

        when {
            tab == null || tab.url.isBlank() || tab.url == "about:blank" -> {
                scheme.text = ""
                scheme.setTextColor(COLOR_MUTE)
            }
            tab.secure -> {
                scheme.text = "https"
                scheme.setTextColor(COLOR_ACCENT)
            }
            else -> {
                scheme.text = "sem tls"
                scheme.setTextColor(COLOR_DANGER)
            }
        }

        val blocked = tab?.blocked ?: 0
        shield.text = blocked.toString()
        shield.setTextColor(if (blocked > 0) COLOR_ACCENT else COLOR_MUTE)

        progress.visibility = if (tab?.loading == true) View.VISIBLE else View.INVISIBLE
        tabCount.text = tabs.count().toString()

        btnBack.isEnabled = tab?.webView?.canGoBack() == true
        btnForward.isEnabled = tab?.webView?.canGoForward() == true
        btnBack.alpha = if (btnBack.isEnabled) 1f else 0.25f
        btnForward.alpha = if (btnForward.isEnabled) 1f else 0.25f

        if (panel.visibility == View.VISIBLE) renderPanel()
    }

    private fun renderPanel() {
        proxyLabel.text = when (prefs.proxyMode) {
            Prefs.MODE_TOR -> "tor  ${prefs.torProxy}"
            Prefs.MODE_CUSTOM -> "proxy  ${prefs.customProxy}"
            else -> "direta"
        }

        statusRows.removeAllViews()
        addRow("Rota", proxyLabel.text.toString(), prefs.proxyMode != Prefs.MODE_DIRECT)
        addRow("Sessao", if (prefs.ghostMode) "fantasma (sem cookies)" else "normal", prefs.ghostMode)
        addRow("Lista de bloqueio", "${Blocklist.size} dominios", false)
        addRow("Bloqueios na sessao", Blocklist.blockedCount.toString(), false)
        addRow(
            "Shield",
            if (Shield.supportsDocumentStart) "document-start" else "tardio (WebView antigo)",
            Shield.supportsDocumentStart
        )
        addRow("Proxy override", if (ProxyManager.supported) "disponivel" else "indisponivel",
            ProxyManager.supported)
    }

    private fun addRow(key: String, value: String, good: Boolean) {
        val row = layoutInflater.inflate(R.layout.row_status, statusRows, false)
        row.findViewById<TextView>(R.id.row_key).text = key
        row.findViewById<TextView>(R.id.row_value).apply {
            text = value
            setTextColor(if (good) COLOR_ACCENT else COLOR_DIM)
        }
        statusRows.addView(row)
    }

    /* ---------------- util ---------------- */

    private fun toast(message: String) =
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()

    private fun hideKeyboard() {
        val imm = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
        imm.hideSoftInputFromWindow(address.windowToken, 0)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.dataString?.let { tabs.newTab(it) }
    }

    override fun onPause() { super.onPause(); tabs.onPause() }
    override fun onResume() { super.onResume(); tabs.onResume() }

    override fun onDestroy() {
        // Modo fantasma: nada sobrevive ao fechamento.
        tabs.destroy(wipeFirst = prefs.ghostMode)
        super.onDestroy()
    }

    companion object {
        private const val COLOR_ACCENT = 0xFF00E676.toInt()
        private const val COLOR_DANGER = 0xFFFF4D5E.toInt()
        private const val COLOR_DIM = 0xFF5D8C77.toInt()
        private const val COLOR_MUTE = 0xFF39594B.toInt()
    }
}
