// 影响面分析：改动文件 → 回归候选
// 只做客观采集（git 状态 + 同目录测试文件探测），不做"智能推断"式猜测。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import nodePath from 'node:path';

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 20000, windowsHide: true });
}

const TEST_PATTERNS = [
  (base) => base + '.test', (base) => base + '.spec',
  (base) => 'test_' + base, (base) => base + '_test',
];

function testCandidatesFor(file) {
  const dir = nodePath.dirname(file);
  const ext = nodePath.extname(file);
  const base = nodePath.basename(file, ext);
  const out = new Set();
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const wanted = new Set(TEST_PATTERNS.map((fn) => fn(base)).map((n) => n.toLowerCase()));
  for (const entry of entries) {
    const entryBase = nodePath.basename(entry, nodePath.extname(entry)).toLowerCase();
    if (wanted.has(entryBase)) out.add(nodePath.join(dir, entry));
  }
  const testsDir = nodePath.join(dir, '__tests__');
  if (fs.existsSync(testsDir)) {
    try {
      for (const entry of fs.readdirSync(testsDir)) {
        if (entry.toLowerCase().includes(base.toLowerCase())) out.add(nodePath.join(testsDir, entry));
      }
    } catch { /* ignore */ }
  }
  return [...out];
}

export function analyzeImpact(cwd) {
  const dir = String(cwd || process.cwd());
  const inside = git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || !String(inside.stdout || '').includes('true')) {
    return { ok: false, reason: '不是 git 仓库（或 git 不可用）：' + String(inside.stderr || '').trim().slice(0, 160), cwd: dir };
  }
  const root = String(git(dir, ['rev-parse', '--show-toplevel']).stdout || '').trim();
  const porcelain = String(git(dir, ['status', '--porcelain']).stdout || '');
  const diffHead = String(git(dir, ['diff', '--name-only', 'HEAD']).stdout || '');
  const staged = String(git(dir, ['diff', '--name-only', '--cached']).stdout || '');
  const files = new Set();
  for (const line of porcelain.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const pathPart = trimmed.replace(/^\?\?\s+/, '').replace(/^[A-Z?]{1,2}\s+/, '');
    const renamed = pathPart.split(' -> ');
    files.add(renamed[renamed.length - 1]);
  }
  for (const line of (diffHead + '\n' + staged).split('\n')) {
    const trimmed = line.trim();
    if (trimmed) files.add(trimmed);
  }
  const list = [...files].filter((f) => f && !f.startsWith('ACCEPTANCE'));
  const related = [];
  for (const file of list.slice(0, 60)) {
    related.push({ file, tests: testCandidatesFor(require0(file, root)) });
  }
  return {
    ok: true,
    root,
    cwd: dir,
    files: list,
    related,
    scannedAt: new Date().toISOString(),
    note: list.length === 0 ? '工作区干净：没有未提交改动，回归范围按"用户报的入口 + 相邻主流程"自定' : '',
  };
}

function require0(file, root) {
  return nodePath.isAbsolute(file) ? file : nodePath.join(root || process.cwd(), file);
}
