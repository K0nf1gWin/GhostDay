'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

/**
 * Assinaturas de listas de filtros.
 *
 * Baixa, guarda em disco e atualiza as listas; a engine e remontada a cada
 * mudanca. O download usa o modulo net do Electron, que respeita o proxy da
 * sessao: com Tor ligado, a atualizacao tambem passa pelo Tor.
 */

const DEFAULT_LISTS = [
  {
    id: 'easylist',
    name: 'EasyList',
    url: 'https://easylist.to/easylist/easylist.txt',
    enabled: true,
    note: 'anuncios em geral',
  },
  {
    id: 'easyprivacy',
    name: 'EasyPrivacy',
    url: 'https://easylist.to/easylist/easyprivacy.txt',
    enabled: true,
    note: 'rastreadores e telemetria',
  },
  {
    id: 'easylist-brasil',
    name: 'EasyList Brasil',
    url: 'https://easylist-downloads.adblockplus.org/easylistbrasil.txt',
    enabled: true,
    note: 'sites brasileiros',
  },
  {
    id: 'peter-lowe',
    name: 'Peter Lowe',
    url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&mimetype=plaintext',
    enabled: true,
    note: 'servidores de anuncio',
  },
  {
    id: 'ublock-filters',
    name: 'uBlock filters',
    url: 'https://ublockorigin.github.io/uAssets/filters/filters.txt',
    enabled: true,
    note: 'complemento do uBlock',
  },
  {
    id: 'ublock-badware',
    name: 'uBlock badware',
    url: 'https://ublockorigin.github.io/uAssets/filters/badware.txt',
    enabled: true,
    note: 'dominios maliciosos',
  },
];

const MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000;   // 5 dias
const MAX_BYTES = 24 * 1024 * 1024;           // teto por lista
const FETCH_TIMEOUT_MS = 45000;

class Subscriptions {
  /**
   * @param {object} o
   * @param {string} o.dir        pasta de cache
   * @param {FilterEngine} o.engine
   * @param {Function} o.seed     devolve as regras embutidas, em texto
   * @param {Function} [o.onChange]
   */
  constructor({ dir, engine, seed, onChange }) {
    this.dir = dir;
    this.engine = engine;
    this.seed = seed;
    this.onChange = onChange || (() => {});
    this.lists = DEFAULT_LISTS.map((l) => ({ ...l, fetchedAt: 0, bytes: 0, rules: 0, error: null }));
    this.updating = false;
    this.lastError = null;
  }

  file(id) {
    return path.join(this.dir, `${createHash('sha1').update(id).digest('hex').slice(0, 12)}.txt`);
  }

  get indexFile() {
    return path.join(this.dir, 'index.json');
  }

  /** Le o cache do disco e monta a engine. Nao vai a rede. */
  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    try {
      const saved = JSON.parse(await fs.readFile(this.indexFile, 'utf8'));
      for (const list of this.lists) {
        const entry = saved[list.id];
        if (!entry) continue;
        list.fetchedAt = entry.fetchedAt || 0;
        list.bytes = entry.bytes || 0;
        if (typeof entry.enabled === 'boolean') list.enabled = entry.enabled;
      }
    } catch {
      // primeiro boot
    }
    await this.rebuild();
  }

  /** Remonta a engine: semente embutida + cada lista habilitada em cache. */
  async rebuild() {
    this.engine.reset();
    this.engine.parse(this.seed(), 'embutida');

    for (const list of this.lists) {
      list.rules = 0;
      if (!list.enabled || !list.fetchedAt) continue;
      try {
        const text = await fs.readFile(this.file(list.id), 'utf8');
        list.rules = this.engine.parse(text, list.name);
        list.error = null;
      } catch (err) {
        list.error = 'cache ilegivel';
        list.fetchedAt = 0;
      }
    }
    this.onChange(this.status());
  }

  stale() {
    const now = Date.now();
    return this.lists.filter((l) => l.enabled && now - l.fetchedAt > MAX_AGE_MS);
  }

  /**
   * Baixa o que estiver vencido (ou tudo, com force) e remonta a engine.
   * Nunca lanca: lista que falha fica com o cache antigo.
   */
  async update({ force = false } = {}) {
    if (this.updating) return { ok: false, error: 'ja esta atualizando' };
    this.updating = true;
    this.onChange(this.status());

    const targets = force ? this.lists.filter((l) => l.enabled) : this.stale();
    let fetched = 0;

    try {
      for (const list of targets) {
        try {
          const text = await this.fetchOne(list.url);
          await fs.writeFile(this.file(list.id), text, 'utf8');
          list.fetchedAt = Date.now();
          list.bytes = Buffer.byteLength(text);
          list.error = null;
          fetched++;
        } catch (err) {
          list.error = String(err.message || err).slice(0, 120);
        }
      }
      await this.save();
      await this.rebuild();
    } finally {
      this.updating = false;
      this.onChange(this.status());
    }

    return { ok: true, fetched, total: targets.length };
  }

  async fetchOne(url) {
    const { net } = require('electron');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await net.fetch(url, { signal: controller.signal, cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error('lista grande demais');
      if (!/^\s*(\[|!|\|\||@@|##|[a-z0-9])/i.test(text)) throw new Error('nao parece uma lista de filtros');
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  async save() {
    const out = {};
    for (const l of this.lists) {
      out[l.id] = { url: l.url, fetchedAt: l.fetchedAt, bytes: l.bytes, enabled: l.enabled };
    }
    await fs.writeFile(this.indexFile, JSON.stringify(out, null, 2), 'utf8');
  }

  async setEnabled(id, enabled) {
    const list = this.lists.find((l) => l.id === id);
    if (!list) return false;
    list.enabled = enabled;
    await this.save();
    if (enabled && !list.fetchedAt) await this.update({});
    else await this.rebuild();
    return true;
  }

  /** Importa um arquivo local como lista extra permanente. */
  async importFile(filePath) {
    const text = await fs.readFile(filePath, 'utf8');
    const id = 'local-' + createHash('sha1').update(filePath).digest('hex').slice(0, 8);
    let list = this.lists.find((l) => l.id === id);
    if (!list) {
      list = { id, name: path.basename(filePath), url: `file:${filePath}`, enabled: true, note: 'local' };
      this.lists.push(list);
    }
    await fs.writeFile(this.file(id), text, 'utf8');
    list.fetchedAt = Date.now();
    list.bytes = Buffer.byteLength(text);
    list.error = null;
    await this.save();
    await this.rebuild();
    return { ok: true, name: list.name, rules: list.rules };
  }

  status() {
    return {
      updating: this.updating,
      lists: this.lists.map((l) => ({
        id: l.id,
        name: l.name,
        note: l.note || '',
        enabled: l.enabled,
        rules: l.rules,
        bytes: l.bytes,
        fetchedAt: l.fetchedAt,
        error: l.error,
      })),
      engine: this.engine.stats,
    };
  }
}

module.exports = { Subscriptions, DEFAULT_LISTS };
