'use strict';
const path = require('node:path');
const { app, BrowserWindow, ipcMain, dialog, clipboard, Menu } = require('electron');

const { Config } = require('./config');
const { seedRules } = require('./blocklist');
const { FilterEngine } = require('./filters');
const { Subscriptions } = require('./subscriptions');
const { NetLog } = require('./netlog');
const metrics = require('./metrics');
const { TabManager } = require('./tabs');
const {
  applyGlobalSwitches, configureDns, wipeSession, proxyReachable, genericUserAgent,
} = require('./privacy');

const CHROME_HEIGHT = 84;    // 38 (tab strip) + 46 (toolbar), igual ao CSS
const PANEL_WIDTH = 420;     // largura reservada quando o painel abre

applyGlobalSwitches(app);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const config = new Config(path.join(app.getPath('userData'), 'config.json'));
const engine = new FilterEngine();
const netlog = new NetLog();

let subs = null;
let win = null;
let tabs = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* ------------------------------------------------------------------ *
 * Janela
 * ------------------------------------------------------------------ */

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 680,
    minHeight: 460,
    backgroundColor: '#07090b',
    title: 'GhostDay',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'ui', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'ui.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));

  tabs = new TabManager({
    win,
    chromeHeight: CHROME_HEIGHT,
    config,
    engine,
    netlog,
    onChange: (state) => send('tabs:state', state),
  });

  tabs.onInput = handleInput;
  win.webContents.on('before-input-event', (event, input) => {
    if (handleInput(input)) event.preventDefault();
  });

  for (const ev of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    win.on(ev, () => tabs.layout());
  }

  win.webContents.on('did-finish-load', async () => {
    send('config:state', config.all());
    if (subs) send('filters:state', subs.status());
    if (tabs.tabs.size === 0) await tabs.newTab(config.get('homepage'));
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  win.on('closed', () => {
    if (tabs) tabs.destroy();
    tabs = null;
    win = null;
  });
}

/* ------------------------------------------------------------------ *
 * Atalhos
 *
 * before-input-event, nao globalShortcut: este ultimo registra no sistema
 * inteiro e roubaria Ctrl+T e Esc de todos os outros programas.
 * ------------------------------------------------------------------ */

function handleInput(input) {
  if (input.type !== 'keyDown' || !tabs) return false;
  const ctrl = input.control || input.meta;
  const key = String(input.key || '');
  const k = key.toLowerCase();

  if (ctrl && input.shift && k === 'n') { tabs.newTab(null, { isolated: true }); return true; }
  if (ctrl && input.shift && k === 'i') { tabs.toggleDevTools(); return true; }
  if (ctrl && input.shift && key === 'Delete') { send('ui:wipe'); return true; }
  if (key === 'F12') { tabs.toggleDevTools(); return true; }
  if (ctrl && k === 't') { tabs.newTab(); return true; }
  if (ctrl && k === 'w') { if (tabs.activeId != null) tabs.close(tabs.activeId); return true; }
  if (ctrl && k === 'r') { tabs.reload(); return true; }
  if (ctrl && k === 'l') { send('ui:focus-address'); return true; }
  if (ctrl && k === 'tab') { cycleTab(input.shift ? -1 : 1); return true; }
  if (key === 'F5') { tabs.reload(); return true; }
  if (key === 'Escape') { tabs.stop(); return true; }
  if (input.alt && key === 'ArrowLeft') { tabs.back(); return true; }
  if (input.alt && key === 'ArrowRight') { tabs.forward(); return true; }

  if (ctrl && /^[1-9]$/.test(key)) {
    const ids = [...tabs.tabs.keys()];
    const idx = key === '9' ? ids.length - 1 : Number(key) - 1;
    if (ids[idx] != null) tabs.select(ids[idx]);
    return true;
  }
  return false;
}

function cycleTab(step) {
  const ids = [...tabs.tabs.keys()];
  if (ids.length < 2) return;
  const at = ids.indexOf(tabs.activeId);
  tabs.select(ids[(at + step + ids.length) % ids.length]);
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

function registerIpc() {
  /* --- abas e navegacao --- */
  ipcMain.handle('tabs:new', (_e, url, opts) => tabs && tabs.newTab(url, opts || {}));
  ipcMain.handle('tabs:close', (_e, id) => tabs && tabs.close(id));
  ipcMain.handle('tabs:select', (_e, id) => tabs && tabs.select(id));
  ipcMain.handle('tabs:state', () => (tabs ? tabs.state() : { tabs: [], activeId: null }));

  ipcMain.handle('nav:go', (_e, input) => tabs && tabs.navigate(input));
  ipcMain.handle('nav:back', () => tabs && tabs.back());
  ipcMain.handle('nav:forward', () => tabs && tabs.forward());
  ipcMain.handle('nav:reload', () => tabs && tabs.reload());
  ipcMain.handle('nav:stop', () => tabs && tabs.stop());
  ipcMain.handle('nav:devtools', () => tabs && tabs.toggleDevTools());

  /* --- configuracao --- */
  ipcMain.handle('config:get', () => config.all());

  ipcMain.handle('config:set', async (_e, key, value) => {
    if (!config.set(key, value)) return { ok: false, error: 'chave desconhecida' };

    if (key === 'proxyMode' || key === 'customProxy' || key === 'torProxy') {
      configureDns(app, config.get('proxyMode'));
      if (tabs) await tabs.refreshProxy();
    }

    const needsReload = ['antiFingerprint', 'spoofUserAgent', 'ephemeral'].includes(key);
    return { ok: true, config: config.all(), needsReload };
  });

  /* --- painel de privacidade --- */
  ipcMain.handle('ui:panel', (_e, open) => {
    if (tabs) tabs.setInset(open ? PANEL_WIDTH : 0);
    return { ok: true };
  });

  ipcMain.handle('privacy:status', async () => {
    const tab = tabs && tabs.active();
    const sess = tab ? tab.view.webContents.session : null;
    const mode = config.get('proxyMode');
    let proxy = { ok: true, resolved: 'DIRECT' };
    if (sess && mode !== 'direct') proxy = await proxyReachable(sess);
    return {
      proxyMode: mode,
      proxy,
      userAgent: config.get('spoofUserAgent') ? genericUserAgent() : (sess ? sess.getUserAgent() : ''),
      ephemeral: config.get('ephemeral'),
      partition: tab ? tab.partition : '',
      rules: engine.stats,
    };
  });

  ipcMain.handle('privacy:wipe', async () => {
    if (!tabs) return { ok: false, error: 'sem janela' };
    const seen = new Set();
    for (const tab of tabs.tabs.values()) {
      const sess = tab.view.webContents.session;
      if (seen.has(sess)) continue;
      seen.add(sess);
      await wipeSession(sess);
    }
    for (const tab of tabs.tabs.values()) {
      if (!tab.view.webContents.isDestroyed()) {
        netlog.clear(tab.view.webContents.id);
        tab.view.webContents.reload();
      }
    }
    return { ok: true, sessions: seen.size };
  });

  /* --- listas de filtro --- */
  ipcMain.handle('filters:status', () => (subs ? subs.status() : null));

  ipcMain.handle('filters:update', async () => {
    if (!subs) return { ok: false };
    return subs.update({ force: true });
  });

  ipcMain.handle('filters:toggle', async (_e, id, enabled) => {
    if (!subs) return { ok: false };
    await subs.setEnabled(id, enabled);
    return { ok: true, status: subs.status() };
  });

  ipcMain.handle('filters:import', async () => {
    if (!win || win.isDestroyed() || !subs) return { ok: false };
    const result = await dialog.showOpenDialog(win, {
      title: 'Importar lista de filtros',
      properties: ['openFile'],
      filters: [{ name: 'Listas', extensions: ['txt', 'list', 'hosts', 'dat'] }],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };
    try {
      return await subs.importFile(result.filePaths[0]);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /* --- rede --- */
  ipcMain.handle('net:log', (_e, opts) => {
    if (!tabs) return null;
    return netlog.view(tabs.activeWebContentsId(), opts || {});
  });

  ipcMain.handle('net:curl', (_e, n) => {
    if (!tabs) return { ok: false };
    const cmd = netlog.curl(tabs.activeWebContentsId(), n);
    if (!cmd) return { ok: false };
    clipboard.writeText(cmd);
    return { ok: true, length: cmd.length };
  });

  ipcMain.handle('net:copy', (_e, text) => {
    clipboard.writeText(String(text || ''));
    return { ok: true };
  });

  ipcMain.handle('net:clear', () => {
    if (tabs) netlog.clear(tabs.activeWebContentsId());
    return { ok: true };
  });

  /* --- recursos --- */
  ipcMain.handle('metrics:get', () => {
    if (!tabs) return { tabs: [], processes: [], totals: { cpu: 0, memMB: 0, processes: 0 } };
    return metrics.collect(app, [...tabs.tabs.values()]);
  });
}

/* ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  configureDns(app, config.get('proxyMode'));
  registerIpc();

  subs = new Subscriptions({
    dir: path.join(app.getPath('userData'), 'filters'),
    engine,
    seed: seedRules,
    onChange: (status) => send('filters:state', status),
  });

  // Semente embutida entra na hora; as listas grandes chegam em segundo plano.
  await subs.init();
  createWindow();

  subs.update({}).catch((err) => console.error('[listas]', err.message));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', () => {
  if (win) { win.show(); win.focus(); }
});

app.on('window-all-closed', () => app.quit());

// Certificado invalido nunca passa silenciosamente.
app.on('certificate-error', (event, _wc, url, error, _cert, callback) => {
  console.error('[tls] certificado rejeitado:', url, error);
  callback(false);
});
