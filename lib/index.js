// dsh-acceptance-gate — 验收闭环（宿主侧）
//
// 四层强制：
//   1) system prompt 每轮注入协议 + 现读的验收单状态（欠账一直摆在模型眼前）
//   2) accept_run：插件自己跑 check（shell/http/file），产出 exit code + 输出 + sha256 + 耗时
//      → 证据不可自证，人工 pass 会标 UNSIGNED
//   3) 质量守门：空话需求、跑不出来的 check、没有断言的 auto 当场拒收
//   4) 回合闸门：验收单没清零就 agent.followup() 把模型拽回来，带次数上限与冷却
import fs from 'node:fs';
import nodePath from 'node:path';
import { runAuto, hasAuto, cap } from './checks.js';
import { inspectItem, inspectTracks, boundaryHints } from './quality.js';
import { analyzeImpact } from './impact.js';
import { buildMarkdown, buildJson, buildHtml } from './report.js';
import { installWatchdog } from './watchdog.js';
import { PROTOCOL_BODY, stateBlock } from './protocol.js';
import { scanSecrets, purgeSecrets, renderScan } from './secrets.js';
import {
  loadGate, saveGate, archiveGate, newGate, summarize, readHistory, ROOT,
  appendKpi, computeStats, normalizeSeverity,
} from './store.js';

export const name = 'dsh-acceptance-gate';
export const inject = ['systemPrompt', 'tools'];

const DEFAULTS = {
  enabled: true,
  sectionOrder: 70,
  sectionName: 'acceptance-gate',
  strictMode: true,          // 用例质量守门
  strictPass: true,          // 人工 pass 必须带 evidence
  allowManualPass: false,    // 有 auto 的条目是否允许人工 pass
  requireAuto: false,        // 全局要求每条都要 auto
  autoRunVerify: true,       // accept_run 默认 mode=verify
  autoClose: true,           // 全 pass 自动结单
  writeReportOnClose: true,  // 结单时落 ACCEPTANCE.md / acceptance.json
  kpi: true,                 // 写 KPI
  watchdog: true,            // 回合闸门
  watchdogMax: 3,
  watchdogCooldownMs: 15000,
  watchdogDelayMs: 400,
  watchdogFreshMs: 600000,
  shellTimeoutMs: 120000,
  httpTimeoutMs: 30000,
  maxOutputChars: 8000,
  runConcurrency: 4,       // auto 条目并发执行数
  retryOnFail: 1,          // 失败后重跑次数（用于识别 flake，不用于放水）
};

const BOOL_KEYS = ['enabled', 'strictMode', 'strictPass', 'allowManualPass', 'requireAuto', 'autoRunVerify', 'autoClose', 'writeReportOnClose', 'kpi', 'watchdog'];
const NUM_KEYS = ['sectionOrder', 'watchdogMax', 'watchdogCooldownMs', 'watchdogDelayMs', 'watchdogFreshMs', 'shellTimeoutMs', 'httpTimeoutMs', 'maxOutputChars', 'runConcurrency', 'retryOnFail'];

function pickConfig(raw) {
  const cfg = { ...DEFAULTS, ...(raw || {}) };
  for (const key of BOOL_KEYS) {
    if (typeof cfg[key] === 'string') cfg[key] = !/^(false|0|no|off)$/i.test(cfg[key].trim());
  }
  for (const key of NUM_KEYS) {
    const n = Number(cfg[key]);
    cfg[key] = Number.isFinite(n) ? n : DEFAULTS[key];
  }
  return cfg;
}

function sessionIdOf(source) {
  try {
    return String(
      source?.agent?.session?.id || source?.agent?.sessionId
      || source?.agent?.session?.header?.id || source?.sessionId
      || source?.session?.id || '',
    ) || '';
  } catch {
    return '';
  }
}

function cwdOf(source) {
  try {
    return String(source?.agent?.session?.header?.cwd || source?.cwd || process.cwd());
  } catch {
    return process.cwd();
  }
}

const nowIso = () => new Date().toISOString();

function evidenceLine(kind, evidence, ok, reason) {
  const parts = ['[' + (ok ? 'AUTO-PASS' : 'AUTO-FAIL') + ' ' + kind + ']'];
  if (evidence?.exitCode !== undefined) parts.push('exit=' + evidence.exitCode);
  if (evidence?.status !== undefined) parts.push('HTTP ' + evidence.status);
  if (evidence?.durationMs !== undefined) parts.push(evidence.durationMs + 'ms');
  if (evidence?.hash) parts.push('hash=' + String(evidence.hash).slice(0, 12));
  const body = evidence?.stdoutTail || evidence?.bodyTail || evidence?.error || '';
  if (body) parts.push('输出: ' + cap(body, 320).replace(/\n/g, ' ⏎ '));
  if (!ok && reason) parts.push('原因: ' + reason);
  return parts.join(' ');
}

