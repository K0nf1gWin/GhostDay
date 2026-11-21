'use strict';
const { TYPE_MAP } = require('./filters');

/* ------------------------------------------------------------------ *
 * 1. Switches do Chromium (precisam ser aplicados antes do app.ready)
 * ------------------------------------------------------------------ */

function applyGlobalSwitches(app) {
  // WebRTC: impede que o IP real vaze por UDP fora do proxy.
  app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');
  app.commandLine.appendSwitch('webrtc-max-cpu-consumption-percentage', '50');

  // Nada de telemetria, phishing-check na nuvem, sync, pings ou traducao.
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-domain-reliability');
  app.commandLine.appendSwitch('disable-client-side-phishing-detection');
  app.commandLine.appendSwitch('disable-sync');
  app.commandLine.appendSwitch('disable-speech-api');
  app.commandLine.appendSwitch('no-pings');
  app.commandLine.appendSwitch('no-default-browser-check');
  app.commandLine.appendSwitch('no-first-run');
  app.commandLine.appendSwitch(
    'disable-features',
    [
      'MediaRouter',
      'OptimizationHints',
      'Translate',
      'AutofillServerCommunication',
      'InterestFeedContentSuggestions',
      'CalculateNativeWinOcclusion',
    ].join(',')
  );
}

/** DNS sobre HTTPS. Em modo proxy/Tor o DNS vai pelo proxy, nao por aqui. */
function configureDns(app, mode) {
  try {
    if (mode === 'direct') {
      app.configureHostResolver({
        secureDnsMode: 'secure',
        secureDnsServers: ['https://dns.quad9.net/dns-query', 'https://mozilla.cloudflare-dns.com/dns-query'],
      });
    } else {
      // Proxy SOCKS5 resolve o nome do lado remoto: DoH local atrapalharia.
      app.configureHostResolver({ secureDnsMode: 'off', secureDnsServers: [] });
    }
  } catch (err) {
    console.error('[dns] configureHostResolver falhou:', err.message);
  }
}

/* ------------------------------------------------------------------ *
 * 2. User agent
 * ------------------------------------------------------------------ */

/**
 * Um UA de Chrome comum no Windows. A ideia nao e "esconder", e sumir no meio
 * da multidao: o UA padrao do Electron ("GhostDay/0.1.0 Electron/33") seria
 * unico e, por isso, pior para privacidade do que um UA banal.
 */
