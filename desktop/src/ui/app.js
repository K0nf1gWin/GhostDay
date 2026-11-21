'use strict';

const api = window.ghostday;
const $ = (id) => document.getElementById(id);

const el = {
  tablist: $('tablist'), newTab: $('new-tab'), newIso: $('new-iso'),
  back: $('back'), forward: $('forward'), reload: $('reload'),
  address: $('address'), scheme: $('scheme'),
  shield: $('shield'), shieldCount: $('shield-count'),
  wipe: $('wipe'), gear: $('gear'),
  panel: $('panel'), panelClose: $('panel-close'),
  statusRows: $('status-rows'), toggles: $('toggles'),
  proxyMode: $('proxy-mode'), customProxy: $('custom-proxy'),
  loadList: $('load-list'), wipe2: $('wipe-2'),
  toast: $('toast'),
};

let state = { tabs: [], activeId: null };
let config = {};
let addressDirty = false;

/* ------------------------------------------------------------------ */

const TOGGLES = [
  ['blockTrackers',           'Bloquear rastreadores',      'Cancela requisicoes a dominios de analytics e anuncio.'],
  ['stripParams',             'Limpar URLs',                'Remove utm_*, fbclid, gclid e companhia.'],
  ['httpsOnly',               'Forcar HTTPS',               'Sobe http:// para https:// (menos em rede local).'],
  ['blockThirdPartyCookies',  'Barrar cookies de terceiro', 'Tira Cookie e Set-Cookie em requisicao cross-site.'],
  ['trimReferrer',            'Encurtar referer',           'Cross-site recebe so a origem, nao a URL inteira.'],
  ['antiFingerprint',         'Anti-fingerprint',           'Ruido em canvas/WebGL/audio, navigator generico.'],
  ['spoofUserAgent',          'User agent generico',        'Finge um Chrome comum no Windows.'],
  ['denyPermissions',         'Negar permissoes',           'Camera, microfone, geolocalizacao e notificacoes.'],
  ['ephemeral',               'Sessao volatil',             'Nada em disco: tudo morre ao fechar o navegador.'],
];

function toast(message, ms = 2600) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.toast.hidden = true; }, ms);
}

/* ---------------- abas ---------------- */

function renderTabs() {
  el.tablist.replaceChildren();

  for (const tab of state.tabs) {
    const node = document.createElement('div');
    node.className = 'tab'
      + (tab.id === state.activeId ? ' active' : '')
      + (tab.isolated ? ' isolated' : '');
    node.title = tab.url || tab.title;

    const mark = document.createElement('span');
    mark.className = tab.loading ? 'spin' : 'dot';
    node.appendChild(mark);

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = tab.title || 'Nova aba';
    node.appendChild(title);

    const close = document.createElement('span');
    close.className = 'x';
    close.textContent = '×';
    close.addEventListener('click', (e) => { e.stopPropagation(); api.tabs.close(tab.id); });
    node.appendChild(close);

    node.addEventListener('click', () => api.tabs.select(tab.id));
    node.addEventListener('auxclick', (e) => { if (e.button === 1) api.tabs.close(tab.id); });
    el.tablist.appendChild(node);
  }
}

function activeTab() {
  return state.tabs.find((t) => t.id === state.activeId) || null;
}

function renderToolbar() {
  const tab = activeTab();

  el.back.disabled = !tab || !tab.canGoBack;
  el.forward.disabled = !tab || !tab.canGoForward;
  el.reload.textContent = tab && tab.loading ? '✕' : '↻';
  el.reload.title = tab && tab.loading ? 'Parar (Esc)' : 'Recarregar (F5)';

  if (!tab) {
    el.address.value = '';
    el.scheme.textContent = '';
    el.scheme.className = 'scheme';
    el.shieldCount.textContent = '0';
    return;
  }

  if (!addressDirty && document.activeElement !== el.address) {
    el.address.value = tab.url === 'about:blank' ? '' : tab.url;
  }

  if (!tab.url || tab.url === 'about:blank') {
    el.scheme.textContent = '';
    el.scheme.className = 'scheme';
  } else if (tab.secure) {
    el.scheme.textContent = '✓ https';
    el.scheme.className = 'scheme secure';
  } else {
    el.scheme.textContent = '⚠ sem tls';
    el.scheme.className = 'scheme insecure';
  }

  el.shieldCount.textContent = String(tab.blocked);
  el.shield.classList.toggle('hot', tab.blocked > 0);
  el.shield.title = `${tab.blocked} requisicao(oes) bloqueada(s) nesta pagina`;
}

function render() { renderTabs(); renderToolbar(); }

/* ---------------- painel ---------------- */

function renderToggles() {
  el.toggles.replaceChildren();

  for (const [key, label, hint] of TOGGLES) {
    const wrap = document.createElement('label');
    wrap.className = 'toggle';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(config[key]);
    input.addEventListener('change', async () => {
      const res = await api.config.set(key, input.checked);
      if (!res || !res.ok) { input.checked = !input.checked; return toast('Nao foi possivel aplicar.'); }
      config = res.config;
      if (res.needsReload) toast('Vale para as abas abertas a partir de agora.');
    });

    const text = document.createElement('span');
    const strong = document.createElement('span');
    strong.textContent = label;
    const small = document.createElement('small');
    small.textContent = hint;
    text.appendChild(strong);
    text.appendChild(small);

    wrap.appendChild(input);
    wrap.appendChild(text);
    el.toggles.appendChild(wrap);
  }
}