function renderStatus(gate, sessionKey) {
  const sum = summarize(gate);
  const lines = [];
  if (!gate) {
    lines.push('验收单：无');
    lines.push('储存目录：' + ROOT);
    return lines.join('\n');
  }
  lines.push('验收单 ' + gate.id + '｜' + gate.status + '｜' + gate.title + '｜' + gate.kind + '｜最高级 ' + gate.severity);
  lines.push('进度：' + sum.pass + '/' + sum.total + ' 通过，fail ' + sum.fail + '，pending ' + sum.pending
    + '；auto ' + sum.auto + ' 条（自动通过 ' + sum.autoPass + '，人工自证 ' + sum.manualPass + '）');
  lines.push('会话：' + sessionKey + '　cwd：' + (gate.cwd || '-') + '　闸门触发：' + (gate.nudges || 0) + ' 次');
  const trackOf = (kind) => {
    const list = gate.items.filter((i) => (String(i?.auto?.kind || '').toLowerCase() === 'ui') === (kind === 'ui'));
    return { total: list.length, pass: list.filter((i) => i.verdict === 'pass').length };
  };
  const tCode = trackOf('code');
  const tUi = trackOf('ui');
  lines.push('轨道：代码 ' + tCode.pass + '/' + tCode.total + '　交互 ' + tUi.pass + '/' + tUi.total
    + (gate.interactive ? '（本次涉及人机交互：两轨都要跑）' : '（未申报交互：交互轨可省）'));
  if (gate.impact && gate.impact.ok) {
    lines.push('改动面：' + (gate.impact.files.length ? gate.impact.files.slice(0, 10).join('、') : '工作区干净'));
  }
  for (const item of gate.items) {
    lines.push('#' + item.id + ' [' + item.severity + '/' + item.verdict + '] ' + item.requirement);
    if (item.check) lines.push('   check: ' + item.check);
    if (item.auto) lines.push('   auto: ' + JSON.stringify(item.auto).slice(0, 240));
    if (item.baseline) lines.push('   baseline: ' + cap(item.baseline, 300).replace(/\n/g, ' ⏎ '));
    if (item.evidence) lines.push('   evidence(' + (item.evidenceSource || 'none') + '): ' + cap(item.evidence, 300).replace(/\n/g, ' ⏎ '));
    if (item.runs && item.runs.length) lines.push('   实跑: ' + item.runs.length + ' 次，最近 ' + item.runs[item.runs.length - 1].at + ' ' + (item.runs[item.runs.length - 1].ok ? 'PASS' : 'FAIL'));
    if (item.note) lines.push('   note: ' + cap(item.note, 200));
  }
  const p0open = gate.items.filter((i) => i.severity === 'P0' && i.verdict !== 'pass');
  if (p0open.length) lines.push('⚠ P0 未过 ' + p0open.length + ' 条：' + p0open.map((i) => '#' + i.id).join(', '));
  lines.push(sum.total > 0 && sum.pass === sum.total ? '结论：全部条目已通过。可以说完成了。' : '结论：还没验完，不能宣布完成。');
  return lines.join('\n');
}

