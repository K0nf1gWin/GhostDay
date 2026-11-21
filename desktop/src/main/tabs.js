'use strict';
const path = require('node:path');
const { WebContentsView, session: electronSession, shell } = require('electron');
const { hardenSession, applyProxy } = require('./privacy');
const { buildScript } = require('./fingerprint');

const BLANK = 'about:blank';

class TabManager {
  /**
   * @param {object}   o
   * @param {Electron.BrowserWindow} o.win   janela hospedeira
   * @param {number}   o.chromeHeight        altura da UI no topo
   * @param {Config}   o.config
   * @param {Blocklist} o.blocklist
   * @param {Function} o.onChange            avisa a UI que o estado mudou
   */
  constructor({ win, chromeHeight, config, blocklist, onChange }) {
    this.win = win;
    this.chromeHeight = chromeHeight;
    this.config = config;
    this.blocklist = blocklist;
    this.onChange = onChange || (() => {});
    this.tabs = new Map();
    this.activeId = null;
    this.nextId = 1;
    this.launchSeed = Math.random().toString(36).slice(2) + Date.now().toString(36);
    this.sessions = new Map();
    this.insetRight = 0;        // espaco reservado a direita (painel aberto)
    this.onInput = null;        // handler de atalhos, injetado pelo main
  }

  /* ---------------- sessoes ---------------- */

  /** Partition da sessao comum: em memoria se ephemeral, em disco se nao. */
  defaultPartition() {
    return this.config.get('ephemeral')
      ? `ghostday-volatil-${this.launchSeed}`
      : 'persist:ghostday';
  }

  /** Sessao pronta: endurecida, com proxy e contador de bloqueios. */
  async getSession(partition) {
    if (this.sessions.has(partition)) return this.sessions.get(partition);

    const sess = electronSession.fromPartition(partition);
    hardenSession(sess, {
      config: this.config,
      blocklist: this.blocklist,
      onBlocked: (details) => this.countBlock(details.webContentsId),
    });
    await applyProxy(sess, this.config);

    sess.on('will-download', (_e, item) => {
      // savePath vazio => Electron abre o dialogo de salvar; quem decide e voce.
      console.log('[download]', item.getFilename(), item.getTotalBytes(), 'bytes');
    });

    this.sessions.set(partition, sess);
    return sess;
  }

  /** Reaplica o proxy em todas as sessoes vivas. */
  async refreshProxy() {
    const results = [];
    for (const sess of this.sessions.values()) {
      results.push(await applyProxy(sess, this.config));
    }
    return results[0] || { mode: this.config.get('proxyMode'), rules: '' };
  }

  /* ---------------- abas ---------------- */

  async newTab(url, { isolated = false, background = false } = {}) {
    const id = this.nextId++;
    const partition = isolated
      ? `ghostday-iso-${id}-${this.launchSeed}`
      : this.defaultPartition();

    await this.getSession(partition);

    const view = new WebContentsView({
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        autoplayPolicy: 'user-gesture-required',
        backgroundThrottling: true,
      },
    });

    const tab = {
      id,
      view,
      isolated,
      partition,
      url: '',
      title: isolated ? 'Aba isolada' : 'Nova aba',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      blocked: 0,
      secure: false,
    };

    this.tabs.set(id, tab);
    this.win.contentView.addChildView(view);
    this.wire(tab);
    if (this.config.get('antiFingerprint')) this.installFingerprintShield(tab);

    const target = url || this.config.get('homepage');
    view.webContents.loadURL(target).catch((err) => {
      console.error('[tab] loadURL falhou:', err.message);
    });

