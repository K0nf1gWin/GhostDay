'use strict';

/**
 * Engine de filtros no dialeto Adblock Plus / EasyList.
 *
 * Cobre o que importa na pratica:
 *   - regras de rede:    ||dominio^  |inicio  fim|  *curinga*  /regex/
 *   - opcoes:            $third-party, $script, $image, $domain=a.com|~b.com, $important
 *   - excecoes:          @@||dominio^$document
 *   - cosmeticas:        ##seletor   dominio.com##seletor   dominio.com#@#seletor
 *
 * Desempenho: cada regra e indexada por um token (trecho alfanumerico do
 * padrao). Numa requisicao so sao testadas as regras cujos tokens aparecem na
 * URL, em vez das ~100 mil da EasyList. E o mesmo truque do uBlock/ABP.
 */

const SEPARATOR = '(?:[^\\w.%-]|$)';

/* ------------------------------------------------------------------ *
 * Tipos de recurso: nome do Electron -> nome do ABP
 * ------------------------------------------------------------------ */

const TYPE_MAP = {
  mainFrame: 'document',
  subFrame: 'subdocument',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  object: 'object',
  xhr: 'xmlhttprequest',
  ping: 'ping',
  cspReport: 'other',
  media: 'media',
  webSocket: 'websocket',
  other: 'other',
};

const KNOWN_TYPES = new Set([
  'document', 'subdocument', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other',
  'popup', 'beacon',
]);

/* ------------------------------------------------------------------ *
 * Padrao -> RegExp
 * ------------------------------------------------------------------ */

function escapeRe(s) {
  return s.replace(/[.+?${}()|[\]\\]/g, '\\$&');
}

function patternToRegex(pattern) {
  // /regex/ literal
  if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    return new RegExp(pattern.slice(1, -1), 'i');
  }

  let body = pattern;
  let prefix = '';
  let suffix = '';

  if (body.startsWith('||')) {
    // ancora de dominio: qualquer esquema, host ou subdominio dele
    prefix = '^[a-z][a-z0-9+.-]*://(?:[^/?#]*\\.)?';
    body = body.slice(2);
  } else if (body.startsWith('|')) {
    prefix = '^';
    body = body.slice(1);
  }

  if (body.endsWith('|')) {
    suffix = '$';
    body = body.slice(0, -1);
  }

  const re = escapeRe(body)
    .replace(/\*/g, '.*')
    .replace(/\^/g, SEPARATOR);

  return new RegExp(prefix + re + suffix, 'i');
}

// Tokens comuns demais: indexar por eles criaria baldes gigantes, sem ganho.
const GENERIC_TOKENS = new Set([
  'http', 'https', 'www', 'com', 'net', 'org', 'the', 'and', 'php', 'html',
  'index', 'static', 'assets', 'content', 'images', 'image',
]);

/**
 * Token de indexacao.
 *
 * So serve um trecho que vai aparecer INTEIRO entre os tokens da URL. Um
 * trecho colado a um curinga, ou no fim do padrao, pode ser so o comeco de um
 * token maior da URL ("banner123" no padrao x "banner123x" na URL) e indexar
 * por ele faria a regra nunca casar. Nesse caso devolve '' e a regra vai para
 * o balde generico, testado em toda requisicao.
 */
