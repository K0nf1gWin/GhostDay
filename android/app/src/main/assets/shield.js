/* ===================================================================
 * GhostDay - shield de fingerprint
 *
 * FONTE UNICA, usada pelos dois apps:
 *   desktop -> lido em runtime por src/main/fingerprint.js e injetado via CDP
 *              (Page.addScriptToEvaluateOnNewDocument)
 *   android -> copiado para assets/ pelo Gradle e injetado via
 *              WebViewCompat.addDocumentStartJavaScript
 *
 * Roda no mundo principal da pagina, antes de qualquer script dela.
 * Nao editar em dois lugares: este arquivo e o unico.
 *
 * Quem hospeda envolve isto num IIFE e chama ghostdayShield(seed), de modo
 * que nada vaze para o escopo global da pagina (um nome novo em window seria,
 * ele proprio, um sinal de fingerprint).
 * =================================================================== */

function ghostdayShield(seed) {
  'use strict';
  try {
    /* ---------- PRNG estavel por (sessao + site) ---------- */
    const siteKey = seed + '|' + (location.hostname || 'about');
    let h = 2166136261 >>> 0;
    for (let i = 0; i < siteKey.length; i++) {
      h ^= siteKey.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    let s = h || 123456789;
    const rnd = () => {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5;  s >>>= 0;
      return s / 4294967296;
    };

    /* ---------- utilitarios ---------- */
    const nativeToString = Function.prototype.toString;
    const patched = new WeakMap();
    Function.prototype.toString = function () {
      if (patched.has(this)) return 'function ' + (patched.get(this) || '') + '() { [native code] }';
      return nativeToString.call(this);
    };
    patched.set(Function.prototype.toString, 'toString');

    const replace = (obj, name, impl) => {
      try {
        const original = obj[name];
        patched.set(impl, name);
        Object.defineProperty(obj, name, {
          value: impl, writable: true, enumerable: false, configurable: true,
        });
        return original;
      } catch (e) { return null; }
    };

    const define = (obj, name, getter) => {
      try {
        Object.defineProperty(obj, name, { get: getter, configurable: true, enumerable: true });
      } catch (e) { /* propriedade travada */ }
    };

    /* ---------- 1. Canvas ---------- */
    const perturb = (data) => {
      // Mexe no bit menos significativo de ~0,1% dos pixels: invisivel a olho
      // nu, suficiente para mudar o hash da imagem.
      const total = data.length / 4;
      const touches = Math.max(1, Math.floor(total * 0.001));
      for (let i = 0; i < touches; i++) {
        const px = Math.floor(rnd() * total) * 4;
        for (let c = 0; c < 3; c++) {
          const v = data[px + c];
          data[px + c] = v === 255 ? 254 : v + 1;
        }
      }
      return data;
    };

    if (window.CanvasRenderingContext2D) {
      const realGetImageData = replace(CanvasRenderingContext2D.prototype, 'getImageData',
        function getImageData(...args) {
          const result = realGetImageData.apply(this, args);
          try { perturb(result.data); } catch (e) {}
          return result;
        });
    }

    if (window.HTMLCanvasElement) {
      const noisyCopy = (canvas) => {
        const copy = document.createElement('canvas');
        copy.width = canvas.width; copy.height = canvas.height;
        const ctx = copy.getContext('2d');
        ctx.drawImage(canvas, 0, 0);
        const img = ctx.getImageData(0, 0, copy.width, copy.height);
        ctx.putImageData(img, 0, 0);   // getImageData ja aplicou o ruido
        return copy;
      };

      const realToDataURL = replace(HTMLCanvasElement.prototype, 'toDataURL',
        function toDataURL(...args) {
          try { return realToDataURL.apply(noisyCopy(this), args); }
          catch (e) { return realToDataURL.apply(this, args); }
        });

      const realToBlob = replace(HTMLCanvasElement.prototype, 'toBlob',
        function toBlob(cb, ...rest) {
          try { return realToBlob.call(noisyCopy(this), cb, ...rest); }
          catch (e) { return realToBlob.call(this, cb, ...rest); }
        });
    }

    /* ---------- 2. WebGL ---------- */
    // O par vendor/renderer mais comum em notebooks Windows.
    const GL_VENDOR = 'Google Inc. (Intel)';
    const GL_RENDERER = 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)';
    for (const Ctor of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!Ctor) continue;
      const realGetParameter = replace(Ctor.prototype, 'getParameter',
        function getParameter(param) {
          if (param === 37445) return GL_VENDOR;    // UNMASKED_VENDOR_WEBGL
          if (param === 37446) return GL_RENDERER;  // UNMASKED_RENDERER_WEBGL
          if (param === 7936) return 'WebKit';      // VENDOR
          if (param === 7937) return 'WebKit WebGL'; // RENDERER
          return realGetParameter.call(this, param);
        });
    }

    /* ---------- 3. Audio ---------- */
    if (window.AnalyserNode) {
      const realFloatFreq = replace(AnalyserNode.prototype, 'getFloatFrequencyData',
        function getFloatFrequencyData(array) {
          realFloatFreq.call(this, array);
          for (let i = 0; i < array.length; i += 37) array[i] += (rnd() - 0.5) * 0.02;
        });
    }
    if (window.AudioBuffer) {
      const realChannel = replace(AudioBuffer.prototype, 'getChannelData',
        function getChannelData(channel) {
          const data = realChannel.call(this, channel);
          for (let i = 0; i < data.length; i += 1000) data[i] += (rnd() - 0.5) * 1e-7;
          return data;
        });
    }

    /* ---------- 4. navigator ---------- */
    define(navigator, 'hardwareConcurrency', () => 8);
    define(navigator, 'deviceMemory', () => 8);
    define(navigator, 'webdriver', () => false);
    define(navigator, 'languages', () => ['pt-BR', 'pt', 'en-US', 'en']);
    define(navigator, 'plugins', () => Object.freeze([]));
    define(navigator, 'mimeTypes', () => Object.freeze([]));
    define(navigator, 'maxTouchPoints', () => 0);
    if (navigator.userAgentData) {
      define(navigator, 'userAgentData', () => ({
        brands: [
          { brand: 'Chromium', version: '130' },
          { brand: 'Google Chrome', version: '130' },
          { brand: 'Not?A_Brand', version: '99' },
        ],
        mobile: false,
        platform: 'Windows',
        getHighEntropyValues: () => Promise.resolve({
          architecture: 'x86', bitness: '64', model: '',
          platformVersion: '10.0.0', uaFullVersion: '130.0.0.0',
        }),
        toJSON() { return { brands: this.brands, mobile: false, platform: 'Windows' }; },
      }));
    }

    /* ---------- 5. screen ---------- */
    define(screen, 'width', () => 1920);
    define(screen, 'height', () => 1080);
    define(screen, 'availWidth', () => 1920);
    define(screen, 'availHeight', () => 1040);
    define(screen, 'colorDepth', () => 24);
    define(screen, 'pixelDepth', () => 24);

    /* ---------- 6. ruidos menores ---------- */
    // Precisao de medida de tempo: dificulta fingerprint por timing.
    if (window.performance && performance.now) {
      const realNow = replace(performance, 'now', function now() {
        return Math.round(realNow.call(performance) * 10) / 10;
      });
    }
    // Bateria entrega um identificador surpreendentemente bom.
    if (navigator.getBattery) {
      replace(navigator, 'getBattery', function getBattery() {
        return Promise.resolve({
          charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1,
          addEventListener() {}, removeEventListener() {},
        });
      });
    }
  } catch (e) {
    // Nunca deixar a pagina quebrar por causa das defesas.
  }
}
