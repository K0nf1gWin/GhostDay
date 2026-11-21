'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Unica ponte entre a UI e o processo principal. A UI nao tem Node nem acesso
// direto ao ipcRenderer: so estes metodos.
contextBridge.exposeInMainWorld('ghostday', {
  tabs: {
    create:  (url, opts) => ipcRenderer.invoke('tabs:new', url, opts),
    close:   (id)        => ipcRenderer.invoke('tabs:close', id),
    select:  (id)        => ipcRenderer.invoke('tabs:select', id),
    state:   ()          => ipcRenderer.invoke('tabs:state'),
  },
  nav: {
    go:      (input) => ipcRenderer.invoke('nav:go', input),
    back:    ()      => ipcRenderer.invoke('nav:back'),
    forward: ()      => ipcRenderer.invoke('nav:forward'),
    reload:  ()      => ipcRenderer.invoke('nav:reload'),
    stop:    ()      => ipcRenderer.invoke('nav:stop'),
  },
  config: {
    get: ()           => ipcRenderer.invoke('config:get'),
    set: (key, value) => ipcRenderer.invoke('config:set', key, value),
  },
  ui: {
    panel: (open) => ipcRenderer.invoke('ui:panel', open),
  },
  privacy: {
    status: () => ipcRenderer.invoke('privacy:status'),
    wipe:   () => ipcRenderer.invoke('privacy:wipe'),
  },
  blocklist: {
    load:  ()     => ipcRenderer.invoke('blocklist:load'),
    allow: (host) => ipcRenderer.invoke('blocklist:allow', host),
  },
  on: (channel, handler) => {
    const allowed = ['tabs:state', 'config:state', 'ui:focus-address', 'ui:wipe'];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