function pickToken(pattern) {
  const isRegex = pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/');
  const src = isRegex ? pattern.slice(1, -1) : pattern;

  // Alternancia e grupos quebram a extracao: joga no balde generico.
  if (isRegex && /[|([]/.test(src)) return '';

  const lower = src.toLowerCase();
  const candidates = [];
  const re = /[a-z0-9]{3,}/g;
  let m;

  while ((m = re.exec(lower)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const before = start > 0 ? lower[start - 1] : '';
    const after = end < lower.length ? lower[end] : '';

    if (before === '*' || after === '*') continue;          // curinga ao lado
    if (!isRegex && after === '') continue;                 // fim do padrao
    if (isRegex) {
      if (before === '\\') continue;                        // vem de uma escapada
      if ('+?{'.includes(after)) continue;                  // quantificador
      if (after === '\\') {
        // \d \w \s podem continuar o token na URL; \. \/ sao separadores
        const escaped = lower[end + 1] || '';
        if (/[a-z]/.test(escaped)) continue;
      }
    }
    if (GENERIC_TOKENS.has(m[0])) continue;

    candidates.push(m[0]);
  }

  if (!candidates.length) return '';
  return candidates.reduce((a, b) => (b.length > a.length ? b : a));
}

function urlTokens(url) {
  return url.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
}

/* ------------------------------------------------------------------ *
 * Regra de rede
 * ------------------------------------------------------------------ */

class NetRule {
  constructor(pattern, opts) {
    this.re = patternToRegex(pattern);
    this.types = opts.types || null;          // Set ou null (qualquer)
    this.notTypes = opts.notTypes || null;
    this.thirdParty = opts.thirdParty;        // true | false | null
    this.domains = opts.domains || null;      // {inc:Set, exc:Set}
    this.important = Boolean(opts.important);
  }

  matches(url, ctx) {
    if (this.thirdParty !== null && this.thirdParty !== ctx.thirdParty) return false;
    if (this.types && !this.types.has(ctx.type)) return false;
    if (this.notTypes && this.notTypes.has(ctx.type)) return false;

    if (this.domains) {
      const { inc, exc } = this.domains;
      if (exc.size && domainListHas(exc, ctx.originSite, ctx.originHost)) return false;
      if (inc.size && !domainListHas(inc, ctx.originSite, ctx.originHost)) return false;
    }
    return this.re.test(url);
  }
}

function domainListHas(set, site, host) {
  if (!host) return false;
  if (set.has(host) || (site && set.has(site))) return true;
  // casa dominios pai: ads.foo.com bate com regra de foo.com
  const parts = host.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    if (set.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

function parseOptions(raw) {
  const opts = { types: null, notTypes: null, thirdParty: null, domains: null, important: false };
  if (!raw) return opts;

  for (const piece of raw.split(',')) {
    const opt = piece.trim();
    if (!opt) continue;

    if (opt === 'third-party' || opt === '3p') { opts.thirdParty = true; continue; }
    if (opt === '~third-party' || opt === 'first-party' || opt === '1p') { opts.thirdParty = false; continue; }
    if (opt === 'important') { opts.important = true; continue; }

    if (opt.startsWith('domain=')) {
      const inc = new Set();
      const exc = new Set();
      for (const d of opt.slice(7).split('|')) {
        if (!d) continue;
        if (d.startsWith('~')) exc.add(d.slice(1).toLowerCase());
        else inc.add(d.toLowerCase());
      }
      opts.domains = { inc, exc };
      continue;
    }

    const negated = opt.startsWith('~');
    const name = (negated ? opt.slice(1) : opt).replace('xhr', 'xmlhttprequest');
    if (KNOWN_TYPES.has(name)) {
      if (negated) (opts.notTypes ||= new Set()).add(name);
      else (opts.types ||= new Set()).add(name);
      continue;
    }

    // opcoes nao suportadas (csp=, redirect=, removeparam=, match-case...)
    // marcam a regra como ignorada
    opts.unsupported = true;
  }
  return opts;
}

/* ------------------------------------------------------------------ *
 * Engine
 * ------------------------------------------------------------------ */

class FilterEngine {
  constructor() {
    this.reset();
  }

  reset() {
    this.blockHosts = new Set();        // caminho rapido: ||dominio^ puro
    this.blockBuckets = new Map();      // token -> NetRule[]
    this.allowBuckets = new Map();
    this.cosmeticGeneric = new Set();
    this.cosmeticByDomain = new Map();  // dominio -> Set<seletor>
    this.cosmeticExcept = new Map();
    this.stats = { network: 0, cosmetic: 0, skipped: 0, generic: 0, lists: [] };
    this._genericCss = null;
  }

  /** @returns quantas regras entraram */
  parse(text, listName = 'lista') {
    const before = this.stats.network + this.stats.cosmetic;

    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('!') || line.startsWith('[')) continue;

      // ---- cosmeticas ----
      const hash = line.indexOf('##');
      const hashExc = line.indexOf('#@#');
      if (hashExc !== -1 && (hash === -1 || hashExc < hash)) {
        this.addCosmetic(line.slice(0, hashExc), line.slice(hashExc + 3), true);
        continue;
      }
      if (hash !== -1) {
        const selector = line.slice(hash + 2);
        // #?# e #$# (procedurais/estilo) nao sao suportados
        if (/^[?$@]/.test(selector)) { this.stats.skipped++; continue; }
        this.addCosmetic(line.slice(0, hash), selector, false);
        continue;
      }

      // ---- rede ----
      this.addNetwork(line);
    }

    this._genericCss = null;
    const added = this.stats.network + this.stats.cosmetic - before;
    this.stats.lists.push({ name: listName, rules: added });
    return added;
  }

  addCosmetic(domainPart, selector, isException) {
    if (!selector || selector.length > 400) { this.stats.skipped++; return; }

    if (!domainPart) {
      if (!isException) {
        this.cosmeticGeneric.add(selector);
        this.stats.cosmetic++;
      }
      return;
    }

    const target = isException ? this.cosmeticExcept : this.cosmeticByDomain;
    for (const d of domainPart.split(',')) {
      const domain = d.trim().replace(/^~/, '').toLowerCase();
      if (!domain) continue;
      if (!target.has(domain)) target.set(domain, new Set());
      target.get(domain).add(selector);
      if (!isException) this.stats.cosmetic++;
    }
  }

  addNetwork(line) {
    let text = line;
    const isException = text.startsWith('@@');
    if (isException) text = text.slice(2);

    // separa $opcoes (cuidado para nao cortar dentro de /regex/)
    let pattern = text;
    let optionsRaw = '';
    const dollar = text.lastIndexOf('$');
    if (dollar > 0 && !(text.startsWith('/') && text.endsWith('/'))) {
      pattern = text.slice(0, dollar);
      optionsRaw = text.slice(dollar + 1);
    }
    if (!pattern) { this.stats.skipped++; return; }

    const opts = parseOptions(optionsRaw);
    if (opts.unsupported) { this.stats.skipped++; return; }

    // caminho rapido: ||dominio^ sem opcao nenhuma vira entrada de hash set
    if (!isException && !optionsRaw &&
        /^\|\|[a-z0-9.-]+\^?$/i.test(pattern)) {
      this.blockHosts.add(pattern.replace(/^\|\||\^$/g, '').toLowerCase());
      this.stats.network++;
      return;
    }

    let rule;
    try {
      rule = new NetRule(pattern, opts);
    } catch {
      this.stats.skipped++;
      return;
    }

    const token = pickToken(pattern);
    if (!token) this.stats.generic++;
    const buckets = isException ? this.allowBuckets : this.blockBuckets;
    if (!buckets.has(token)) buckets.set(token, []);
    buckets.get(token).push(rule);
    this.stats.network++;
  }

  /** Host bate com a lista rapida, considerando dominios pai. */
  hostBlocked(hostname) {
    if (!hostname) return false;
    const parts = hostname.toLowerCase().split('.');
    for (let i = 0; i < parts.length - 1; i++) {
      if (this.blockHosts.has(parts.slice(i).join('.'))) return true;
    }
    return false;
  }

  matchBuckets(buckets, url, tokens, ctx) {
    for (const token of tokens) {
      const list = buckets.get(token);
      if (!list) continue;
      for (const rule of list) if (rule.matches(url, ctx)) return rule;
    }
    const generic = buckets.get('');
    if (generic) {
      for (const rule of generic) if (rule.matches(url, ctx)) return rule;
    }
    return null;
  }

  /**
   * @param {string} url
   * @param {{type:string, hostname:string, originHost:string, originSite:string, thirdParty:boolean}} ctx
   * @returns {{block:boolean, reason:string}}
   */
  match(url, ctx) {
    const tokens = urlTokens(url);

    // Ordem do ABP: bloqueio $important > excecao > bloqueio > dominio.
    const blocked = this.matchBuckets(this.blockBuckets, url, tokens, ctx);
    if (blocked && blocked.important) return { block: true, reason: 'regra important' };

    const allow = this.matchBuckets(this.allowBuckets, url, tokens, ctx);
    if (allow) return { block: false, reason: 'excecao' };

    if (blocked) return { block: true, reason: 'regra' };
    if (this.hostBlocked(ctx.hostname)) return { block: true, reason: 'dominio' };
    return { block: false, reason: '' };
  }

  /** CSS das regras cosmeticas genericas, montado uma vez so. */
  genericCss(limit) {
    if (this._genericCss && this._genericCss.limit === limit) return this._genericCss.css;
    const selectors = [...this.cosmeticGeneric].slice(0, limit);
    const css = selectors.length
      ? selectors.join(',\n') + '{display:none!important}'
      : '';
    this._genericCss = { limit, css };
    return css;
  }

  /** CSS especifico do site (inclui dominios pai), menos as excecoes. */
  cosmeticCssFor(hostname) {
    if (!hostname) return '';
    const host = hostname.toLowerCase();
    const parts = host.split('.');
    const selectors = new Set();
    const except = new Set();

    for (let i = 0; i < parts.length - 1; i++) {
      const domain = parts.slice(i).join('.');
      const own = this.cosmeticByDomain.get(domain);
      if (own) for (const s of own) selectors.add(s);
      const exc = this.cosmeticExcept.get(domain);
      if (exc) for (const s of exc) except.add(s);
    }

    for (const s of except) selectors.delete(s);
    if (!selectors.size) return '';
    return [...selectors].join(',\n') + '{display:none!important}';
  }
}

module.exports = { FilterEngine, TYPE_MAP };
