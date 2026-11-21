'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  // rede
  proxyMode: 'direct',          // 'direct' | 'tor' | 'custom'
  customProxy: 'socks5://127.0.0.1:1080',
  torProxy: 'socks5://127.0.0.1:9050',

  // protecoes
  blockTrackers: true,          // bloqueia requisicoes pelas listas de filtro
  cosmeticFilters: true,        // esconde o buraco que o anuncio deixou
  cosmeticLimit: 10000,         // teto de seletores genericos por pagina
  stripParams: true,            // remove utm_*, fbclid, gclid... da URL
  trimReferrer: true,           // referer cross-site reduzido a origem
  httpsOnly: true,              // sobe http:// para https:// em navegacao
  blockThirdPartyCookies: true,
  antiFingerprint: true,        // ruido em canvas/webgl/audio, navigator limpo
  spoofUserAgent: true,         // UA generico em vez do UA do Electron
  denyPermissions: true,        // nega camera/mic/geo/notificacoes por padrao

  // sessao
  ephemeral: true,              // nada em disco: cookies/cache so na memoria
  homepage: 'https://duckduckgo.com',
  searchTemplate: 'https://duckduckgo.com/?q=%s',
};

class Config {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      for (const key of Object.keys(DEFAULTS)) {
        if (key in parsed) this.data[key] = parsed[key];
      }
    } catch {
      // primeiro boot ou arquivo invalido: fica no default
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('[config] falha ao salvar:', err.message);
    }
  }

  get(key) { return this.data[key]; }
  all() { return { ...this.data }; }

  set(key, value) {
    if (!(key in DEFAULTS)) return false;
    this.data[key] = value;
    this.save();
    return true;
  }
}

module.exports = { Config, DEFAULTS };