    if (background && this.activeId != null) {
      view.setVisible(false);
    } else {
      this.select(id);
    }
    this.layout();
    this.emit();
    return id;
  }

  /** Injeta as defesas de fingerprint antes de qualquer script da pagina. */
  installFingerprintShield(tab) {
    const wc = tab.view.webContents;
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      wc.debugger.sendCommand('Page.enable').catch(() => {});
      const source = buildScript(`${this.launchSeed}:${tab.id}`);
      wc.debugger
        .sendCommand('Page.addScriptToEvaluateOnNewDocument', { source, runImmediately: true })
        .catch(() =>
          // CDP mais antigo nao conhece runImmediately: tenta sem ele.
          wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source })
        )
        .catch((err) => console.error('[fp] injecao falhou:', err.message));
    } catch (err) {
      console.error('[fp] debugger indisponivel:', err.message);
    }
  }

  countBlock(webContentsId) {
    for (const tab of this.tabs.values()) {
      if (!tab.view.webContents.isDestroyed() && tab.view.webContents.id === webContentsId) {
        tab.blocked++;
        this.emit();
        return;
      }
    }
  }

  wire(tab) {
    const wc = tab.view.webContents;

    const sync = () => {
      if (wc.isDestroyed()) return;
      tab.url = wc.getURL();
      tab.title = wc.getTitle() || tab.title;
      tab.canGoBack = wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack();
      tab.canGoForward = wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward();
      tab.secure = tab.url.startsWith('https://');
      this.emit();
    };

    wc.on('did-start-loading', () => { tab.loading = true; this.emit(); });
    wc.on('did-stop-loading', () => { tab.loading = false; sync(); });
    wc.on('page-title-updated', (_e, title) => { tab.title = title; this.emit(); });
    wc.on('did-navigate', () => { tab.blocked = 0; sync(); });
    wc.on('did-navigate-in-page', sync);
    wc.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3) return;   // -3 = abortado pelo usuario
      tab.title = 'Falha ao carregar';
      this.emit();
      const msg = `${desc} (${code})`;
      wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(errorPage(failedUrl, msg)))
        .catch(() => {});
    });

    // Links com target=_blank / window.open viram abas, nunca janelas soltas.
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) {
        this.newTab(url, { isolated: tab.isolated, background: true });
      }
      return { action: 'deny' };
    });

    // Atalhos funcionam mesmo com o foco dentro da pagina.
    wc.on('before-input-event', (event, input) => {
      if (this.onInput && this.onInput(input)) event.preventDefault();
    });

    // Protocolos externos (mailto:, tel:, custom://) nao abrem sozinhos.
    wc.on('will-navigate', (event, url) => {
      if (!/^(https?|about|data|blob):/i.test(url)) {
        event.preventDefault();
        console.log('[nav] protocolo externo bloqueado:', url);
      }
    });
  }

  /* ---------------- controle ---------------- */

  select(id) {
    if (!this.tabs.has(id)) return false;
    for (const [tid, tab] of this.tabs) tab.view.setVisible(tid === id);
    this.activeId = id;
    this.layout();
    this.emit();
    return true;
  }

  close(id) {
    const tab = this.tabs.get(id);
    if (!tab) return false;

    const wc = tab.view.webContents;
    try {
      if (wc.debugger.isAttached()) wc.debugger.detach();
    } catch { /* ja solto */ }

    this.win.contentView.removeChildView(tab.view);
    if (!wc.isDestroyed()) wc.close();
    this.tabs.delete(id);

    // Sessao isolada morre com a aba.
    if (tab.isolated) {
      const sess = this.sessions.get(tab.partition);
      if (sess) {
        sess.clearStorageData().catch(() => {});
        this.sessions.delete(tab.partition);
      }
    }

    if (this.activeId === id) {
      const remaining = [...this.tabs.keys()];
      this.activeId = null;
      if (remaining.length) this.select(remaining[remaining.length - 1]);
    }
    this.emit();
    return true;
  }

  active() {
    return this.activeId != null ? this.tabs.get(this.activeId) : null;
  }

  withActive(fn) {
    const tab = this.active();
    if (!tab || tab.view.webContents.isDestroyed()) return false;
    fn(tab.view.webContents, tab);
    return true;
  }

  navigate(input) {
    const url = toUrl(input, this.config.get('searchTemplate'));
    return this.withActive((wc) => wc.loadURL(url).catch((e) => console.error('[nav]', e.message)));
  }

  back()    { return this.withActive((wc) => goBack(wc)); }
  forward() { return this.withActive((wc) => goForward(wc)); }
  reload()  { return this.withActive((wc) => wc.reload()); }
  stop()    { return this.withActive((wc) => wc.stop()); }

  /** Reserva espaco a direita: o painel da UI e desenhado ATRAS das views,
   *  entao a pagina encolhe em vez de ficar escondida. */
  setInset(right) {
    this.insetRight = Math.max(0, right | 0);
    this.layout();
  }

  layout() {
    if (!this.win || this.win.isDestroyed()) return;
    const { width, height } = this.win.getContentBounds();
    const y = this.chromeHeight;
    const bounds = {
      x: 0,
      y,
      width: Math.max(120, width - this.insetRight),
      height: Math.max(0, height - y),
    };
    for (const tab of this.tabs.values()) tab.view.setBounds(bounds);
  }

  state() {
    return {
      activeId: this.activeId,
      tabs: [...this.tabs.values()].map((t) => ({
        id: t.id,
        title: t.title,
        url: t.url,
        loading: t.loading,
        isolated: t.isolated,
        canGoBack: t.canGoBack,
        canGoForward: t.canGoForward,
        blocked: t.blocked,
        secure: t.secure,
      })),
    };
  }

  emit() { this.onChange(this.state()); }

  destroy() {
    for (const id of [...this.tabs.keys()]) this.close(id);
  }
}

/* ---------------- helpers ---------------- */

function goBack(wc) {
  if (wc.navigationHistory) { if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); }
  else if (wc.canGoBack()) wc.goBack();
}

function goForward(wc) {
  if (wc.navigationHistory) { if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); }
  else if (wc.canGoForward()) wc.goForward();
}

/** Decide se o texto digitado e URL ou busca. */
function toUrl(input, searchTemplate) {
  const text = String(input || '').trim();
  if (!text) return BLANK;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  if (/^(about|data|blob):/i.test(text)) return text;

  // Host local ou IP de rede privada: http, porque quase nunca tem TLS.
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?([/?#]|$)/i.test(text);
  if (isLocal) return 'http://' + text;

  const isIPv4 = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(text);
  const looksLikeHost = /^[^\s/?#]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(text);
  if (looksLikeHost || isIPv4) return 'https://' + text;

  return searchTemplate.replace('%s', encodeURIComponent(text));
}

function errorPage(url, message) {
  return `<!doctype html><meta charset="utf-8">
<style>
  body{background:#07090b;color:#d9ffe9;margin:0;height:100vh;
       display:grid;place-items:center;
       font:13px/1.6 "Cascadia Mono","JetBrains Mono",Consolas,monospace}
  div{max-width:36rem;padding:2rem;border-left:2px solid #ff4d5e}
  h1{font-size:13px;margin:0 0 .9rem;color:#ff4d5e;
     text-transform:uppercase;letter-spacing:1.5px;font-weight:600}
  p{color:#5d8c77;margin:.45rem 0}
  code{color:#00e676;word-break:break-all}
  .hint{color:#39594b;margin-top:1.2rem;font-size:12px}
</style>
<div>
  <h1>[ falha na requisicao ]</h1>
  <p>${escapeHtml(message)}</p>
  <p><code>${escapeHtml(url)}</code></p>
  <p class="hint">Se o proxy ou o Tor estiver ligado, confirme que esta de pe.</p>
</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

module.exports = { TabManager, toUrl };
