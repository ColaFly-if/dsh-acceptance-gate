// 报告：ACCEPTANCE.md（人看）+ acceptance.json（机读）+ 可选 JUnit 风格摘要
import { summarize } from './store.js';
import { scrubText, scrubDeep } from './secrets.js';
import { cap } from './checks.js';

function cell(value) {
  return String(scrubText(value == null ? '' : value))
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>')
    .slice(0, 600);
}

function ms(value) {
  const n = Number(value) || 0;
  return n >= 1000 ? (n / 1000).toFixed(1) + 's' : n + 'ms';
}

export function buildMarkdown(gate) {
  const sum = summarize(gate);
  const lines = [];
  lines.push('# 验收报告：' + gate.title);
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---|');
  lines.push('| 单号 | ' + gate.id + ' |');
  lines.push('| 类型 | ' + (gate.kind === 'fix' ? '修复' : '新需求') + ' |');
  lines.push('| 最高严重级 | ' + gate.severity + ' |');
  lines.push('| 状态 | ' + gate.status + ' |');
  lines.push('| 进度 | ' + sum.pass + '/' + sum.total + ' 通过（fail ' + sum.fail + ' / pending ' + sum.pending + '） |');
  lines.push('| 自动执行覆盖 | ' + sum.auto + '/' + sum.total + ' 条有 auto（自动通过 ' + sum.autoPass + '，人工自证 ' + sum.manualPass + '） |');
  lines.push('| 创建 / 更新 | ' + gate.createdAt + ' / ' + gate.updatedAt + ' |');
  if (gate.closedAt) lines.push('| 结单 | ' + gate.closedAt + (gate.closeReason ? '（' + gate.closeReason + '）' : '') + ' |');
  lines.push('| 触发续跑次数 | ' + (gate.nudges || 0) + ' |');
  lines.push('| 工作目录 | ' + (gate.cwd || '-') + ' |');
  lines.push('');

  if (gate.impact && gate.impact.ok) {
    lines.push('## 改动面（影响面采集）');
    lines.push('');
    lines.push('仓库：' + gate.impact.root + '　采集时间：' + gate.impact.scannedAt);
    lines.push('');
    if (gate.impact.files.length === 0) {
      lines.push('- 工作区干净，无未提交改动。');
    } else {
      for (const item of gate.impact.related || []) {
        const tests = item.tests && item.tests.length ? item.tests.join('、') : '（未找到同名测试文件）';
        lines.push('- ' + item.file + ' → ' + tests);
      }
    }
    lines.push('');
  }

  lines.push('## 验收条目');
  lines.push('');
  lines.push('| # | 级别 | 需求 | 判定方式 | 修前基线 | 验收证据 | 来源 | 结论 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const item of gate.items) {
    const source = item.verdict === 'pass' ? (item.evidenceSource === 'auto' ? 'AUTO' : 'UNSIGNED(人工自证)') : '';
    lines.push('| ' + [item.id, item.severity, item.requirement, item.check, item.baseline, item.evidence, source, item.verdict].map(cell).join(' | ') + ' |');
  }
  lines.push('');

  const withRuns = gate.items.filter((i) => Array.isArray(i.runs) && i.runs.length > 0);
  if (withRuns.length > 0) {
    lines.push('## 执行明细（插件实跑）');
    lines.push('');
    for (const item of withRuns) {
      lines.push('### #' + item.id + ' ' + item.requirement);
      for (const run of item.runs) {
        const ev = run.evidence || {};
        const head = '- ' + run.at + '　' + (ev.kind || '?') + '　' + (run.ok ? 'PASS' : 'FAIL') + '　耗时 ' + ms(ev.durationMs);
        lines.push(head);
        lines.push('  - 目标：' + (ev.cmd || ev.url || ev.path || '-'));
        if (ev.exitCode !== undefined) lines.push('  - exit：' + ev.exitCode + (ev.timedOut ? '（超时）' : ''));
        if (ev.status !== undefined) lines.push('  - HTTP：' + ev.status);
        if (ev.hash) lines.push('  - hash：' + ev.hash.slice(0, 16) + '…');
        if (ev.stdoutTail) lines.push('  - stdout 尾：' + cap(ev.stdoutTail, 400).replace(/\n/g, ' ⏎ '));
        if (ev.stderrTail) lines.push('  - stderr 尾：' + cap(ev.stderrTail, 400).replace(/\n/g, ' ⏎ '));
        if (ev.bodyTail) lines.push('  - 响应体尾：' + cap(ev.bodyTail, 400).replace(/\n/g, ' ⏎ '));
        if (run.attempts > 1) lines.push('  - 尝试次数：' + run.attempts + (run.flaky ? '（FLAKY：重跑才过）' : ''));
        if (run.delta && run.delta !== 'no-baseline') lines.push('  - 与修前基线：' + (run.delta === 'unchanged' ? '输出完全一致' : '输出已变化'));
        if (Array.isArray(run.diagnose) && run.diagnose.length) lines.push('  - 诊断建议：' + run.diagnose.join('；'));
        if (run.reason) lines.push('  - 判定：' + run.reason);
      }
      lines.push('');
    }
  }

  lines.push('## 结论');
  lines.push('');
  if (sum.total === 0) lines.push('空验收单，不构成任何结论。');
  else if (sum.pass === sum.total) lines.push('全部 ' + sum.total + ' 条通过（其中自动执行 ' + sum.autoPass + ' 条，人工自证 ' + sum.manualPass + ' 条）。');
  else lines.push('未通过：' + (sum.total - sum.pass) + ' 条。不许当作已完成。');
  if (sum.manualPass > 0) lines.push('');
  if (sum.manualPass > 0) lines.push('> 注意：人工自证条目（UNSIGNED）没有插件产生的证据，可信度低于 AUTO，复盘时优先补 auto。');
  lines.push('');
  return scrubText(lines.join('\n'));
}