export function apply(ctx, rawConfig) {
  const cfg = pickConfig(rawConfig);
  if (cfg.enabled === false) return;

  // ── 提示词段
  try {
    const disposer = ctx.systemPrompt.section({
      name: cfg.sectionName,
      order: cfg.sectionOrder,
      interpolate: false,
      text: (context) => {
        try {
          const sid = sessionIdOf(context);
          const gate = sid ? loadGate(sid) : null;
          return PROTOCOL_BODY + '\n\n' + stateBlock(gate, sid || 'unknown');
        } catch (error) {
          ctx.logger?.warn?.('dsh-acceptance-gate: prompt section failed', error);
          return PROTOCOL_BODY;
        }
      },
    });
    if (typeof disposer === 'function' && typeof ctx.effect === 'function') {
      ctx.effect(() => () => { try { disposer(); } catch { /* ignore */ } }, 'dsh-acceptance-gate: prompt section');
    }
  } catch (error) {
    ctx.logger?.warn?.('dsh-acceptance-gate: systemPrompt.section unavailable', error);
  }

  // ── 回合闸门
  if (cfg.watchdog) {
    try {
      const watchdog = installWatchdog(ctx, {
        getConfig: () => cfg,
        loadGate,
        saveGate,
        summarize,
        log: (...args) => { if (cfg.verbose) console.log('[acceptance-gate]', ...args); },
      });
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => { try { watchdog.dispose(); } catch { /* ignore */ } }, 'dsh-acceptance-gate: watchdog');
      }
    } catch (error) {
      ctx.logger?.warn?.('dsh-acceptance-gate: watchdog install failed', error);
    }
  }

  // ── 工具
  if (!ctx.tools || typeof ctx.tools.register !== 'function') return;

  const textOutput = (props) => ({
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' }, ...props } },
    render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
  });

  const runnerOptions = (gate) => ({
    cwd: gate.cwd || process.cwd(),
    shellTimeoutMs: cfg.shellTimeoutMs,
    httpTimeoutMs: cfg.httpTimeoutMs,
  });

  // 失败诊断：从输出里认几个高频模式，直接给下一步，而不是让模型自己瞎猜
  function diagnose(evidence) {
    const text = String((evidence?.stdoutTail || '') + '\n' + (evidence?.stderrTail || '') + '\n' + (evidence?.error || ''));
    const hits = [];
    if (/ECONNREFUSED|connection refused/i.test(text)) hits.push('端口没起来或服务没启动：先确认进程在监听');
    if (/ENOENT|no such file/i.test(text)) hits.push('路径不存在：确认 cwd 与相对路径基准');
    if (/EADDRINUSE/i.test(text)) hits.push('端口被占用：换端口或干掉旧进程');
    if (/401|403|Unauthorized|Forbidden/i.test(text)) hits.push('鉴权失败：检查 token/权限，不是功能坏了');
    if (/timeout|timed out/i.test(text)) hits.push('超时：先量耗时，再决定是调 timeout 还是修慢查询');
    if (/Cannot find module|MODULE_NOT_FOUND/i.test(text)) hits.push('依赖/路径解析失败：装依赖或改 import 路径');
    if (/AssertionError|assert/i.test(text)) hits.push('断言失败：看期望值与实际值的差，别急着改断言');
    return hits.slice(0, 3);
  }

  async function runItems(gate, targets, mode) {
    const results = [];
    const concurrency = Math.max(1, Math.min(16, Number(cfg.runConcurrency) || 4));
    const retries = Math.max(0, Math.min(3, Number(cfg.retryOnFail) || 0));
    const queue = targets.slice();

    async function worker() {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) return;
        if (!hasAuto(item)) {
          results.push({ id: item.id, skipped: true, reason: '无 auto，只能人工验' });
          continue;
        }
        let outcome = await runAuto(item, runnerOptions(gate));
        let attempts = 1;
        let flaky = false;
        if (!outcome.ok && mode === 'verify' && retries > 0) {
          for (let i = 0; i < retries; i += 1) {
            const retry = await runAuto(item, runnerOptions(gate));
            attempts += 1;
            if (retry.ok) { flaky = true; outcome = retry; break; }
            outcome = retry;
          }
        }
        const delta = mode === 'verify' && item.baselineAuto?.hash
          ? (item.baselineAuto.hash === outcome.evidence?.hash ? 'unchanged' : 'changed')
          : 'no-baseline';
        const diag = outcome.ok ? [] : diagnose(outcome.evidence);
        const run = { at: nowIso(), ok: outcome.ok, reason: outcome.reason, mode, attempts, flaky, delta, diagnose: diag, evidence: outcome.evidence };
        item.runs = Array.isArray(item.runs) ? item.runs.slice(-9) : [];
        item.runs.push(run);
        if (mode === 'baseline') {
          item.baselineAuto = outcome.evidence;
          item.baseline = evidenceLine(outcome.evidence?.kind || 'auto', outcome.evidence, outcome.ok, outcome.reason);
        } else {
          const noteBits = [];
          if (flaky) noteBits.push('FLAKY（重跑第 ' + attempts + ' 次才过，疑似偶发，不算稳定通过）');
          if (delta === 'unchanged') noteBits.push('Δ基线未变（输出与修前完全一致，若这是"修复回执"请核对是否真的变了）');
          if (delta === 'changed') noteBits.push('Δ基线已变（输出与修前不同）');
          if (diag.length) noteBits.push('建议：' + diag.join('；'));
          item.evidenceAuto = outcome.evidence;
          item.evidence = evidenceLine(outcome.evidence?.kind || 'auto', outcome.evidence, outcome.ok, outcome.reason)
            + (noteBits.length ? ' ' + noteBits.join(' ') : '');
          item.evidenceSource = 'auto';
          item.flaky = flaky;
          item.delta = delta;
          item.verdict = (outcome.ok && !flaky) ? 'pass' : 'fail';
          if (flaky) item.note = 'FLAKY：' + (item.note || '');
        }
        item.updatedAt = nowIso();
        results.push({ id: item.id, ok: outcome.ok, flaky, delta, attempts, reason: outcome.reason, evidence: outcome.evidence, diagnose: diag });
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
    results.sort((a, b) => Number(a.id) - Number(b.id));
    gate.updatedAt = nowIso();
    return results;
  }

  function maybeClose(gate, sid) {
    const sum = summarize(gate);
    if (cfg.autoClose && gate.status === 'open' && sum.total > 0 && sum.pass === sum.total) {
      gate.status = 'passed';
      gate.closedAt = nowIso();
      saveGate(sid, gate);
      if (cfg.writeReportOnClose) {
        try { writeReports(gate); } catch { /* ignore */ }
      }
      if (cfg.kpi) recordKpi(gate);
      return true;
    }
    return false;
  }

  function writeReports(gate) {
    const dir = gate.cwd || process.cwd();
    fs.mkdirSync(dir, { recursive: true });
    const md = nodePath.join(dir, 'ACCEPTANCE.md');
    const json = nodePath.join(dir, 'acceptance.json');
    const html = nodePath.join(dir, 'ACCEPTANCE.html');
    fs.writeFileSync(md, buildMarkdown(gate), 'utf8');
    fs.writeFileSync(json, JSON.stringify(buildJson(gate), null, 2), 'utf8');
    fs.writeFileSync(html, buildHtml(gate), 'utf8');
    return { md, json, html };
  }

  function recordKpi(gate) {
    const sum = summarize(gate);
    const createdAt = Date.parse(gate.createdAt) || Date.now();
    appendKpi({
      at: nowIso(),
      gateId: gate.id,
      title: gate.title,
      kind: gate.kind,
      severity: gate.severity,
      status: gate.status,
      total: sum.total,
      pass: sum.pass,
      failCount: sum.fail,
      autoCount: sum.auto,
      autoPass: sum.autoPass,
      manualPass: sum.manualPass,
      forceClosed: gate.status === 'abandoned',
      nudges: gate.nudges || 0,
      durationMs: Date.now() - createdAt,
      cwd: gate.cwd,
    });
  }

  // ── accept_run：插件真跑
  ctx.tools.register({
    name: 'accept_run',
    description: '验收执行器：插件自己跑 check（shell/http/file），产出 exit code、输出、sha256、耗时作为证据。mode=baseline 记修前基线，mode=verify（默认）结案并给 pass/fail。id 省略或 all = 全部未结案条目。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '条目编号，或 all / 省略' },
        mode: { type: 'string', enum: ['baseline', 'verify'], description: '默认 verify' },
      },
    },
    output: textOutput({ session: { type: 'string' }, passed: { type: 'number' }, failed: { type: 'number' } }),
    async execute(args, exec) {
      try {
        const sid = sessionIdOf(exec) || 'default';
        const gate = loadGate(sid);
        if (!gate) return { text: 'ERROR: 这个会话还没有验收单。先 accept_gate op=open。', session: sid };
        const mode = args?.mode === 'baseline' ? 'baseline' : 'verify';
        const idArg = String(args?.id ?? 'all').trim();
        const pool = idArg === 'all' || idArg === ''
          ? gate.items.filter((i) => (mode === 'baseline' ? true : i.verdict !== 'pass'))
          : gate.items.filter((i) => String(i.id) === idArg);
        if (pool.length === 0) {
          return { text: '没有需要跑的条目（' + (idArg === 'all' ? '全部已结案' : '编号 ' + idArg + ' 不存在') + '）。\n\n' + renderStatus(gate, sid), session: sid };
        }
        const results = await runItems(gate, pool, mode);
        saveGate(sid, gate);
        const closed = mode === 'verify' ? maybeClose(gate, sid) : false;
        const lines = [];
        lines.push(mode === 'baseline' ? '基线采集完成：' : '执行完成：');
        for (const r of results) {
          if (r.skipped) { lines.push('- #' + r.id + ' 跳过（' + r.reason + '）'); continue; }
          const ev = r.evidence || {};
          const flags = (r.flaky ? ' FLAKY' : '') + (r.attempts > 1 ? ' attempts=' + r.attempts : '') + (r.delta && r.delta !== 'no-baseline' ? ' Δ基线' + (r.delta === 'unchanged' ? '未变' : '已变') : '');
          lines.push('- #' + r.id + ' ' + (r.ok ? (r.flaky ? 'FLAKY' : 'PASS') : 'FAIL') + '　' + (ev.kind || '') + (flags ? '　' + flags : '') + '　'
            + (ev.exitCode !== undefined ? 'exit=' + ev.exitCode + ' ' : '')
            + (ev.status !== undefined ? 'HTTP ' + ev.status + ' ' : '')
            + (ev.durationMs !== undefined ? ev.durationMs + 'ms ' : '')
            + (ev.hash ? 'hash=' + String(ev.hash).slice(0, 12) : '')
            + (r.reason ? '　' + r.reason : ''));
        }
        if (closed) lines.push('\n全部条目通过，验收单已关闭，报告已落盘。');
        const passed = results.filter((r) => r.ok === true).length;
        const failed = results.filter((r) => r.ok === false).length;
        return { text: lines.join('\n') + '\n\n' + renderStatus(gate, sid), session: sid, passed, failed };
      } catch (error) {
        return { text: 'ERROR: accept_run 异常：' + String((error && error.message) || error) };
      }
    },
  });

  // ── accept_secrets：敏感信息扫描/清理（测试流程固定一环）
  ctx.tools.register({
    name: 'accept_secrets',
    description: '敏感信息扫描：扫源码与数据目录里的 API key、私钥、Bearer、手机号、身份证、邮箱、硬编码用户目录，以及聊天历史/凭据/数据库/cookie 等敏感文件。op=scan 只看（打码）；op=purge 删除敏感文件（源码里的字面量需要改代码，不整片删）。roots 省略时扫当前工作目录。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        op: { type: 'string', enum: ['scan', 'purge'] },
        roots: { type: 'array', items: { type: 'string' }, description: '要扫的目录，省略=当前 cwd' },
        limit: { type: 'number', description: '最多扫多少个文件，默认 4000' },
        dryRun: { type: 'boolean', description: 'purge 时只列出不真删' },
      },
      required: ['op'],
    },
    output: textOutput({ cleaned: { type: 'number' } }),
    async execute(args, exec) {
      try {
        const cwd = cwdOf(exec);
        const roots = Array.isArray(args?.roots) && args.roots.length ? args.roots : [cwd];
        const result = scanSecrets({ roots, limit: args?.limit });
        if (String(args?.op || 'scan') === 'scan') {
          return { text: renderScan(result) };
        }
        const purged = purgeSecrets(result, { dryRun: args?.dryRun === true });
        const lines = [renderScan(result), '', args?.dryRun === true ? '【演练】未删除任何文件' : '【已删除 ' + purged.removed.length + ' 个敏感文件】'];
        for (const r of purged.removed.slice(0, 40)) lines.push('- ' + r.path);
        for (const r of purged.failed) lines.push('- 删除失败 ' + r.path + '：' + r.error);
        if (result.hits.length) lines.push('', '源码里还有 ' + result.hits.length + ' 处内容命中：改代码去掉字面量（读 env/配置），不要整片删源文件。');
        return { text: lines.join('\n'), cleaned: purged.removed.length };
      } catch (error) {
        return { text: 'ERROR: accept_secrets 异常：' + String((error && error.message) || error) };
      }
    },
  });

  // ── accept_gate：登记 / 结案 / 影响面 / 报告 / 统计
  ctx.tools.register({
    name: 'accept_gate',
    description: '验收单管理：open 开工登记（质量守门会拒收空话需求与跑不出来的 check）、status 看单、baseline 记修前现象、verify 人工结案（有 auto 的条目会被要求用 accept_run）、add 追加回归项、drop 删除条目、scope 采集影响面、report 落报告、close 结单、stats 看 KPI、history 历史、reset 清空。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        op: {
          type: 'string',
          enum: ['open', 'status', 'baseline', 'verify', 'note', 'add', 'drop', 'scope', 'report', 'close', 'stats', 'history', 'reset'],
        },
        title: { type: 'string' },
        kind: { type: 'string', enum: ['fix', 'feature'] },
        severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
        requiresAuto: { type: 'boolean', description: 'open：要求每条都必须带 auto' },
        interactive: { type: 'boolean', description: 'open：本次改动是否涉及人机交互（页面/按钮/表单/终端/GUI）。true 时必须登记至少一条 auto.kind="ui" 的交互轨并给 artifact 截图/日志；false 表示纯代码，交互轨可省' },
        items: {
          type: 'array',
          description: 'open/add：验收条目',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              requirement: { type: 'string' },
              check: { type: 'string' },
              severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
              baseline: { type: 'string' },
              auto: {
                type: 'object',
                description: '可执行判据：代码轨 {kind:"shell",cmd,expectExit,expectStdout} | {kind:"http",url,expectStatus,expectBody} | {kind:"file",path,expectMatch,expectExists}；交互轨 {kind:"ui",cmd,expectStdout,artifact:"截图/日志路径"}（真跑点击/输入流程，必须留产物）',
              },
            },
            required: ['requirement'],
          },
        },
        id: { type: 'string', description: '条目编号，或 all' },
        verdict: { type: 'string', enum: ['pass', 'fail'] },
        evidence: { type: 'string' },
        baseline: { type: 'string' },
        note: { type: 'string' },
        force: { type: 'boolean' },
        reason: { type: 'string' },
      },
      required: ['op'],
    },
    output: textOutput({ session: { type: 'string' }, file: { type: 'string' } }),
    async execute(args, exec) {
      try {
        const sid = sessionIdOf(exec) || 'default';
        const cwd = cwdOf(exec);
        const op = String(args?.op || 'status');

        if (op === 'open') {
          const rawItems = Array.isArray(args?.items) ? args.items : [];
          if (rawItems.length === 0) return { text: 'ERROR: 验收单不能是空的。至少一条 items[{requirement, check|auto}]。' };
          const kind = args?.kind === 'feature' ? 'feature' : 'fix';
          const issues = [];
          const warnings = [];
          for (const [index, item] of rawItems.entries()) {
            const verdict = inspectItem(item, { strictMode: cfg.strictMode, kind });
            for (const error of verdict.errors) issues.push('#' + (index + 1) + ' ' + error);
            for (const warning of verdict.warnings) warnings.push('#' + (index + 1) + ' ' + warning);
            if (cfg.requireAuto && !(item?.auto && typeof item.auto === 'object')) {
              issues.push('#' + (index + 1) + ' 全局要求每条都带 auto，但这条没有');
            }
          }
          const tracks = inspectTracks(rawItems, { interactive: args?.interactive === true });
          for (const error of tracks.errors) issues.push('[两轨] ' + error);
          for (const warning of tracks.warnings) warnings.push('[两轨] ' + warning);
          if (issues.length > 0) {
            return {
              text: 'ERROR: 验收单被质量守门拒收（' + issues.length + ' 条问题）：\n- ' + issues.join('\n- ')
                + '\n\n改法：requirement 写"用户能观察到什么变了"；check 写成能跑的判据；能给 auto 就给 auto。\n'
                + '可参考的边界/异常补充：\n- ' + boundaryHints().join('\n- '),
            };
          }
          const previous = loadGate(sid);
          if (previous && previous.status === 'open') archiveGate(sid, previous);
          const gate = newGate({
            sessionId: sid, cwd, title: args?.title, kind,
            severity: args?.severity, items: rawItems,
            requiresAuto: args?.requiresAuto === true || cfg.requireAuto,
          });
          gate.interactive = args?.interactive === true;
          gate.tracks = { code: tracks.tracks.code, ui: tracks.tracks.ui };
          try { gate.impact = analyzeImpact(cwd); } catch { gate.impact = null; }
          const file = saveGate(sid, gate);
          const head = ['已登记验收单 ' + gate.id + '（' + gate.items.length + ' 项，' + gate.severity + '）'];
          if (warnings.length) head.push('提醒：\n- ' + warnings.join('\n- '));
          head.push('下一步：有 auto 的先 accept_run mode=baseline 记基线，再动手。');
          return { text: head.join('\n') + '\n\n' + renderStatus(gate, sid), session: sid, file };
        }

        if (op === 'stats') {
          const stats = computeStats();
          const lines = ['验收 KPI（最近 ' + stats.gates + ' 张单）'];
          lines.push('一次通过率：' + stats.firstPassRate + '%　强制结单率：' + stats.forceCloseRate + '%');
          lines.push('自动执行覆盖：' + stats.autoCoverage + '%　人工自证占比：' + stats.manualPassRate + '%　平均耗时：' + Math.round(stats.avgDurationMs / 1000) + 's');
          if (stats.recent.length) {
            lines.push('');
            lines.push('最近：');
            for (const row of stats.recent) {
              lines.push('- ' + row.at + '　' + row.title + '　' + row.pass + '/' + row.total + '　auto ' + row.autoCount + '　人工 ' + row.manualPass + (row.forceClosed ? '　强制结单' : ''));
            }
          }
          return { text: lines.join('\n'), session: sid };
        }

        if (op === 'history') {
          const rows = readHistory(sid, 20);
          if (rows.length === 0) return { text: '没有历史验收单。', session: sid };
          return {
            text: rows.map((row) => {
              const sum = summarize(row.gate);
              return row.archivedAt + '　' + (row.gate?.title || '') + '　' + sum.pass + '/' + sum.total + '　' + (row.gate?.status || '');
            }).join('\n'),
            session: sid,
          };
        }

        const gate = loadGate(sid);
        if (op === 'reset') {
          if (gate) archiveGate(sid, gate);
          if (gate) { gate.status = 'archived'; gate.updatedAt = nowIso(); saveGate(sid, gate); }
          return { text: '当前验收单已清空（历史保留）。', session: sid };
        }
        if (!gate) return { text: 'ERROR: 这个会话还没有验收单。先 accept_gate op=open 登记条目。', session: sid };

        if (op === 'status') return { text: renderStatus(gate, sid), session: sid };

        if (op === 'scope') {
          gate.impact = analyzeImpact(gate.cwd || cwd);
          gate.updatedAt = nowIso();
          saveGate(sid, gate);
          if (!gate.impact.ok) return { text: '影响面采集失败：' + gate.impact.reason + '\n\n' + renderStatus(gate, sid), session: sid };
          const lines = ['影响面：' + gate.impact.root];
          lines.push('改动文件 ' + gate.impact.files.length + ' 个：');
          for (const item of gate.impact.related) {
            lines.push('- ' + item.file + ' → ' + (item.tests.length ? item.tests.join('、') : '（无同名测试）'));
          }
          if (gate.impact.note) lines.push(gate.impact.note);
          lines.push('');
          lines.push('按上面的清单补回归条目：改动点的直接下游 + 找到的测试文件都应进验收单。');
          return { text: lines.join('\n'), session: sid };
        }

        if (op === 'add') {
          const rawItems = Array.isArray(args?.items) ? args.items : [];
          if (rawItems.length === 0) return { text: 'ERROR: add 需要 items。', session: sid };
          const issues = [];
          const warnings = [];
          for (const item of rawItems) {
            const verdict = inspectItem(item, { strictMode: cfg.strictMode, kind: gate.kind });
            issues.push(...verdict.errors);
            warnings.push(...verdict.warnings);
          }
          if (issues.length > 0) return { text: 'ERROR: 新条目被质量守门拒收：\n- ' + issues.join('\n- '), session: sid };
          for (const item of rawItems) {
            gate.items.push({
              id: (gate.items.reduce((max, i) => Math.max(max, Number(i.id) || 0), 0)) + 1,
              requirement: String(item.requirement || '').trim(),
              check: String(item.check || '').trim(),
              severity: normalizeSeverity(item.severity, gate.severity),
              auto: item.auto && typeof item.auto === 'object' ? item.auto : null,
              baseline: String(item.baseline || '').trim(),
              baselineAuto: null, evidence: '', evidenceAuto: null, evidenceSource: '',
              runs: [], verdict: 'pending', note: '', updatedAt: nowIso(),
            });
          }
          gate.updatedAt = nowIso();
          saveGate(sid, gate);
          return { text: '已追加 ' + rawItems.length + ' 条' + (warnings.length ? '（提醒：' + warnings.join('；') + '）' : '') + '。\n\n' + renderStatus(gate, sid), session: sid };
        }

        if (op === 'drop') {
          const idArg = String(args?.id ?? '').trim();
          const before = gate.items.length;
          gate.items = gate.items.filter((i) => String(i.id) !== idArg);
          if (gate.items.length === before) return { text: 'ERROR: 没有编号 ' + idArg + ' 的条目。', session: sid };
          gate.updatedAt = nowIso();
          saveGate(sid, gate);
          return { text: '已删除 #' + idArg + '。\n\n' + renderStatus(gate, sid), session: sid };
        }

        const idArg = String(args?.id ?? '').trim();
        const targets = idArg === 'all' ? gate.items : gate.items.filter((i) => String(i.id) === idArg);

        if (op === 'baseline') {
          if (targets.length === 0) return { text: 'ERROR: 没有编号 ' + idArg + ' 的条目。可用：' + gate.items.map((i) => i.id).join(', '), session: sid };
          const text = String(args?.baseline || args?.evidence || '').trim();
          const autoTargets = targets.filter((i) => hasAuto(i));
          if (!text && autoTargets.length > 0) {
            const results = await runItems(gate, autoTargets, 'baseline');
            saveGate(sid, gate);
            return {
              text: '已用 auto 采集基线：\n' + results.map((r) => '- #' + r.id + ' ' + (r.ok ? 'PASS' : 'FAIL') + '　' + (r.reason || '')).join('\n') + '\n\n' + renderStatus(gate, sid),
              session: sid,
            };
          }
          if (!text) return { text: 'ERROR: baseline 需要现象文本（或给条目配 auto 让我自己跑）。', session: sid };
          for (const item of targets) {
            item.baseline = text.slice(0, 2000);
            item.updatedAt = nowIso();
          }
          gate.updatedAt = nowIso();
          saveGate(sid, gate);
          return { text: '已记基线。\n' + renderStatus(gate, sid), session: sid };
        }

        if (op === 'note') {
          const text = String(args?.note || '').trim();
          if (!text) return { text: 'ERROR: note 需要内容。', session: sid };
          if (targets.length === 0) return { text: 'ERROR: 没有编号 ' + idArg + ' 的条目。', session: sid };
          for (const item of targets) { item.note = text.slice(0, 2000); item.updatedAt = nowIso(); }
          gate.updatedAt = nowIso();
          saveGate(sid, gate);
          return { text: '已记备注。\n' + renderStatus(gate, sid), session: sid };
        }

        if (op === 'verify') {
          if (targets.length === 0) return { text: 'ERROR: 没有编号 ' + idArg + ' 的条目。可用：' + gate.items.map((i) => i.id).join(', '), session: sid };
          const verdict = args?.verdict === 'pass' ? 'pass' : args?.verdict === 'fail' ? 'fail' : null;
          if (!verdict) return { text: 'ERROR: verify 需要 verdict=pass 或 fail。', session: sid };
          const evidence = String(args?.evidence || '').trim();
          if (verdict === 'pass') {
            const autoOnly = targets.filter((i) => hasAuto(i));
            if (autoOnly.length > 0 && !cfg.allowManualPass) {
              return {
                text: 'ERROR: #' + autoOnly.map((i) => i.id).join(', #') + ' 配了 auto，不接受人工 pass。'
                  + '改用 accept_run（插件实跑，产出 exit code + 哈希）。真需要人工判，把配置 allowManualPass 打开。',
                session: sid,
              };
            }
            if (cfg.strictPass && !evidence) {
              return { text: 'ERROR: pass 必须带 evidence（真跑出来的输出/现象）。', session: sid };
            }
          }
          for (const item of targets) {
            item.verdict = verdict;
            if (evidence) item.evidence = evidence.slice(0, 4000);
            item.evidenceSource = 'manual';
            item.updatedAt = nowIso();
            if (verdict === 'fail' && !item.note) item.note = evidence.slice(0, 400);
          }
          gate.updatedAt = nowIso();
          saveGate(sid, gate);
          const closed = verdict === 'pass' ? maybeClose(gate, sid) : false;
          const sum = summarize(gate);
          const head = gate.status === 'passed'
            ? '全部条目通过，验收单已关闭，报告与 KPI 已落盘。'
            : '已更新。还有 ' + (sum.total - sum.pass) + ' 项没过' + (closed ? '' : '，继续修，别宣布完成') + '。';
          return { text: head + '\n\n' + renderStatus(gate, sid), session: sid };
        }

        if (op === 'report') {
          const sum = summarize(gate);
          const force = args?.force === true;
          if (sum.total === 0) return { text: 'ERROR: 空验收单出不了报告。', session: sid };
          if (sum.pass < sum.total && gate.status === 'open' && !force) {
            return { text: 'ERROR: 还有 ' + (sum.total - sum.pass) + ' 项没验完，报告不出。（确要先出，force=true）', session: sid };
          }
          const files = writeReports(gate);
          return { text: '已写入：\n- ' + files.md + '\n- ' + files.json + '\n- ' + files.html + '\n\n' + buildMarkdown(gate), session: sid, file: files.md };
        }

        if (op === 'close') {
          const sum = summarize(gate);
          const force = args?.force === true;
          if (sum.total === 0) return { text: 'ERROR: 空验收单不能结单。', session: sid };
          if (sum.p0pending > 0 && !force) {
            return { text: 'ERROR: 还有 ' + sum.p0pending + ' 条 P0 没过，不许结单。', session: sid };
          }
          if (sum.pass < sum.total && !force) {
            return { text: 'ERROR: 还有 ' + (sum.total - sum.pass) + ' 项没过。要么继续修，要么 force=true 并写 reason（会计入 KPI 强制结单率）。', session: sid };
          }
          gate.status = force && sum.pass < sum.total ? 'abandoned' : 'passed';
          gate.closedAt = nowIso();
          gate.closeReason = String(args?.reason || args?.note || '').trim();
          gate.updatedAt = nowIso();
          saveGate(sid, gate);
          if (cfg.kpi) recordKpi(gate);
          if (cfg.writeReportOnClose) { try { writeReports(gate); } catch { /* ignore */ } }
          return { text: '验收单 ' + gate.id + ' 已结单（' + gate.status + '）。', session: sid };
        }

        return { text: 'ERROR: 不认识的 op：' + op, session: sid };
      } catch (error) {
        return { text: 'ERROR: accept_gate 内部异常：' + String((error && error.message) || error) };
      }
    },
  });
}

export default { name, inject, apply };