function row(key, value, cls) {
  const r = document.createElement('div');
  r.className = 'r';
  const k = document.createElement('span');
  k.className = 'k';
  k.textContent = key;
  const v = document.createElement('span');
  v.className = 'v' + (cls ? ' ' + cls : '');
  v.textContent = value;
  r.appendChild(k);
  r.appendChild(v);
  return r;
}

async function renderStatus() {
  const s = await api.privacy.status();
  el.statusRows.replaceChildren();

  const modeLabel = { direct: 'Direta', tor: 'Tor', custom: 'Proxy proprio' }[s.proxyMode] || s.proxyMode;
  el.statusRows.appendChild(row('Rota', modeLabel, s.proxyMode === 'direct' ? '' : 'good'));

  if (s.proxyMode !== 'direct') {
    el.statusRows.appendChild(
      s.proxy.ok
        ? row('Proxy', String(s.proxy.resolved).slice(0, 40), 'good')
        : row('Proxy', 'nao respondeu', 'bad')
    );
  }

  el.statusRows.appendChild(row('Sessao', s.ephemeral ? 'volatil (memoria)' : 'persistente (disco)',
    s.ephemeral ? 'good' : ''));
  el.statusRows.appendChild(row('Lista de bloqueio', `${s.blocklistSize} dominios`));
  el.statusRows.appendChild(row('Bloqueios na sessao', String(s.blockedTotal)));
  el.statusRows.appendChild(row('User agent', s.userAgent.replace('Mozilla/5.0 ', '')));
}

async function openPanel() {
  await api.ui.panel(true);          // reserva espaco: senao o painel fica atras da pagina
  el.proxyMode.value = config.proxyMode || 'direct';
  el.customProxy.hidden = el.proxyMode.value !== 'custom';
  el.customProxy.value = config.customProxy || '';
  renderToggles();
  el.panel.hidden = false;
  await renderStatus();
}

function closePanel() {
  el.panel.hidden = true;
  api.ui.panel(false);
}

function togglePanel() {
  if (el.panel.hidden) openPanel(); else closePanel();
}

/* ---------------- eventos ---------------- */

el.newTab.addEventListener('click', () => api.tabs.create(null, {}));
el.newIso.addEventListener('click', async () => {
  await api.tabs.create(null, { isolated: true });
  toast('Aba isolada: sessao propria, apagada ao fechar.');
});

el.back.addEventListener('click', () => api.nav.back());
el.forward.addEventListener('click', () => api.nav.forward());
el.reload.addEventListener('click', () => {
  const tab = activeTab();
  if (tab && tab.loading) api.nav.stop(); else api.nav.reload();
});

el.address.addEventListener('input', () => { addressDirty = true; });
el.address.addEventListener('focus', () => el.address.select());
el.address.addEventListener('blur', () => { addressDirty = false; renderToolbar(); });
el.address.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    addressDirty = false;
    api.nav.go(el.address.value);
    el.address.blur();
  } else if (e.key === 'Escape') {
    addressDirty = false;
    el.address.blur();
    renderToolbar();
  }
});

el.shield.addEventListener('click', togglePanel);
el.gear.addEventListener('click', togglePanel);
el.panelClose.addEventListener('click', closePanel);

el.proxyMode.addEventListener('change', async () => {
  const mode = el.proxyMode.value;
  el.customProxy.hidden = mode !== 'custom';
  const res = await api.config.set('proxyMode', mode);
  if (res && res.ok) {
    config = res.config;
    toast(mode === 'direct' ? 'Rota direta.' : 'Rota via proxy aplicada.');
    await renderStatus();
  }
});

el.customProxy.addEventListener('change', async () => {
  const res = await api.config.set('customProxy', el.customProxy.value.trim());
  if (res && res.ok) {
    config = res.config;
    if (config.proxyMode === 'custom') {
      await api.config.set('proxyMode', 'custom');
      await renderStatus();
    }
    toast('Proxy atualizado.');
  }
});

async function doWipe() {
  const res = await api.privacy.wipe();
  toast(res && res.ok ? `Limpo: ${res.sessions} sessao(oes). Recarregando.` : 'Falha ao limpar.');
  if (!el.panel.hidden) await renderStatus();
}

el.wipe.addEventListener('click', doWipe);
el.wipe2.addEventListener('click', doWipe);

el.loadList.addEventListener('click', async () => {
  const res = await api.blocklist.load();
  if (res && res.ok) {
    toast(`+${res.added} dominios (total ${res.total}).`);
    await renderStatus();
  } else if (res && res.error) {
    toast('Erro: ' + res.error);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.panel.hidden) closePanel();
});

/* ---------------- canais do processo principal ---------------- */

api.on('tabs:state', (next) => { state = next; render(); });
api.on('config:state', (next) => { config = next; });
api.on('ui:focus-address', () => { el.address.focus(); el.address.select(); });
api.on('ui:wipe', doWipe);

/* ---------------- boot ---------------- */

(async () => {
  config = await api.config.get();
  state = await api.tabs.state();
  render();
})();
