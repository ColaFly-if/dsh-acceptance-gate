// 自测：把插件的每条硬约束都跑一遍，不靠肉眼。
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import nodePath from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const tmpHome = nodePath.join(os.tmpdir(), 'ag-smoke-' + Date.now());
fs.mkdirSync(tmpHome, { recursive: true });
process.env.USERPROFILE = tmpHome;
process.env.HOME = tmpHome;

const workDir = nodePath.join(tmpHome, 'work');
fs.mkdirSync(workDir, { recursive: true });
fs.writeFileSync(nodePath.join(workDir, 'probe.mjs'),
  "import fs from 'node:fs';\n"
  + "if (fs.existsSync('marker')) { console.log('RECEIVED ok'); process.exit(0); }\n"
  + "console.log('NO_MARKER'); process.exit(1);\n", 'utf8');

fs.writeFileSync(nodePath.join(workDir, 'flaky.mjs'),
  "import fs from 'node:fs';\n"
  + "const f = 'flaky-count';\n"
  + "const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0;\n"
  + "fs.writeFileSync(f, String(n + 1));\n"
  + "if (n === 0) { console.log('FLAKY_ATTEMPT_1_FAIL'); process.exit(1); }\n"
  + "console.log('FLAKY_ATTEMPT_OK'); process.exit(0);\n", 'utf8');

// 与 cwd 无关：从脚本位置推插件根
const PLUGIN_ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..');
const libPath = pathToFileURL(nodePath.join(PLUGIN_ROOT, 'lib', 'index.js')).href;
const mod = await import(libPath);

// ── 本地 http 服务，供 http 检查断言
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/ok')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return; }
  res.writeHead(500); res.end('boom');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

function makeCtx(config) {
  const tools = new Map();
  let sectionOpts = null;
  const listeners = new Map();
  const ctx = {
    systemPrompt: { section(opts) { sectionOpts = opts; return () => {}; } },
    tools: { register(def) { tools.set(def.name, def); } },
    on(event, handler) { listeners.set(event, handler); return () => listeners.delete(event); },
    effect(fn) { return fn(); },
    logger: { warn() {}, debug() {} },
  };
  mod.apply(ctx, config || {});
  return { tools, listeners, sectionText: (sid) => sectionOpts.text({ agent: { session: { id: sid, header: { cwd: workDir } } } }) };
}

const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail: detail === undefined ? '' : String(detail).slice(0, 400) });
}

const { tools, listeners, sectionText } = makeCtx({ watchdogCooldownMs: 0, watchdogDelayMs: 0, watchdogMax: 2 });
const gate = tools.get('accept_gate');
const run = tools.get('accept_run');
const exec = (sid) => ({ agent: { session: { id: sid, header: { cwd: workDir } } } });

// 1. 无单时提示
check('空会话提示登记', sectionText('s1').includes('当前验收单') && sectionText('s1').includes('accept_gate'));

// 2. 质量守门：空话拒收
const bad = await gate.execute({ op: 'open', title: '改一下', kind: 'fix', items: [{ requirement: '功能正常', check: '测试一下' }] }, exec('s1'));
check('空话条目被拒', bad.text.startsWith('ERROR') && bad.text.includes('拒收'), bad.text.split('\n')[0]);
check('拒收时给出边界提示', bad.text.includes('边界值'), bad.text.includes('异常路径'));

// 3. 质量守门：无 auto 且 check 无可执行成分 → 拒收
const bad2 = await gate.execute({ op: 'open', title: 'x', items: [{ requirement: '用户点按钮后进入详情页', check: '看起来正常就行' }] }, exec('s1'));
check('不可执行 check 被拒', bad2.text.startsWith('ERROR'), bad2.text.split('\n')[0]);

// 4. 正常登记（shell + http + file 三种 auto）
const opened = await gate.execute({
  op: 'open', title: '修复收不到消息', kind: 'fix', severity: 'P0',
  items: [
    { requirement: '用户发消息后立刻收到 RECEIVED 回执', severity: 'P0',
      check: 'node probe.mjs 输出 RECEIVED', auto: { kind: 'shell', cmd: 'node probe.mjs', expectExit: 0, expectStdout: 'RECEIVED' } },
    { requirement: '健康接口返回 ok', severity: 'P1',
      check: 'GET /ok 返回 200 且 body 含 ok', auto: { kind: 'http', url: 'http://127.0.0.1:' + port + '/ok', expectStatus: 200, expectBody: 'ok' } },
    { requirement: '写出 marker.txt 且内容含 hello', severity: 'P2',
      check: 'marker.txt 内容包含 hello', auto: { kind: 'file', path: 'marker.txt', expectMatch: 'hello' } },
  ],
}, exec('s1'));
check('正常登记成功', opened.text.includes('已登记验收单'), opened.text.split('\n')[0]);
check('登记时采集影响面', opened.text.includes('改动面') || opened.text.includes('验收单 '), opened.text.split('\n')[1]);

