'use strict';

/**
 * Log de requisicoes por aba e auditoria de cabecalhos de seguranca.
 *
 * Buffer circular por webContents: a aba mais movimentada nao come a memoria
 * das outras, e nada disso toca o disco.
 */

const DEFAULT_LIMIT = 600;
const MAX_HEADER_BYTES = 4096;

class NetLog {
  constructor(limit = DEFAULT_LIMIT) {
    this.limit = limit;
    this.byTab = new Map();      // webContentsId -> record
    this.pending = new Map();    // requestId -> entrada em voo
    this.seq = 0;
  }

  tab(wcId) {
    if (!this.byTab.has(wcId)) {
      this.byTab.set(wcId, {
        entries: [],
        blocked: 0,
        allowed: 0,
        bytes: 0,
        audit: null,
        document: '',
      });
    }
    return this.byTab.get(wcId);
  }

  start(wcId, details, verdict) {
    if (!wcId) return;
    const rec = this.tab(wcId);

    const entry = {
      n: ++this.seq,
      ts: Date.now(),
      t0: details.timestamp || Date.now(),
      method: details.method || 'GET',
      url: details.url,
      host: hostOf(details.url),
      type: details.resourceType || 'other',
      thirdParty: Boolean(verdict?.thirdParty),
      blocked: Boolean(verdict?.block),
      reason: verdict?.reason || '',
      status: 0,
      ms: 0,
      size: 0,
      fromCache: false,
      headers: null,
    };

    rec.entries.push(entry);
    if (rec.entries.length > this.limit) rec.entries.shift();

    if (entry.blocked) rec.blocked++;
    else {
      rec.allowed++;
      this.pending.set(details.id, { wcId, entry });
    }

    if (details.resourceType === 'mainFrame') {
      rec.document = details.url;
      rec.audit = null;
    }
  }

  /** Guarda os headers de saida, para "copiar como curl". */
  headers(requestId, requestHeaders) {
    const p = this.pending.get(requestId);
    if (!p) return;
    let size = 0;
    const kept = {};
    for (const [k, v] of Object.entries(requestHeaders || {})) {
      const line = `${k}: ${v}`;
      if (size + line.length > MAX_HEADER_BYTES) break;
      size += line.length;
      kept[k] = v;
    }
    p.entry.headers = kept;
  }

  finish(requestId, details) {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);

    const { entry } = p;
    entry.status = details.statusCode || 0;
    entry.fromCache = Boolean(details.fromCache);
    entry.ms = Math.max(0, Math.round((details.timestamp || Date.now()) - entry.t0));

    const len = headerValue(details.responseHeaders, 'content-length');
    entry.size = len ? parseInt(len, 10) || 0 : 0;

    const rec = this.byTab.get(p.wcId);
    if (rec) rec.bytes += entry.size;
  }

  fail(requestId, error) {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    p.entry.status = -1;
    p.entry.reason = String(error || 'falhou').slice(0, 60);
  }

  /** Guarda a auditoria do documento principal da aba. */
  setAudit(wcId, url, responseHeaders) {
    if (!wcId) return;
    this.tab(wcId).audit = auditSecurity(url, responseHeaders);
  }

  view(wcId, { limit = 200, only = 'all' } = {}) {
    const rec = this.byTab.get(wcId);
    if (!rec) return { entries: [], blocked: 0, allowed: 0, bytes: 0, audit: null, document: '' };

    let entries = rec.entries;
    if (only === 'blocked') entries = entries.filter((e) => e.blocked);
    else if (only === 'thirdParty') entries = entries.filter((e) => e.thirdParty);
    else if (only === 'errors') entries = entries.filter((e) => e.status >= 400 || e.status === -1);

    return {
      entries: entries.slice(-limit).reverse().map(stripHeaders),
      blocked: rec.blocked,
      allowed: rec.allowed,
      bytes: rec.bytes,
      audit: rec.audit,
      document: rec.document,
    };
  }

  clear(wcId) {
    this.byTab.delete(wcId);
  }

  /** Monta um comando curl equivalente a requisicao n. */
  curl(wcId, n) {
    const rec = this.byTab.get(wcId);
    if (!rec) return null;
    const entry = rec.entries.find((e) => e.n === n);
    if (!entry) return null;

    const parts = [`curl -i -s -X ${entry.method} ${shellQuote(entry.url)}`];
    for (const [k, v] of Object.entries(entry.headers || {})) {
      if (k.toLowerCase() === 'content-length') continue;
      parts.push(`  -H ${shellQuote(`${k}: ${v}`)}`);
    }
    return parts.join(' \\\n');
  }
}

