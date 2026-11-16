// 回合结束硬闸门：验收单没清零，就不让这轮就这么结束。
// 机制：监听 agent/status=idle → 检查验收单 → agent.followup() 塞一条系统消息把模型拽回来。
// 防打转：每个网关有次数上限 + 冷却 + 只在"本会话确实跑过、且这轮正常结束"时才触发。
import { randomUUID } from 'node:crypto';

const NUDGE_SOURCE = 'dsh-acceptance-gate';

export function installWatchdog(ctx, deps) {
  const getConfig = deps.getConfig;
  const loadGate = deps.loadGate;
  const saveGate = deps.saveGate;
  const summarize = deps.summarize || ((gate) => {
    const items = gate?.items || [];
    const pass = items.filter((i) => i.verdict === 'pass').length;
    return { total: items.length, pass, fail: items.filter((i) => i.verdict === 'fail').length, pending: items.length - pass };
  });
  const log = deps.log || (() => {});

  const state = new Map();
  const timers = new Set();

  function sessionIdOf(agent) {
    return String(agent?.id || agent?.session?.id || agent?.session?.header?.id || '');
  }

  function slot(sid) {
    let cur = state.get(sid);
    if (!cur) {
      cur = { ran: false, count: 0, lastAt: 0, lastUpdatedAt: '' };
      state.set(sid, cur);
    }
    return cur;
  }

  function schedule(fn, ms) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      try { fn(); } catch (error) { log('watchdog nudge failed', error); }
    }, ms);
    timers.add(timer);
    return timer;
  }

  function listen(event, handler) {
    if (typeof ctx?.on !== 'function') return null;
    try {
      return ctx.on(event, handler, { global: true });
    } catch {
      try { return ctx.on(event, handler); } catch { return null; }
    }
  }

  function eventsOf(agent) {
    try {
      if (typeof agent?.session?.snapshotEvents === 'function') return agent.session.snapshotEvents() || [];
    } catch { /* ignore */ }
    try {
      if (Array.isArray(agent?.session?.events)) return agent.session.events;
    } catch { /* ignore */ }
    return [];
  }

  function lastTurnEnd(events) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i]?.type === 'turn/end') return events[i];
    }
    return null;
  }

  function humanSpokeAfter(events, seq) {
    return events.some((event) => {
      if (event?.type !== 'user/message') return false;
      if ((event?.seq || 0) <= seq) return false;
      const kind = event?.data?.source?.kind;
      return kind !== 'plugin' && kind !== NUDGE_SOURCE && kind !== 'dsh-purge';
    });
  }

  function inboxBusy(agent) {
    try {
      const inbox = agent?.inbox;
      if (!inbox) return false;
      if (typeof inbox.hasPending === 'function' && inbox.hasPending()) return true;
      if (typeof inbox.size === 'number' && inbox.size > 0) return true;
      if (typeof inbox.length === 'number' && inbox.length > 0) return true;
    } catch { /* ignore */ }
    return false;
  }

  function buildText(gate, sum) {
    const open = gate.items.filter((i) => i.verdict !== 'pass');
    const lines = [];
    lines.push('【验收闸门】这轮结束了，但验收单还没清零：' + gate.title + '（' + sum.pass + '/' + sum.total + ' 通过）');
    for (const item of open.slice(0, 8)) {
      const how = item.auto
        ? '可用 accept_run id=' + item.id + ' 自动跑'
        : (item.check ? '按 check 手跑' : 'check 缺失，先补');
      lines.push('- #' + item.id + ' [' + item.severity + '/' + (item.verdict === 'fail' ? 'FAIL' : 'TODO') + '] ' + item.requirement + '　→ ' + how);
    }
    if (open.length > 8) lines.push('- ……另外还有 ' + (open.length - 8) + ' 条');
    lines.push('现在做：跑 check（有 auto 的用 accept_run）→ 把真实输出贴进 accept_gate op=verify → 未过的继续修。全部 pass 之后才能收尾。');
    return lines.join('\n');
  }

  function maybeNudge(agent) {
    const cfg = getConfig();
    if (cfg.watchdog === false) return;
    const sid = sessionIdOf(agent);
    if (!sid) return;
    const cur = slot(sid);
    if (!cur.ran) return;
    const gate = loadGate(sid);
    if (!gate || gate.status !== 'open') return;
    const sum = summarize(gate);
    if (sum.total === 0) return;
    if (sum.pass === sum.total) return;
    if (gate.requiresAuto === true) {
      const unrun = gate.items.filter((i) => i.verdict !== 'pass' && i.auto && (!i.runs || i.runs.length === 0));
      if (unrun.length > 0) { /* 有自动项没跑，照样要拽回来 */ }
    }
    const maxNudges = Number(cfg.watchdogMax) > 0 ? Number(cfg.watchdogMax) : 3;
    if ((Number(gate.nudges) || 0) >= maxNudges) return;
    const cooldownNum = Number(cfg.watchdogCooldownMs);
    const cooldown = Number.isFinite(cooldownNum) && cooldownNum >= 0 ? cooldownNum : 15000;
    const now = Date.now();
    if (now - cur.lastAt < cooldown) return;
    if (agent.status === 'running' || inboxBusy(agent)) return;

    const events = eventsOf(agent);
    const end = lastTurnEnd(events);
    if (!end) return;
    const reasonKind = String(end?.data?.reason?.kind || '');
    if (reasonKind === 'aborted' || reasonKind === 'interrupted' || reasonKind === 'error' || reasonKind === 'max-tokens') return;
    if (humanSpokeAfter(events, end.seq || 0)) return;
    const endTime = Number(end.time) || 0;
    if (endTime > 0 && now - endTime > (Number(cfg.watchdogFreshMs) || 600000)) return;
    if (gate.updatedAt === cur.lastUpdatedAt) {
      // 上一轮已经催过、模型没动验收单：再催一次也不是不行，但只允许连续两次
      if (cur.count >= 2) return;
    }

    const text = buildText(gate, sum);
    try {
      if (typeof agent.followup !== 'function') return;
      agent.followup({
        id: 'acceptance-gate-' + randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: NUDGE_SOURCE, form: 'notice', summary: 'acceptance-gate' },
      });
    } catch (error) {
      log('followup failed', error);
      return;
    }
    gate.nudges = (Number(gate.nudges) || 0) + 1;
    gate.lastNudgeAt = new Date().toISOString();
    try { saveGate(sid, gate); } catch { /* ignore */ }
    cur.count += 1;
    cur.lastAt = now;
    cur.lastUpdatedAt = gate.updatedAt;
    log('nudged session ' + sid + ' (gate ' + gate.id + ', nudges=' + gate.nudges + ')');
  }

  const off = listen('agent/status', (payload) => {
    const agent = payload?.agent;
    if (!agent) return;
    const sid = sessionIdOf(agent);
    if (!sid) return;
    const cur = slot(sid);
    if (payload.status === 'running') { cur.ran = true; return; }
    if (payload.status !== 'idle') return;
    const delayNum = Number(getConfig().watchdogDelayMs);
    schedule(() => maybeNudge(agent), Number.isFinite(delayNum) && delayNum >= 0 ? delayNum : 400);
  });

  return {
    dispose() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      try { off?.(); } catch { /* ignore */ }
    },
    state,
  };
}