export function buildHtml(gate) {
  const sum = summarize(gate);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = gate.items.map((item) => {
    const source = item.verdict === 'pass' ? (item.evidenceSource === 'auto' ? 'AUTO' : 'UNSIGNED') : '';
    return '<tr class="' + esc(item.verdict) + '"><td>' + esc(item.id) + '</td><td>' + esc(item.severity) + '</td><td>'
      + esc(item.requirement) + '</td><td>' + esc(item.check) + '</td><td>' + esc(item.baseline) + '</td><td>'
      + esc(item.evidence) + '</td><td>' + esc(source) + '</td><td>' + esc(item.verdict) + '</td></tr>';
  }).join('\n');
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>验收报告 ' + esc(gate.title) + '</title>'
    + '<style>body{font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;margin:32px;color:#1f2328}'
    + 'h1{font-size:22px}table{border-collapse:collapse;width:100%;margin-top:12px}'
    + 'th,td{border:1px solid #d0d7de;padding:6px 8px;text-align:left;vertical-align:top}'
    + 'th{background:#f6f8fa}tr.pass td:nth-child(8){color:#1a7f37;font-weight:600}'
    + 'tr.fail td:nth-child(8){color:#cf222e;font-weight:600}tr.pending td:nth-child(8){color:#9a6700}'
    + '.meta{color:#57606a}</style></head><body>'
    + '<h1>验收报告：' + esc(gate.title) + '</h1>'
    + '<p class="meta">' + esc(gate.id) + '　' + esc(gate.kind === 'fix' ? '修复' : '新需求') + '　最高级 ' + esc(gate.severity)
    + '　状态 ' + esc(gate.status) + '　进度 ' + sum.pass + '/' + sum.total
    + '　auto ' + sum.autoPass + '　人工自证 ' + sum.manualPass + '　闸门触发 ' + (gate.nudges || 0) + ' 次</p>'
    + '<table><thead><tr><th>#</th><th>级别</th><th>需求</th><th>判定方式</th><th>修前基线</th><th>验收证据</th><th>来源</th><th>结论</th></tr></thead><tbody>'
    + rows + '</tbody></table>'
    + '<p class="meta">由 dsh-acceptance-gate 生成 · ' + esc(new Date().toISOString()) + '</p></body></html>';
  return scrubText(html);
}

export function buildJson(gate) {
  const sum = summarize(gate);
  return scrubDeep({
    schema: 'dsh-acceptance-gate/report@1',
    gate: {
      id: gate.id, title: gate.title, kind: gate.kind, severity: gate.severity,
      status: gate.status, createdAt: gate.createdAt, updatedAt: gate.updatedAt,
      closedAt: gate.closedAt || null, closeReason: gate.closeReason || null,
      cwd: gate.cwd, nudges: gate.nudges || 0,
    },
    summary: sum,
    impact: gate.impact || null,
    items: gate.items.map((item) => ({
      id: item.id, severity: item.severity, requirement: item.requirement, check: item.check,
      auto: item.auto || null, baseline: item.baseline, baselineAuto: item.baselineAuto,
      evidence: item.evidence, evidenceSource: item.evidenceSource || null,
      flaky: item.flaky === true, delta: item.delta || null,
      verdict: item.verdict, runs: item.runs || [], note: item.note,
    })),
  });
}
