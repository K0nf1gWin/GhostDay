'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * Monta o script injetado em CADA documento, antes de qualquer script da
 * pagina, via CDP (Page.addScriptToEvaluateOnNewDocument). Roda no mundo
 * principal — um preload com contextIsolation vive em outro mundo JS e nao
 * alcancaria os prototypes que a pagina enxerga.
 *
 * O corpo vem de shared/shield.js, o mesmo arquivo que o app Android injeta
 * via WebViewCompat.addDocumentStartJavaScript. Uma fonte, dois alvos.
 */

const SHIELD = path.join(__dirname, '..', '..', '..', 'shared', 'shield.js');

let cache = null;

function shieldSource() {
  if (cache === null) {
    cache = fs.readFileSync(SHIELD, 'utf8');
  }
  return cache;
}

function buildScript(seed) {
  // IIFE em volta: a declaracao de ghostdayShield nao vaza para window.
  return `(function(){${shieldSource()}\nghostdayShield(${JSON.stringify(String(seed))});})();`;
}

module.exports = { buildScript, SHIELD_PATH: SHIELD };
