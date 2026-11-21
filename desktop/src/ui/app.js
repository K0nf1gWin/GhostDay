'use strict';

const api = window.ghostday;
const $ = (id) => document.getElementById(id);

const el = {
  tablist: $('tablist'), newTab: $('new-tab'), newIso: $('new-iso'),
  back: $('back'), forward: $('forward'), reload: $('reload'),
  address: $('address'), scheme: $('scheme'),
  shield: $('shield'), shieldCount: $('shield-count'),
  devtools: $('devtools'), wipe: $('wipe'), gear: $('gear'),

  panel: $('panel'), panelClose: $('panel-close'), panelTabs: $('panel-tabs'),
  views: { shield: $('view-shield'), net: $('view-net'), res: $('view-res') },

  heroCount: $('hero-count'), heroRules: $('hero-rules'), heroSession: $('hero-session'),
  statusRows: $('status-rows'), toggles: $('toggles'),
  proxyMode: $('proxy-mode'), customProxy: $('custom-proxy'),
  lists: $('lists'), listsUpdate: $('lists-update'), listsImport: $('lists-import'),
  wipe2: $('wipe-2'),

  audit: $('audit'), netChips: $('net-chips'), netClear: $('net-clear'),
  netSummary: $('net-summary'), netList: $('net-list'),

  resTotals: $('res-totals'), resTabs: $('res-tabs'), resProcs: $('res-procs'),

  toast: $('toast'),
};

let state = { tabs: [], activeId: null };
let config = {};
let filters = null;
let view = 'shield';
let netOnly = 'all';
let addressDirty = false;
let timer = null;

/* ------------------------------------------------------------------ */

const TOGGLES = [
  ['blockTrackers',          'Bloquear rastreadores',      'Aplica as listas de filtro a cada requisicao.'],
  ['cosmeticFilters',        'Filtros cosmeticos',         'Esconde o buraco que o anuncio bloqueado deixa.'],
  ['stripParams',            'Limpar URLs',                'Remove utm_*, fbclid, gclid e companhia.'],
  ['httpsOnly',              'Forcar HTTPS',               'Sobe http:// para https:// (menos em rede local).'],
  ['blockThirdPartyCookies', 'Barrar cookies de terceiro', 'Tira Cookie e Set-Cookie em requisicao cross-site.'],
  ['trimReferrer',           'Encurtar referer',           'Cross-site recebe so a origem, nao a URL inteira.'],
  ['antiFingerprint',        'Anti-fingerprint',           'Ruido em canvas/WebGL/audio, navigator generico.'],
  ['spoofUserAgent',         'User agent generico',        'Finge um Chrome comum no Windows.'],
  ['denyPermissions',        'Negar permissoes',           'Camera, microfone, geolocalizacao e notificacoes.'],
  ['ephemeral',              'Sessao volatil',             'Nada em disco: tudo morre ao fechar o navegador.'],
];

function toast(message, ms = 2600) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.toast.hidden = true; }, ms);
}

