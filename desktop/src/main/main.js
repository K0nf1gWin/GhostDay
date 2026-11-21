'use strict';
const path = require('node:path');
const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');

const { Config } = require('./config');
const { Blocklist } = require('./blocklist');
const { TabManager } = require('./tabs');
const {
  applyGlobalSwitches, configureDns, wipeSession, proxyReachable, genericUserAgent,
} = require('./privacy');

const CHROME_HEIGHT = 84;   // 38 (tab strip) + 46 (toolbar), igual ao CSS

applyGlobalSwitches(app);

// Instancia unica: evita duas janelas disputando a mesma sessao em disco.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const config = new Config(path.join(app.getPath('userData'), 'config.json'));
const blocklist = new Blocklist();

let win = null;
let tabs = null;

/* ------------------------------------------------------------------ */

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 620,
    minHeight: 420,
    backgroundColor: '#07090b',
    title: 'GhostDay',
    icon: path.join(__dirname, '..', 'ui', 'icon.png'),
    autoHideMenuBar: true,
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
    blocklist,
    onChange: (state) => send('tabs:state', state),
  });

  tabs.onInput = handleInput;
  win.webContents.on('before-input-event', (event, input) => {
    if (handleInput(input)) event.preventDefault();
  });

  win.on('resize', () => tabs.layout());
  win.on('maximize', () => tabs.layout());
  win.on('unmaximize', () => tabs.layout());
  win.on('enter-full-screen', () => tabs.layout());
  win.on('leave-full-screen', () => tabs.layout());

  win.webContents.on('did-finish-load', async () => {
    send('config:state', config.all());
    if (tabs.tabs.size === 0) await tabs.newTab(config.get('homepage'));
  });

  // A UI nunca navega para fora de si mesma.
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
 * IPC
 * ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('tabs:new', (_e, url, opts) => tabs && tabs.newTab(url, opts || {}));
  ipcMain.handle('tabs:close', (_e, id) => tabs && tabs.close(id));
  ipcMain.handle('tabs:select', (_e, id) => tabs && tabs.select(id));
  ipcMain.handle('tabs:state', () => (tabs ? tabs.state() : { tabs: [], activeId: null }));

  ipcMain.handle('nav:go', (_e, input) => tabs && tabs.navigate(input));
  ipcMain.handle('nav:back', () => tabs && tabs.back());
  ipcMain.handle('nav:forward', () => tabs && tabs.forward());
  ipcMain.handle('nav:reload', () => tabs && tabs.reload());
  ipcMain.handle('nav:stop', () => tabs && tabs.stop());

  ipcMain.handle('config:get', () => config.all());

  // O painel da UI fica atras das views; encolher a pagina o deixa visivel.
  ipcMain.handle('ui:panel', (_e, open) => {
    if (tabs) tabs.setInset(open ? 340 : 0);
    return { ok: true };
  });

  ipcMain.handle('config:set', async (_e, key, value) => {
    if (!config.set(key, value)) return { ok: false, error: 'chave desconhecida' };

    // Mudancas que exigem acao imediata.
    if (key === 'proxyMode' || key === 'customProxy' || key === 'torProxy') {
      configureDns(app, config.get('proxyMode'));
      if (tabs) await tabs.refreshProxy();
    }

    const needsReload = ['antiFingerprint', 'spoofUserAgent', 'ephemeral'].includes(key);
    return { ok: true, config: config.all(), needsReload };
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
      blocklistSize: blocklist.size,
      blockedTotal: blocklist.blockedCount,
      ephemeral: config.get('ephemeral'),
      partition: tab ? tab.partition : '',
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
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.reload();
    }
    return { ok: true, sessions: seen.size };
  });

  ipcMain.handle('blocklist:load', async () => {
    if (!win || win.isDestroyed()) return { ok: false };
    const result = await dialog.showOpenDialog(win, {
      title: 'Carregar lista de bloqueio (EasyList, hosts ou dominios)',
      properties: ['openFile'],
      filters: [{ name: 'Listas', extensions: ['txt', 'list', 'hosts', 'dat'] }],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };
    try {
      const added = blocklist.loadFile(result.filePaths[0]);
      return { ok: true, added, total: blocklist.size };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('blocklist:allow', (_e, host) => {
    if (!host) return { ok: false };
    blocklist.allowHost(host);
    return { ok: true };
  });
}

/* ------------------------------------------------------------------ *
 * Atalhos de teclado
 *
 * Via before-input-event, nao globalShortcut: globalShortcut registra no
 * sistema inteiro e roubaria Ctrl+T, Esc etc. de todos os outros programas
 * enquanto o GhostDay estiver aberto.
 * ------------------------------------------------------------------ */

/** @returns true se o atalho foi consumido (evento deve ser cancelado) */
function handleInput(input) {
  if (input.type !== 'keyDown' || !tabs) return false;
  const ctrl = input.control || input.meta;
  const key = String(input.key || '');
  const k = key.toLowerCase();

  if (ctrl && input.shift && k === 'n') { tabs.newTab(null, { isolated: true }); return true; }
  if (ctrl && input.shift && key === 'Delete') { send('ui:wipe'); return true; }
  if (ctrl && k === 't') { tabs.newTab(); return true; }
  if (ctrl && k === 'w') { if (tabs.activeId != null) tabs.close(tabs.activeId); return true; }
  if (ctrl && k === 'r') { tabs.reload(); return true; }
  if (ctrl && k === 'l') { send('ui:focus-address'); return true; }
  if (ctrl && k === 'tab') { cycleTab(input.shift ? -1 : 1); return true; }
  if (key === 'F5') { tabs.reload(); return true; }
  if (key === 'Escape') { tabs.stop(); return true; }
  if (input.alt && key === 'ArrowLeft') { tabs.back(); return true; }
  if (input.alt && key === 'ArrowRight') { tabs.forward(); return true; }

  // Ctrl+1..8 vai para a aba n; Ctrl+9 vai para a ultima.
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

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* ------------------------------------------------------------------ */

app.whenReady().then(() => {
  configureDns(app, config.get('proxyMode'));
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', () => {
  if (win) { win.show(); win.focus(); }
});

app.on('window-all-closed', () => app.quit());

// Nunca aceitar certificado invalido silenciosamente.
app.on('certificate-error', (event, _wc, url, error, _cert, callback) => {
  console.error('[tls] certificado rejeitado:', url, error);
  callback(false);
});