// 4b. 两轨：涉及交互却只有代码轨 → 拒收；给交互轨（ui + artifact）→ 通过
fs.writeFileSync(nodePath.join(workDir, 'shot.png'), 'fake-png-bytes', 'utf8');
const noUi = await gate.execute({
  op: 'open', title: '页面按钮修复', kind: 'feature', interactive: true,
  items: [{ requirement: '点发送按钮后页面出现回复', check: '跑接口脚本断言 200', auto: { kind: 'shell', cmd: 'node -e "process.exit(0)"', expectExit: 0 } }],
}, exec('s2'));
check('涉及交互却没交互轨被拒', noUi.text.startsWith('ERROR') && noUi.text.includes('交互轨'), noUi.text.split('\n')[0]);

const withUi = await gate.execute({
  op: 'open', title: '页面按钮修复', kind: 'feature', interactive: true,
  items: [
    { requirement: '点发送后页面出现回复并留下截图', check: '跑交互脚本输出 LIVE_OK 且产物存在',
      auto: { kind: 'ui', cmd: 'node -e "console.log(\'LIVE_OK\')"', expectStdout: 'LIVE_OK', artifact: 'shot.png' } },
    { requirement: '健康接口返回 ok', severity: 'P1', check: 'GET /ok 200 且 body 含 ok',
      auto: { kind: 'http', url: 'http://127.0.0.1:' + port + '/ok', expectStatus: 200, expectBody: 'ok' } },
  ],
}, exec('s2'));
check('交互轨登记成功', withUi.text.includes('已登记验收单'), withUi.text.split('\n')[0]);
check('状态里显示两轨', withUi.text.includes('轨道：代码') && withUi.text.includes('交互 0/1'), withUi.text.split('\n').find((l) => l.includes('轨道：')) || '');

const uiNoArtifact = await gate.execute({ op: 'open', title: 'x2', interactive: true,
  items: [{ requirement: '点按钮出现回复', check: '跑交互脚本', auto: { kind: 'ui', cmd: 'node -e "0"' } }] }, exec('s3'));
check('交互轨缺 artifact 被拒', uiNoArtifact.text.startsWith('ERROR') && uiNoArtifact.text.includes('artifact'), uiNoArtifact.text.split('\n')[0]);

// 5. 基线（此时应 shell fail / http pass / file fail）
const base1 = await run.execute({ mode: 'baseline' }, exec('s1'));
check('基线采集执行了 auto', base1.text.includes('基线采集完成'), base1.text.split('\n')[0]);
check('基线里 shell 因缺 marker 失败', base1.text.includes('NO_MARKER') || base1.text.includes('exit=1'), base1.text.split('\n').slice(1, 3).join(' | '));

// 6. 有 auto 的条目拒绝人工 pass
const manual = await gate.execute({ op: 'verify', id: '1', verdict: 'pass', evidence: '我看着好了' }, exec('s1'));
check('auto 条目拒绝人工 pass', manual.text.startsWith('ERROR') && manual.text.includes('accept_run'), manual.text.split('\n')[0]);

// 7. 未清零不许 close / report
const early = await gate.execute({ op: 'close' }, exec('s1'));
check('未清零拒绝结单', early.text.startsWith('ERROR'), early.text.split('\n')[0]);
const earlyReport = await gate.execute({ op: 'report' }, exec('s1'));
check('未清零拒绝出报告', earlyReport.text.startsWith('ERROR'), earlyReport.text.split('\n')[0]);

// 8. 修好了：造 marker 与 marker.txt，再跑 verify
fs.writeFileSync(nodePath.join(workDir, 'marker'), '1', 'utf8');
fs.writeFileSync(nodePath.join(workDir, 'marker.txt'), 'hello world', 'utf8');
const verified = await run.execute({ mode: 'verify' }, exec('s1'));
check('auto 执行后全通过', verified.text.includes('全部条目通过'), verified.text.split('\n').slice(0, 4).join(' | '));
check('证据带哈希', verified.text.includes('hash='), verified.text.split('\n').find((l) => l.includes('hash=')) || '');
const st1 = (await gate.execute({ op: 'status' }, exec('s1'))).text;
check('结单后状态 passed', st1.includes('｜passed｜') && st1.includes('全部条目已通过'), st1.split('\n')[0]);

// 9. 报告落盘
const report = await gate.execute({ op: 'report' }, exec('s1'));
const mdPath = nodePath.join(workDir, 'ACCEPTANCE.md');
const jsonPath = nodePath.join(workDir, 'acceptance.json');
check('ACCEPTANCE.md 落盘', fs.existsSync(mdPath));
check('acceptance.json 落盘', fs.existsSync(jsonPath));
if (!fs.existsSync(mdPath) || !fs.existsSync(jsonPath)) {
  console.log('DEBUG report text:\n' + report.text);
  console.log('DEBUG verify text:\n' + verified.text);
}
const md = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';
const json = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : {};
check('报告含 AUTO 来源标记', md.includes('AUTO'));
check('报告含执行明细与哈希', md.includes('执行明细') && md.includes('hash'));
check('HTML 报告落盘', fs.existsSync(nodePath.join(workDir, 'ACCEPTANCE.html')));
check('JSON 报告结构完整', json.schema === 'dsh-acceptance-gate/report@1' && json.items.length === 3 && json.summary.pass === 3);
check('verify 输出了基线对比', verified.text.includes('Δ基线已变'), verified.text.split('\n')[1]);
check('报告记录了基线变化', md.includes('输出已变化'));