function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function fmtBytes(b) {
  if (!b) return '-';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function fmtAge(ts) {
  if (!ts) return 'nunca baixada';
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 60) return `ha ${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `ha ${h} h`;
  return `ha ${Math.floor(h / 24)} dias`;
}

/* ---------------- abas ---------------- */

function renderTabs() {
  el.tablist.replaceChildren();
  for (const tab of state.tabs) {
    const n = node('div', 'tab'
      + (tab.id === state.activeId ? ' active' : '')
      + (tab.isolated ? ' isolated' : ''));
    n.title = tab.url || tab.title;

    n.appendChild(node('span', tab.loading ? 'spin' : 'dot'));
    n.appendChild(node('span', 'title', tab.title || 'nova aba'));

    const x = node('span', 'x', '×');
    x.addEventListener('click', (e) => { e.stopPropagation(); api.tabs.close(tab.id); });
    n.appendChild(x);

    n.addEventListener('click', () => api.tabs.select(tab.id));
    n.addEventListener('auxclick', (e) => { if (e.button === 1) api.tabs.close(tab.id); });
    el.tablist.appendChild(n);
  }
}

const activeTab = () => state.tabs.find((t) => t.id === state.activeId) || null;

function renderToolbar() {
  const tab = activeTab();

  el.back.disabled = !tab || !tab.canGoBack;
  el.forward.disabled = !tab || !tab.canGoForward;
  el.reload.textContent = tab && tab.loading ? '✕' : '↻';

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

function render() {
  renderTabs();
  renderToolbar();
  if (!el.panel.hidden && view === 'shield') renderHero();
}

/* ---------------- painel: escudo ---------------- */

function renderHero() {
  const tab = activeTab();
  el.heroCount.textContent = String(tab ? tab.blocked : 0);
  if (filters && filters.engine) {
    el.heroRules.textContent = (filters.engine.network + filters.engine.cosmetic).toLocaleString('pt-BR');
  }
}

function row(key, value, cls) {
  const r = node('div', 'r');
  r.appendChild(node('span', 'k', key));
  r.appendChild(node('span', 'v' + (cls ? ' ' + cls : ''), value));
  return r;
}

async function renderStatus() {
  const s = await api.privacy.status();
  if (!s) return;

  el.statusRows.replaceChildren();
  const modeLabel = { direct: 'direta', tor: 'tor', custom: 'proxy proprio' }[s.proxyMode] || s.proxyMode;
  el.statusRows.appendChild(row('rota', modeLabel, s.proxyMode === 'direct' ? '' : 'good'));

  if (s.proxyMode !== 'direct') {
    el.statusRows.appendChild(s.proxy.ok
      ? row('proxy', String(s.proxy.resolved).slice(0, 40), 'good')
      : row('proxy', 'nao respondeu', 'bad'));
  }

  el.statusRows.appendChild(row('sessao',
    s.ephemeral ? 'volatil (memoria)' : 'persistente (disco)', s.ephemeral ? 'good' : ''));
  el.statusRows.appendChild(row('regras de rede', (s.rules.network || 0).toLocaleString('pt-BR')));
  el.statusRows.appendChild(row('regras cosmeticas', (s.rules.cosmetic || 0).toLocaleString('pt-BR')));
  el.statusRows.appendChild(row('user agent', s.userAgent.replace('Mozilla/5.0 ', '')));

  el.heroSession.textContent = String(
    state.tabs.reduce((sum, t) => sum + (t.blocked || 0), 0)
  );
  renderHero();
}

function renderToggles() {
  el.toggles.replaceChildren();
  for (const [key, label, hint] of TOGGLES) {
    const wrap = node('label', 'toggle');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(config[key]);
    input.addEventListener('change', async () => {
      const res = await api.config.set(key, input.checked);
      if (!res || !res.ok) { input.checked = !input.checked; return toast('nao foi possivel aplicar'); }
      config = res.config;
      if (res.needsReload) toast('vale para as abas abertas a partir de agora');
    });

    const text = node('span');
    text.appendChild(node('span', null, label));
    text.appendChild(node('small', null, hint));

    wrap.appendChild(input);
    wrap.appendChild(text);
    el.toggles.appendChild(wrap);
  }
}

function renderLists() {
  el.lists.replaceChildren();
  if (!filters) {
    el.lists.appendChild(node('div', 'empty', 'carregando listas...'));
    return;
  }

  for (const list of filters.lists) {
    const item = node('div', 'list-item');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = list.enabled;
    cb.addEventListener('change', async () => {
      cb.disabled = true;
      const res = await api.filters.toggle(list.id, cb.checked);
      cb.disabled = false;
      if (res && res.ok) { filters = res.status; renderLists(); renderStatus(); }
    });

    const body = node('div', 'li-body');
    const name = node('div', 'li-name');
    name.appendChild(node('span', null, list.name));
    if (list.note) name.appendChild(node('span', 'li-note', list.note));
    body.appendChild(name);

    const meta = node('div', 'li-meta' + (list.error ? ' err' : ''));
    meta.textContent = list.error
      ? list.error
      : `${fmtAge(list.fetchedAt)} · ${fmtBytes(list.bytes)}`;
    body.appendChild(meta);

    item.appendChild(cb);
    item.appendChild(body);
    item.appendChild(node('span', 'li-rules', list.rules ? list.rules.toLocaleString('pt-BR') : ''));
    el.lists.appendChild(item);
  }

  el.listsUpdate.textContent = filters.updating ? 'baixando...' : 'atualizar';
  el.listsUpdate.disabled = filters.updating;
}

/* ---------------- painel: rede ---------------- */

function renderAudit(audit) {
  el.audit.replaceChildren();
  if (!audit) {
    el.audit.appendChild(node('div', 'empty', 'navegue para auditar os cabecalhos'));
    return;
  }

  const head = node('div', 'audit-head');
  head.appendChild(node('div', 'grade ' + audit.grade.toLowerCase(), audit.grade));

  const title = node('div', 'audit-title');
  title.appendChild(node('b', null, `cabecalhos de seguranca · ${audit.score}%`));
  title.appendChild(node('span', null, audit.url));
  head.appendChild(title);
  el.audit.appendChild(head);

  for (const item of audit.items) {
    const r = node('div', 'audit-item' + (item.ok ? '' : ' bad'));
    r.appendChild(node('span', 'mark', item.ok ? '✓' : '✗'));
    r.appendChild(node('span', 'an', item.name));
    r.appendChild(node('span', 'ad', item.detail));
    r.title = `${item.name}: ${item.detail}`;
    el.audit.appendChild(r);
  }
}

function statusClass(e) {
  if (e.blocked) return '';
  if (e.status === -1 || e.status >= 400) return 'err';
  if (e.status >= 300) return 'redir';
  if (e.status >= 200) return 'ok';
  return '';
}

async function renderNet() {
  const data = await api.net.log({ only: netOnly, limit: 250 });
  if (!data) return;

  renderAudit(data.audit);

  el.netSummary.replaceChildren();
  const sum = node('div');
  sum.appendChild(node('b', null, String(data.allowed)));
  el.netSummary.appendChild(node('span', null, `${data.allowed} permitidas`));
  el.netSummary.appendChild(node('span', 'blk', `${data.blocked} bloqueadas`));
  el.netSummary.appendChild(node('span', null, fmtBytes(data.bytes)));

  el.netList.replaceChildren();
  if (!data.entries.length) {
    el.netList.appendChild(node('div', 'empty', 'nada registrado nesta aba ainda'));
    return;
  }

  for (const e of data.entries) {
    const r = node('div', 'net-row'
      + (e.blocked ? ' blocked' : '')
      + (e.thirdParty ? ' third' : ''));

    r.appendChild(node('span', 'st ' + statusClass(e),
      e.blocked ? 'blk' : (e.status === -1 ? 'err' : (e.status || '...'))));
    r.appendChild(node('span', 'ty', e.type.slice(0, 7)));

    let path = e.url;
    try {
      const u = new URL(e.url);
      path = u.hostname + (u.pathname === '/' ? '' : u.pathname);
    } catch { /* data: e afins */ }
    r.appendChild(node('span', 'ho', path));

    r.appendChild(node('span', 'ms', e.blocked ? e.reason : (e.ms ? e.ms + 'ms' : '')));
    r.title = e.url + (e.blocked ? `\n\nbloqueada: ${e.reason}` : '');

    r.addEventListener('click', async () => {
      if (e.blocked || !e.hasHeaders) {
        await api.net.copy(e.url);
        return toast('url copiada');
      }
      const res = await api.net.curl(e.n);
      toast(res && res.ok ? 'comando curl copiado' : 'url copiada');
      if (!res || !res.ok) await api.net.copy(e.url);
    });

    el.netList.appendChild(r);
  }
}

/* ---------------- painel: recursos ---------------- */

function bar(pct, extraClass) {
  const b = node('div', 'bar');
  const i = node('i', extraClass);
  i.style.width = Math.max(0, Math.min(100, pct)) + '%';
  b.appendChild(i);
  return b;
}

function cpuClass(cpu) {
  if (cpu >= 60) return 'max';
  if (cpu >= 25) return 'hot';
  return '';
}

async function renderRes() {
  const m = await api.metrics.get();
  if (!m) return;

  el.resTotals.replaceChildren();
  const boxes = [
    [m.totals.cpu.toFixed(1) + '%', 'cpu total'],
    [m.totals.memMB >= 1024
      ? (m.totals.memMB / 1024).toFixed(2) + ' GB'
      : m.totals.memMB.toFixed(0) + ' MB', 'memoria'],
    [String(m.totals.processes), 'processos'],
  ];
  for (const [big, small] of boxes) {
    const box = node('div', 'box');
    box.appendChild(node('b', null, big));
    box.appendChild(node('span', null, small));
    el.resTotals.appendChild(box);
  }

  el.resTabs.replaceChildren();
  if (!m.tabs.length) {
    el.resTabs.appendChild(node('div', 'empty', 'nenhuma aba'));
  }
  for (const t of m.tabs) {
    const r = node('div', 'res-row');
    const head = node('div', 'res-head');
    head.appendChild(node('span', 'nm' + (t.isolated ? ' iso' : ''), t.title || 'nova aba'));
    head.appendChild(node('span', 'cpu', t.cpu.toFixed(1) + '%'));
    head.appendChild(node('span', 'mem', t.memMB.toFixed(0) + ' MB'));
    head.appendChild(node('span', 'pid', t.pid ? '#' + t.pid : '-'));
    r.appendChild(head);
    r.appendChild(bar(t.cpu, cpuClass(t.cpu)));
    if (t.shared) r.appendChild(node('div', 'res-note', 'divide processo com outra aba'));
    el.resTabs.appendChild(r);
  }

  el.resProcs.replaceChildren();
  for (const p of m.processes.slice(0, 12)) {
    const r = node('div', 'res-row');
    const head = node('div', 'res-head');
    head.appendChild(node('span', 'nm', p.type + (p.name ? ' · ' + p.name : '')));
    head.appendChild(node('span', 'cpu', p.cpu.toFixed(1) + '%'));
    head.appendChild(node('span', 'mem', p.memMB.toFixed(0) + ' MB'));
    head.appendChild(node('span', 'pid', '#' + p.pid));
    r.appendChild(head);
    el.resProcs.appendChild(r);
  }
}

/* ---------------- painel: controle ---------------- */

function setView(next) {
  view = next;
  for (const [name, section] of Object.entries(el.views)) section.hidden = name !== next;
  for (const btn of el.panelTabs.querySelectorAll('.ptab')) {
    btn.classList.toggle('on', btn.dataset.view === next);
  }
  refreshView();
  scheduleRefresh();
}

function refreshView() {
  if (el.panel.hidden) return;
  if (view === 'shield') { renderStatus(); renderLists(); }
  else if (view === 'net') renderNet();
  else if (view === 'res') renderRes();
}

function scheduleRefresh() {
  clearInterval(timer);
  if (el.panel.hidden) return;
  const every = view === 'res' ? 1500 : view === 'net' ? 1200 : 4000;
  timer = setInterval(refreshView, every);
}

async function openPanel() {
  await api.ui.panel(true);
  el.panel.hidden = false;
  el.gear.classList.add('on');

  el.proxyMode.value = config.proxyMode || 'direct';
  el.customProxy.hidden = el.proxyMode.value !== 'custom';
  el.customProxy.value = config.customProxy || '';
  renderToggles();

  if (!filters) filters = await api.filters.status();
  setView(view);
}

function closePanel() {
  el.panel.hidden = true;
  el.gear.classList.remove('on');
  clearInterval(timer);
  api.ui.panel(false);
}

const togglePanel = () => (el.panel.hidden ? openPanel() : closePanel());

/* ---------------- eventos ---------------- */

el.newTab.addEventListener('click', () => api.tabs.create(null, {}));
el.newIso.addEventListener('click', async () => {
  await api.tabs.create(null, { isolated: true });
  toast('aba isolada: sessao propria, apagada ao fechar');
});

el.back.addEventListener('click', () => api.nav.back());
el.forward.addEventListener('click', () => api.nav.forward());
el.reload.addEventListener('click', () => {
  const tab = activeTab();
  if (tab && tab.loading) api.nav.stop(); else api.nav.reload();
});
el.devtools.addEventListener('click', () => api.nav.devtools());

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

el.shield.addEventListener('click', () => { if (el.panel.hidden) openPanel(); setView('shield'); });
el.gear.addEventListener('click', togglePanel);
el.panelClose.addEventListener('click', closePanel);

el.panelTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.ptab');
  if (btn) setView(btn.dataset.view);
});

el.netChips.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip || !chip.dataset.only) return;
  netOnly = chip.dataset.only;
  for (const c of el.netChips.querySelectorAll('.chip[data-only]')) {
    c.classList.toggle('on', c.dataset.only === netOnly);
  }
  renderNet();
});

el.netClear.addEventListener('click', async () => {
  await api.net.clear();
  renderNet();
  toast('log da aba limpo');
});

el.proxyMode.addEventListener('change', async () => {
  const mode = el.proxyMode.value;
  el.customProxy.hidden = mode !== 'custom';
  const res = await api.config.set('proxyMode', mode);
  if (res && res.ok) {
    config = res.config;
    toast(mode === 'direct' ? 'rota direta' : 'rota via proxy aplicada');
    renderStatus();
  }
});

el.customProxy.addEventListener('change', async () => {
  const res = await api.config.set('customProxy', el.customProxy.value.trim());
  if (res && res.ok) {
    config = res.config;
    if (config.proxyMode === 'custom') await api.config.set('proxyMode', 'custom');
    renderStatus();
    toast('proxy atualizado');
  }
});

el.listsUpdate.addEventListener('click', async () => {
  el.listsUpdate.textContent = 'baixando...';
  el.listsUpdate.disabled = true;
  const res = await api.filters.update();
  filters = await api.filters.status();
  renderLists();
  renderStatus();
  toast(res && res.ok ? `${res.fetched} de ${res.total} listas atualizadas` : 'falha ao atualizar');
});

el.listsImport.addEventListener('click', async () => {
  const res = await api.filters.import();
  if (res && res.ok) {
    filters = await api.filters.status();
    renderLists();
    renderStatus();
    toast(`${res.name}: ${(res.rules || 0).toLocaleString('pt-BR')} regras`);
  } else if (res && res.error) {
    toast('erro: ' + res.error);
  }
});

async function doWipe() {
  const res = await api.privacy.wipe();
  toast(res && res.ok ? `limpo: ${res.sessions} sessao(oes)` : 'falha ao limpar');
  refreshView();
}

el.wipe.addEventListener('click', doWipe);
el.wipe2.addEventListener('click', doWipe);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.panel.hidden) closePanel();
});

/* ---------------- canais do processo principal ---------------- */

api.on('tabs:state', (next) => { state = next; render(); });
api.on('config:state', (next) => { config = next; });
api.on('filters:state', (next) => {
  filters = next;
  if (!el.panel.hidden && view === 'shield') { renderLists(); renderHero(); }
});
api.on('ui:focus-address', () => { el.address.focus(); el.address.select(); });
api.on('ui:wipe', doWipe);

/* ---------------- boot ---------------- */

(async () => {
  config = await api.config.get();
  state = await api.tabs.state();
  render();
})();