function genericUserAgent() {
  const chromeMajor = (process.versions.chrome || '130').split('.')[0];
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
         `Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
}

const ACCEPT_LANGUAGES = 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7';

/* ------------------------------------------------------------------ *
 * 3. URL: parametros de rastreio e upgrade para HTTPS
 * ------------------------------------------------------------------ */

const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'utm_name', 'utm_cid', 'utm_reader', 'utm_referrer', 'utm_social', 'utm_brand',
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'twclid',
  'ttclid', 'igshid', 'igsh', 'li_fat_id', 'mc_cid', 'mc_eid', 'vero_id',
  '_hsenc', '_hsmi', 'hsCtaTracking', 'mkt_tok', 'yclid', '_openstat',
  'wickedid', 'oly_anon_id', 'oly_enc_id', 'rb_clickid', 's_cid', 'ss_email_id',
  'ref_src', 'ref_url', 'spm', 'scm', 'share_source',
];

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|0\.0\.0\.0)/i;

/** Retorna a URL limpa, ou null se nada mudou. */
function cleanUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  if (!u.search) return null;
  let touched = false;
  for (const p of TRACKING_PARAMS) {
    if (u.searchParams.has(p)) { u.searchParams.delete(p); touched = true; }
  }
  return touched ? u.toString() : null;
}

/** http:// -> https://, exceto em loopback/rede local. */
function upgradeUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== 'http:') return null;
  if (PRIVATE_HOST.test(u.hostname)) return null;
  u.protocol = 'https:';
  return u.toString();
}

/* ------------------------------------------------------------------ *
 * 4. Site (eTLD+1) para decidir o que e "terceiro"
 * ------------------------------------------------------------------ */

// Heuristica, nao Public Suffix List: cobre os sufixos de dois niveis mais
// comuns. Errar aqui so afeta a decisao de "primeira parte x terceiro".
const TWO_LEVEL = new Set([
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br', 'art.br', 'blog.br',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.jp', 'co.kr', 'co.in', 'co.za',
  'com.ar', 'com.mx', 'com.au', 'com.pt', 'com.es', 'com.tr', 'com.cn',
]);

function siteOf(hostname) {
  if (!hostname) return '';
  const parts = String(hostname).toLowerCase().split('.');
  if (parts.length <= 2) return parts.join('.');
  const last2 = parts.slice(-2).join('.');
  return TWO_LEVEL.has(last2) ? parts.slice(-3).join('.') : last2;
}

function hostOf(rawUrl) {
  try { return new URL(rawUrl).hostname.toLowerCase(); } catch { return ''; }
}

/** URL da aba que originou a requisicao (para saber se e cross-site). */
function initiatorUrl(details) {
  if (details.referrer) return details.referrer;
  if (details.webContentsId != null) {
    // require tardio: mantem este modulo testavel fora do Electron
        const wc = webContents.fromId(details.webContentsId);
    if (wc && !wc.isDestroyed()) return wc.getURL();
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * 5. Hardening da sessao
 * ------------------------------------------------------------------ */

function hardenSession(session, { config, engine, netlog, onBlocked }) {
  if (session.__ghostdayHardened) return;
  session.__ghostdayHardened = true;

  session.setSpellCheckerEnabled(false);

  if (config.get('spoofUserAgent')) {
    session.setUserAgent(genericUserAgent(), ACCEPT_LANGUAGES);
  }

  /** Contexto que a engine de filtros precisa para decidir. */
  const contextOf = (details) => {
    const hostname = hostOf(details.url);
    const originUrl = initiatorUrl(details);
    const originHost = hostOf(originUrl);
    const originSite = siteOf(originHost);
    const targetSite = siteOf(hostname);
    return {
      type: TYPE_MAP[details.resourceType] || 'other',
      hostname,
      originHost,
      originSite,
      thirdParty: Boolean(originSite) && Boolean(targetSite) && originSite !== targetSite,
    };
  };

  /* --- bloqueio, limpeza de URL e upgrade de esquema --- */
  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const isTop = details.resourceType === 'mainFrame';
    const ctx = contextOf(details);
    const verdict = { block: false, reason: '', thirdParty: ctx.thirdParty };

    // Navegacao direta nunca e bloqueada: so sub-recursos.
    if (config.get('blockTrackers') && !isTop) {
      const hit = engine.match(details.url, ctx);
      verdict.block = hit.block;
      verdict.reason = hit.reason;
    }

    netlog.start(details.webContentsId, details, verdict);

    if (verdict.block) {
      if (onBlocked) onBlocked(details);
      return callback({ cancel: true });
    }

    if (isTop) {
      if (config.get('stripParams')) {
        const cleaned = cleanUrl(details.url);
        if (cleaned) return callback({ redirectURL: cleaned });
      }
      if (config.get('httpsOnly')) {
        const upgraded = upgradeUrl(details.url);
        if (upgraded) return callback({ redirectURL: upgraded });
      }
    }

    callback({});
  });

  /* --- headers de saida: referer e cookies de terceiros --- */
  session.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    const headers = { ...details.requestHeaders };
    const ctx = contextOf(details);

    if (config.get('trimReferrer') && headers.Referer) {
      const refSite = siteOf(hostOf(headers.Referer));
      if (refSite && refSite !== siteOf(ctx.hostname)) {
        try { headers.Referer = new URL(headers.Referer).origin + '/'; }
        catch { delete headers.Referer; }
      }
    }

    if (config.get('blockThirdPartyCookies') && ctx.thirdParty) {
      delete headers.Cookie;
    }

    // Client hints de alta entropia que o Chromium manda por padrao.
    delete headers['X-Requested-With'];
    delete headers['sec-ch-ua-full-version-list'];
    delete headers['sec-ch-ua-arch'];
    delete headers['sec-ch-ua-bitness'];
    delete headers['sec-ch-ua-model'];
    delete headers['sec-ch-ua-platform-version'];

    netlog.headers(details.id, headers);
    callback({ requestHeaders: headers });
  });

  /* --- headers de entrada: auditoria e cookies de terceiro --- */
  session.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
    if (details.resourceType === 'mainFrame') {
      netlog.setAudit(details.webContentsId, details.url, details.responseHeaders);
    }

    if (!config.get('blockThirdPartyCookies')) return callback({});

    const ctx = contextOf(details);
    if (ctx.thirdParty && details.responseHeaders) {
      const headers = { ...details.responseHeaders };
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'set-cookie') delete headers[key];
      }
      return callback({ responseHeaders: headers });
    }
    callback({});
  });

  /* --- fim de vida da requisicao, para o log --- */
  session.webRequest.onCompleted({ urls: ['<all_urls>'] }, (details) => {
    netlog.finish(details.id, details);
  });

  session.webRequest.onErrorOccurred({ urls: ['<all_urls>'] }, (details) => {
    netlog.fail(details.id, details.error);
  });

  /* --- permissoes: nega por padrao --- */
  const ALWAYS_OK = new Set(['fullscreen', 'pointerLock']);
  session.setPermissionRequestHandler((wc, permission, callback) => {
    if (!config.get('denyPermissions')) return callback(true);
    callback(ALWAYS_OK.has(permission));
  });
  session.setPermissionCheckHandler((wc, permission) => {
    if (!config.get('denyPermissions')) return true;
    return ALWAYS_OK.has(permission);
  });

  // Nenhum dispositivo (HID/serial/USB/bluetooth) e autorizado.
  session.setDevicePermissionHandler(() => false);
  session.setBluetoothPairingHandler((details, callback) => callback({ cancel: true }));
}

/* ------------------------------------------------------------------ *
 * 6. Proxy
 * ------------------------------------------------------------------ */

async function applyProxy(session, config) {
  const mode = config.get('proxyMode');
  if (mode === 'direct') {
    await session.setProxy({ mode: 'direct' });
    return { mode, rules: '' };
  }
  const rules = mode === 'tor' ? config.get('torProxy') : config.get('customProxy');
  await session.setProxy({
    proxyRules: rules,
    proxyBypassRules: '<-loopback>',
  });
  return { mode, rules };
}

/** Testa se o proxy responde, resolvendo uma URL por ele. */
async function proxyReachable(session, testUrl = 'https://check.torproject.org/') {
  try {
    const resolved = await session.resolveProxy(testUrl);
    return { ok: true, resolved };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ------------------------------------------------------------------ *
 * 7. Limpeza total
 * ------------------------------------------------------------------ */

async function wipeSession(session) {
  await session.clearStorageData({
    storages: [
      'cookies', 'filesystem', 'indexdb', 'localstorage',
      'shadercache', 'websql', 'serviceworkers', 'cachestorage',
    ],
  });
  await session.clearCache();
  await session.clearAuthCache();
  try { await session.clearHostResolverCache(); } catch { /* versao antiga */ }
  try { await session.clearCodeCaches({ urls: [] }); } catch { /* idem */ }
}

module.exports = {
  applyGlobalSwitches,
  configureDns,
  genericUserAgent,
  hardenSession,
  applyProxy,
  proxyReachable,
  wipeSession,
  cleanUrl,
  upgradeUrl,
  siteOf,
  hostOf,
  TRACKING_PARAMS,
};
