'use strict';

/**
 * Uso de CPU e memoria, por aba e por processo.
 *
 * app.getAppMetrics() devolve uma linha por processo do Chromium. Varias abas
 * podem dividir o mesmo processo renderer (mesmo site, ou reaproveitamento),
 * entao a CPU e sempre a do PROCESSO: se duas abas aparecem com o mesmo pid,
 * o numero e o mesmo e nao deve ser somado duas vezes.
 */

const TYPE_LABEL = {
  Browser: 'principal',
  Tab: 'aba',
  Utility: 'utilitario',
  GPU: 'gpu',
  Zygote: 'zygote',
  'Sandbox helper': 'sandbox',
  'Pepper Plugin': 'plugin',
  default: 'outro',
};

/** getAppMetrics devolve memoria em KB. */
function toMB(kb) {
  return Math.round(((kb || 0) / 1024) * 10) / 10;
}

function collect(app, tabs) {
  let raw = [];
  try {
    raw = app.getAppMetrics();
  } catch {
    return { tabs: [], processes: [], totals: { cpu: 0, memMB: 0, processes: 0 } };
  }

  const byPid = new Map();
  for (const m of raw) byPid.set(m.pid, m);

  const perTab = [];
  for (const tab of tabs) {
    let pid = 0;
    try {
      const wc = tab.view.webContents;
      pid = wc.isDestroyed() ? 0 : wc.getOSProcessId();
    } catch {
      pid = 0;
    }
    const m = pid ? byPid.get(pid) : null;
    perTab.push({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      isolated: tab.isolated,
      pid,
      cpu: m ? Math.round((m.cpu?.percentCPUUsage || 0) * 10) / 10 : 0,
      memMB: m ? toMB(m.memory?.workingSetSize) : 0,
      shared: false,
    });
  }

  // marca abas que dividem processo: a CPU ali e do processo, nao da aba
  const seen = new Map();
  for (const t of perTab) {
    if (!t.pid) continue;
    seen.set(t.pid, (seen.get(t.pid) || 0) + 1);
  }
  for (const t of perTab) if (t.pid && seen.get(t.pid) > 1) t.shared = true;

  const processes = raw.map((m) => ({
    pid: m.pid,
    type: TYPE_LABEL[m.type] || TYPE_LABEL.default,
    name: m.name || '',
    cpu: Math.round((m.cpu?.percentCPUUsage || 0) * 10) / 10,
    memMB: toMB(m.memory?.workingSetSize),
  })).sort((a, b) => b.cpu - a.cpu || b.memMB - a.memMB);

  const totals = {
    cpu: Math.round(processes.reduce((s, p) => s + p.cpu, 0) * 10) / 10,
    memMB: Math.round(processes.reduce((s, p) => s + p.memMB, 0) * 10) / 10,
    processes: processes.length,
  };

  return { tabs: perTab, processes, totals };
}

module.exports = { collect };