// 10. KPI
const stats = await gate.execute({ op: 'stats' }, exec('s1'));
check('KPI 有记录', stats.text.includes('验收 KPI') && stats.text.includes('一次通过率'), stats.text.split('\n')[1]);

// 10.5 flake 识别：首跑失败、重跑通过 → 标 FLAKY 且不算通过
const sid4 = 's4';
await gate.execute({ op: 'open', title: 'flake 测试', items: [
  { requirement: 'flaky 脚本稳定 exit 0', check: 'node flaky.mjs', auto: { kind: 'shell', cmd: 'node flaky.mjs', expectExit: 0, expectStdout: 'FLAKY_ATTEMPT_OK' } },
] }, exec(sid4));
const flakyOut = await run.execute({ mode: 'verify' }, exec(sid4));
check('flake 被识别', flakyOut.text.includes('FLAKY'), flakyOut.text.split('\n')[1] || '');
const flakyStatus = await gate.execute({ op: 'status' }, exec(sid4));
check('flake 不算通过', flakyStatus.text.includes('｜open｜') && flakyStatus.text.includes('还没验完'), flakyStatus.text.split('\n')[0]);

// 11. 回合闸门：开单 → 模拟 running/idle → 应被 followup 拽回
const sid2 = 's2';
await gate.execute({ op: 'open', title: '闸门测试', items: [
  { requirement: 'probe 输出 RECEIVED', check: 'node probe.mjs', auto: { kind: 'shell', cmd: 'node probe.mjs', expectExit: 0, expectStdout: 'RECEIVED' } },
  { requirement: 'marker.txt 存在', check: 'ls marker.txt', auto: { kind: 'file', path: 'marker.txt' } },
] }, exec(sid2));
fs.unlinkSync(nodePath.join(workDir, 'marker'));  // 让第一项回到待修状态

const sent = [];
let fakeSeq = 10;
const fakeAgent = {
  id: sid2,
  status: 'idle',
  session: {
    id: sid2,
    header: { cwd: workDir },
    snapshotEvents: () => ([
      { seq: 1, type: 'user/message', data: { source: { kind: 'user' } } },
      { seq: fakeSeq, type: 'turn/end', time: Date.now(), data: { reason: { kind: 'completed' } } },
    ]),
  },
  inbox: { hasPending: () => false },
  followup(message) { sent.push(message); },
};
const handler = listeners.get('agent/status');
check('注册了 agent/status 监听', typeof handler === 'function');
handler({ status: 'running', agent: fakeAgent });
await new Promise((r) => setTimeout(r, 30));
handler({ status: 'idle', agent: fakeAgent });
await new Promise((r) => setTimeout(r, 120));
check('闸门拽回一次', sent.length === 1, 'sent=' + sent.length);
check('拽回消息含欠账明细', sent[0] && sent[0].content[0].text.includes('验收闸门') && sent[0].content[0].text.includes('#1'), sent[0] ? sent[0].content[0].text.split('\n')[1] : '');
check('拽回消息标了 plugin 来源', sent[0] && sent[0].source && sent[0].source.kind === 'dsh-acceptance-gate');

// 12. 闸门次数上限（config watchdogMax=2）
handler({ status: 'idle', agent: fakeAgent });
await new Promise((r) => setTimeout(r, 60));
handler({ status: 'idle', agent: fakeAgent });
await new Promise((r) => setTimeout(r, 60));
handler({ status: 'idle', agent: fakeAgent });
await new Promise((r) => setTimeout(r, 60));
check('闸门有次数上限', sent.length <= 2, 'sent=' + sent.length);

// 13. 闸门不动已清零的单
const sid3 = 's3';
await gate.execute({ op: 'open', title: '已通过', items: [
  { requirement: 'marker.txt 存在且含 hello', check: 'file', auto: { kind: 'file', path: 'marker.txt', expectMatch: 'hello' } },
] }, exec(sid3));
await run.execute({ mode: 'verify' }, exec(sid3));
const sent3 = [];
const agent3 = { ...fakeAgent, id: sid3, session: { ...fakeAgent.session, id: sid3 }, followup: (m) => sent3.push(m) };
handler({ status: 'running', agent: agent3 });
handler({ status: 'idle', agent: agent3 });
await new Promise((r) => setTimeout(r, 80));
check('已结单不拽回', sent3.length === 0, 'sent=' + sent3.length);

server.close();
const failed = results.filter((r) => !r.ok);
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name.padEnd(width) + '  ' + r.detail);
}
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
if (failed.length) { console.log('FAILED: ' + failed.map((f) => f.name).join(' | ')); process.exit(1); }
