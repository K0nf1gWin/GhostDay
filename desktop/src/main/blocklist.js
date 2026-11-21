'use strict';
const fs = require('node:fs');

// Semente embutida: dominios de rastreamento/telemetria/anuncio mais comuns.
// Para cobertura seria, carregue uma lista EasyList/uBlock com loadFile().
const SEED = `
google-analytics.com
analytics.google.com
googletagmanager.com
googletagservices.com
googlesyndication.com
googleadservices.com
doubleclick.net
adservice.google.com
pagead2.googlesyndication.com
connect.facebook.net
graph.facebook.com
pixel.facebook.com
an.facebook.com
analytics.tiktok.com
business-api.tiktok.com
ads-api.twitter.com
analytics.twitter.com
static.ads-twitter.com
ads.linkedin.com
px.ads.linkedin.com
snap.licdn.com
bat.bing.com
clarity.ms
c.clarity.ms
scorecardresearch.com
quantserve.com
quantcount.com
criteo.com
criteo.net
taboola.com
outbrain.com
pubmatic.com
rubiconproject.com
openx.net
adnxs.com
adsrvr.org
casalemedia.com
sharethrough.com
teads.tv
smartadserver.com
yieldmo.com
3lift.com
bidswitch.net
mathtag.com
rlcdn.com
crwdcntrl.net
demdex.net
omtrdc.net
everesttech.net
adobedtm.com
hotjar.com
hotjar.io
fullstory.com
mouseflow.com
luckyorange.com
smartlook.com
inspectlet.com
crazyegg.com
mixpanel.com
api.mixpanel.com
segment.com
api.segment.io
cdn.segment.com
amplitude.com
api.amplitude.com
heap.io
heapanalytics.com
braze.com
appsflyer.com
adjust.com
branch.io
kochava.com
singular.net
onesignal.com
pushwoosh.com
urbanairship.com
newrelic.com
nr-data.net
bugsnag.com
sentry.io
rollbar.com
loggly.com
mparticle.com
tealiumiq.com
krxd.net
exelator.com
bluekai.com
addthis.com
sharethis.com
disqus.com
zopim.com
intercom.io
drift.com
hubspot.com
hs-analytics.net
hsforms.net
marketo.net
mktoresp.com
pardot.com
eloqua.com
yandex.ru
mc.yandex.ru
metrika.yandex.ru
top-fwz1.mail.ru
vk.com
stats.wp.com
pixel.wp.com
moatads.com
doubleverify.com
adsafeprotected.com
ipredictive.com
zemanta.com
revcontent.com
mgid.com
propellerads.com
popads.net
`;

function parseLines(text) {
  const out = [];
  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('!') || line.startsWith('#') || line.startsWith('[')) continue;

    // formato hosts: "0.0.0.0 dominio.com"
    const hosts = line.match(/^(?:0\.0\.0\.0|127\.0\.0\.1)\s+(\S+)$/);
    if (hosts) { out.push(hosts[1].toLowerCase()); continue; }

    // formato EasyList: "||dominio.com^" (ignoramos regras com opcoes complexas)
    const easy = line.match(/^\|\|([a-z0-9.-]+)\^?(\$third-party)?$/i);
    if (easy) { out.push(easy[1].toLowerCase()); continue; }

    // dominio puro
    if (/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(line) && line.includes('.')) {
      out.push(line.toLowerCase());
    }
  }
  return out;
}

class Blocklist {
  constructor() {
    this.hosts = new Set(parseLines(SEED));
    this.allow = new Set();     // excecoes do usuario
    this.blockedCount = 0;
  }

  get size() { return this.hosts.size; }

  /** Carrega um arquivo extra (EasyList, hosts ou dominios por linha). */
  loadFile(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    const before = this.hosts.size;
    for (const h of parseLines(text)) this.hosts.add(h);
    return this.hosts.size - before;
  }

  allowHost(host) { this.allow.add(String(host).toLowerCase()); }

  /** Casa o host e qualquer dominio pai: ads.foo.co -> foo.co */
  matches(hostname) {
    if (!hostname) return false;
    const host = hostname.toLowerCase();
    const parts = host.split('.');
    for (let i = 0; i < parts.length - 1; i++) {
      const candidate = parts.slice(i).join('.');
      if (this.allow.has(candidate)) return false;
      if (this.hosts.has(candidate)) return true;
    }
    return false;
  }

  shouldBlock(url) {
    try {
      const { hostname, protocol } = new URL(url);
      if (protocol !== 'http:' && protocol !== 'https:') return false;
      if (this.matches(hostname)) { this.blockedCount++; return true; }
      return false;
    } catch {
      return false;
    }
  }
}

module.exports = { Blocklist };