function stripHeaders(e) {
  const { headers, t0, ...rest } = e;
  return { ...rest, hasHeaders: Boolean(headers) };
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function headerValue(headers, name) {
  if (!headers) return '';
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      const v = headers[key];
      return Array.isArray(v) ? v.join(', ') : String(v);
    }
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * Auditoria de cabecalhos
 * ------------------------------------------------------------------ */

function auditSecurity(url, headers) {
  const get = (n) => headerValue(headers, n);
  const https = String(url).startsWith('https://');
  const items = [];

  const add = (name, ok, detail, weight = 1) => items.push({ name, ok, detail, weight });

  const csp = get('content-security-policy');
  add('Content-Security-Policy', Boolean(csp),
    csp ? shorten(csp) : 'ausente', 2);

  if (csp && /unsafe-inline|unsafe-eval/.test(csp)) {
    add('CSP sem unsafe-*', false, 'usa unsafe-inline ou unsafe-eval', 1);
  }

  const hsts = get('strict-transport-security');
  add('Strict-Transport-Security', Boolean(hsts) && https,
    hsts ? shorten(hsts) : (https ? 'ausente' : 'n/a em http'), 2);

  const xfo = get('x-frame-options');
  const frameAncestors = /frame-ancestors/i.test(csp);
  add('Protecao contra clickjacking', Boolean(xfo) || frameAncestors,
    xfo || (frameAncestors ? 'via CSP frame-ancestors' : 'sem X-Frame-Options nem frame-ancestors'), 2);

  const nosniff = get('x-content-type-options');
  add('X-Content-Type-Options', /nosniff/i.test(nosniff),
    nosniff || 'ausente', 1);

  const ref = get('referrer-policy');
  add('Referrer-Policy', Boolean(ref), ref || 'ausente', 1);

  const perm = get('permissions-policy') || get('feature-policy');
  add('Permissions-Policy', Boolean(perm), perm ? shorten(perm) : 'ausente', 1);

  const coop = get('cross-origin-opener-policy');
  add('Cross-Origin-Opener-Policy', Boolean(coop), coop || 'ausente', 1);

  // cookies
  const setCookie = get('set-cookie');
  if (setCookie) {
    add('Cookie com HttpOnly', /httponly/i.test(setCookie),
      /httponly/i.test(setCookie) ? 'ok' : 'cookie acessivel por JS', 1);
    add('Cookie com Secure', /secure/i.test(setCookie),
      /secure/i.test(setCookie) ? 'ok' : 'cookie trafega em http', 1);
    add('Cookie com SameSite', /samesite/i.test(setCookie),
      /samesite/i.test(setCookie) ? 'ok' : 'sem SameSite', 1);
  }

  // vazamento de informacao: aqui ok = NAO expor
  const server = get('server');
  const powered = get('x-powered-by');
  if (server) add('Banner do servidor', !/\d/.test(server), `Server: ${shorten(server)}`, 1);
  if (powered) add('X-Powered-By', false, shorten(powered), 1);

  const max = items.reduce((s, i) => s + i.weight, 0) || 1;
  const got = items.reduce((s, i) => s + (i.ok ? i.weight : 0), 0);
  const pct = Math.round((got / max) * 100);

  return {
    url,
    https,
    score: pct,
    grade: pct >= 85 ? 'A' : pct >= 70 ? 'B' : pct >= 50 ? 'C' : pct >= 30 ? 'D' : 'F',
    items,
  };
}

function shorten(s, n = 90) {
  const str = String(s);
  return str.length > n ? str.slice(0, n) + '...' : str;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

module.exports = { NetLog, auditSecurity };
