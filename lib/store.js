// 验收单存储 + KPI 归档
// ~/.dsh/acceptance/<sessionId>.json        当前验收单
// ~/.dsh/acceptance/<sessionId>.history.jsonl  被替换/重置的历史
// ~/.dsh/acceptance/kpi.jsonl               每次结单一行，跨会话统计
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

export const ROOT = nodePath.join(os.homedir(), '.dsh', 'acceptance');
export const KPI_FILE = nodePath.join(ROOT, 'kpi.jsonl');

function ensureDir() {
  try { fs.mkdirSync(ROOT, { recursive: true }); } catch { /* 存在或不可写 */ }
}

export function safeKey(sessionId) {
  const s = String(sessionId || 'default').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return s || 'default';
}

export function fileFor(sessionId) {
  return nodePath.join(ROOT, safeKey(sessionId) + '.json');
}

export function historyFor(sessionId) {
  return nodePath.join(ROOT, safeKey(sessionId) + '.history.jsonl');
}

export function loadGate(sessionId) {
  try {
    const gate = JSON.parse(fs.readFileSync(fileFor(sessionId), 'utf8'));
    if (!gate || typeof gate !== 'object' || !Array.isArray(gate.items)) return null;
    gate.nudges = Number(gate.nudges) || 0;
    return gate;
  } catch {
    return null;
  }
}

export function saveGate(sessionId, gate) {
  ensureDir();
  const file = fileFor(sessionId);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(gate, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

export function archiveGate(sessionId, gate) {
  if (!gate) return;
  ensureDir();
  try {
    fs.appendFileSync(historyFor(sessionId), JSON.stringify({ archivedAt: new Date().toISOString(), gate }) + '\n', 'utf8');
  } catch { /* 归档失败不阻塞 */ }
}

export function readHistory(sessionId, limit = 20) {
  try {
    const lines = fs.readFileSync(historyFor(sessionId), 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

const SEVERITIES = ['P0', 'P1', 'P2', 'P3'];

export function normalizeSeverity(value, fallback = 'P1') {
  const raw = String(value || '').toUpperCase().replace(/[^P0-3]/g, '');
  return SEVERITIES.includes(raw) ? raw : fallback;
}

export function newGate({ sessionId, cwd, title, kind, items, severity, requiresAuto, note }) {
  const now = new Date().toISOString();
  const gate = {
    id: 'g_' + Math.random().toString(36).slice(2, 10),
    sessionId: String(sessionId || 'default'),
    cwd: String(cwd || ''),
    title: String(title || '').trim() || '未命名需求',
    kind: kind === 'feature' ? 'feature' : 'fix',
    severity: normalizeSeverity(severity),
    requiresAuto: requiresAuto === true,
    status: 'open',
    createdAt: now,
    updatedAt: now,
    nudges: 0,
    note: String(note || ''),
    impact: null,
    items: items.map((item, index) => ({
      id: index + 1,
      requirement: String(item?.requirement || '').trim(),
      check: String(item?.check || '').trim(),
      severity: normalizeSeverity(item?.severity, normalizeSeverity(severity)),
      auto: item?.auto && typeof item.auto === 'object' ? item.auto : null,
      baseline: String(item?.baseline || '').trim(),
      baselineAuto: null,
      evidence: '',
      evidenceAuto: null,
      evidenceSource: '',
      runs: [],
      verdict: 'pending',
      note: '',
      updatedAt: now,
    })).filter((item) => item.requirement !== ''),
  };
  return gate;
}

export function summarize(gate) {
  if (!gate) return { total: 0, pass: 0, fail: 0, pending: 0, open: false, auto: 0, autoPass: 0, manualPass: 0, unsignedPass: 0, p0pending: 0 };
  const items = gate.items || [];
  const total = items.length;
  const pass = items.filter((i) => i.verdict === 'pass').length;
  const fail = items.filter((i) => i.verdict === 'fail').length;
  const auto = items.filter((i) => i.auto).length;
  const autoPass = items.filter((i) => i.verdict === 'pass' && i.evidenceSource === 'auto').length;
  const manualPass = items.filter((i) => i.verdict === 'pass' && i.evidenceSource !== 'auto').length;
  const p0pending = items.filter((i) => i.severity === 'P0' && i.verdict !== 'pass').length;
  return {
    total, pass, fail, pending: total - pass - fail, open: gate.status === 'open',
    auto, autoPass, manualPass, unsignedPass: manualPass, p0pending,
  };
}

export function appendKpi(record) {
  ensureDir();
  try {
    fs.appendFileSync(KPI_FILE, JSON.stringify(record) + '\n', 'utf8');
  } catch { /* ignore */ }
}

export function readKpi(limit = 500) {
  try {
    const lines = fs.readFileSync(KPI_FILE, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export function computeStats(limit = 500) {
  const rows = readKpi(limit);
  const total = rows.length;
  const firstPass = rows.filter((r) => r.failCount === 0 && r.forceClosed !== true).length;
  const forced = rows.filter((r) => r.forceClosed === true).length;
  const autoItems = rows.reduce((sum, r) => sum + (Number(r.autoCount) || 0), 0);
  const allItems = rows.reduce((sum, r) => sum + (Number(r.total) || 0), 0);
  const manualled = rows.reduce((sum, r) => sum + (Number(r.manualPass) || 0), 0);
  const durations = rows.map((r) => Number(r.durationMs) || 0).filter((n) => n > 0);
  const avgMs = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
  return {
    gates: total,
    firstPassRate: total ? Math.round((firstPass / total) * 1000) / 10 : 0,
    forceCloseRate: total ? Math.round((forced / total) * 1000) / 10 : 0,
    autoCoverage: allItems ? Math.round((autoItems / allItems) * 1000) / 10 : 0,
    manualPassRate: allItems ? Math.round((manualled / allItems) * 1000) / 10 : 0,
    avgDurationMs: avgMs,
    recent: rows.slice(-10).map((r) => ({
      at: r.at, title: r.title, total: r.total, pass: r.pass, fail: r.fail,
      autoCount: r.autoCount, manualPass: r.manualPass, forceClosed: r.forceClosed, durationMs: r.durationMs,
    })),
  };
}
