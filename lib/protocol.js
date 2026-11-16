// 提示词正文：验收协议 + 每轮实时状态
// 这份文字每一轮都进 system prompt；状态块现读文件，模型随时看得见欠账。

export const PROTOCOL_BODY = `## 验收闭环（强制）

**适用范围**：修 bug、改功能、加新需求、改配置/脚本/提示词——凡是改完要说"好了"的活。
**不适用**：纯闲聊、答疑、查资料、只给建议不动手。

### 两轨测试（先选轨，再谈通过）
- **代码轨**：auto.kind = "shell" / "http" / "file"。证明逻辑、接口、文件内容对不对。
- **交互轨**：auto.kind = "ui"。真跑人流程——打开页面、点按钮、输入文字、断言界面上真的出现了预期结果；必须给 artifact（截图/录像/日志路径），否则人眼无法复核。
- **有交互就两轨都做**：改动涉及页面、按钮、表单、终端输入、GUI 弹窗，代码轨 + 交互轨缺一不可。
- **没交互只做代码轨**：纯后端、纯逻辑、纯配置，交互轨可以省。
- 登记时用 interactive: true|false 申报；申报 true 却没交交互轨，验收单会被直接拒收。
- 反例：只测接口返回 200 就宣布"页面好了"——接口通过不证明按钮能点、能显示。

### 五步
1. **开工登记** \`accept_gate\` op=open
   - \`requirement\`：用户能观察到的结果，人话，不写实现手段。
   - \`check\`：人看的判定方式；同时给 \`auto\` 让插件真跑：
     { kind:"shell", cmd:"node test.mjs", expectExit:0, expectStdout:"RECEIVED" }
     { kind:"http", url:"http://127.0.0.1:PORT/api/x", expectStatus:200, expectBody:"ok" }
     { kind:"file", path:"dist/x.js", expectMatch:"/export/function/" }
   - \`severity\`：P0 数据错/不可用，P1 主流程坏，P2 次要，P3 体验。
2. **修前基线**：有 auto 的直接 \`accept_run mode=baseline\`（插件跑，记 hash/exit/耗时）；
   没 auto 的 \`accept_gate\` op=baseline 贴真实现象。复现不了就写"无法复现+原因+换的入口"，不许跳过。
3. **改完跑同一条**：\`accept_run\`（默认 mode=verify）。证据必须由插件产生——exit code、输出、哈希、耗时。
   - 会自动比对 \`Δ基线\`：输出与修前完全一致（Δ基线未变）而这项是"修复回执"，高度可疑，先怀疑没修好。
   - 失败会自动重跑一次：重跑才过 = \`FLAKY\`，不算稳定通过，必须查偶发原因（时序/并发/环境）。
4. **结案**：\`accept_run\` 自动给出 pass/fail；没 auto 的用 \`accept_gate\` op=verify 人工结。
   有 auto 的条目**不接受**人工 pass（除非 \`allowManualPass\`），人工证据一律标 UNSIGNED。
5. **清零才收尾**：全部 pass（P0 必须全过）才允许说"已修复/已完成"。未清零会被闸门拽回来继续。

### 会被当场拒收的写法
- requirement 写"功能正常""应该好了""测试一下"——不可判定。
- check 里没有命令/URL/文件路径/期望值，又没给 auto——跑不出来的判据不是判据。
- pass 不带 evidence；有 auto 的条目人工 pass；空验收单；未清零就 \`report\` / \`close\`。

### 硬规矩
- 用户报的原始现象必须在同一入口、同一操作路径上被直接对上；只验改动点不算回归。
- 改完要跑 \`accept_gate\` op=scope 看影响面：改动文件的下游与同名测试一起进回归范围。
- 证据分级：AUTO（插件实跑，带哈希）> UNSIGNED（人工自证）。报告里会标出来，别拿 UNSIGNED 当铁证。
- 本约束优先于"尽快给出结论"的偏好。`

const MARK = { pass: 'PASS', fail: 'FAIL', pending: 'TODO' };

function clip(text, max) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function stateBlock(gate, sessionKey) {
  if (!gate) {
    return [
      '### 当前验收单',
      '无。本轮只要涉及修复或新需求，第一件事就是 \`accept_gate\` op=open 登记条目，再动手。',
    ].join('\n');
  }
  const items = gate.items || [];
  const total = items.length;
  const pass = items.filter((i) => i.verdict === 'pass').length;
  const autoCount = items.filter((i) => i.auto).length;
  const autoPass = items.filter((i) => i.verdict === 'pass' && i.evidenceSource === 'auto').length;
  const manualPass = items.filter((i) => i.verdict === 'pass' && i.evidenceSource !== 'auto').length;
  const uiCount = items.filter((i) => String(i?.auto?.kind || '').toLowerCase() === 'ui').length;
  const uiPass = items.filter((i) => String(i?.auto?.kind || '').toLowerCase() === 'ui' && i.verdict === 'pass').length;
  const lines = [];
  lines.push('### 当前验收单');
  lines.push('[' + gate.status + '] ' + gate.title + '（' + (gate.kind === 'fix' ? '修复' : '新需求') + '，' + gate.severity + '）'
    + pass + '/' + total + ' 通过 · auto ' + autoPass + '/' + autoCount + ' · 人工自证 ' + manualPass + ' · 交互轨 ' + uiPass + '/' + uiCount + ' · 会话 ' + sessionKey);
  if (gate.nudges) lines.push('（本单已被验收闸门拽回 ' + gate.nudges + ' 次）');
  for (const item of items) {
    const tag = item.auto ? 'auto' : 'manual';
    const tail = item.verdict === 'pass'
      ? (item.evidenceSource === 'auto'
        ? ' — AUTO 证据：' + clip(item.evidence, 140)
        : ' — UNSIGNED 人工自证：' + clip(item.evidence, 120) + '（补 auto 才算铁证）')
      : item.verdict === 'fail'
        ? ' — 未通过：' + clip(item.evidence || item.note || '待修', 140)
        : ' — ' + (item.runs && item.runs.length ? '跑过但还没结案' : '待跑') + '：' + clip(item.check || '(缺 check)', 110);
    lines.push('- [' + (MARK[item.verdict] || 'TODO') + '] #' + item.id + ' ' + item.severity + ' ' + clip(item.requirement, 110) + ' (' + tag + ')' + tail);
  }
  if (gate.impact && gate.impact.ok && Array.isArray(gate.impact.files) && gate.impact.files.length > 0) {
    lines.push('- 改动面：' + gate.impact.files.slice(0, 6).join('、') + (gate.impact.files.length > 6 ? ' 等 ' + gate.impact.files.length + ' 个文件' : ''));
  }
  const left = total - pass;
  if (gate.status === 'open' && total === 0) lines.push('**验收单是空的：条目为 0 不允许宣布完成。**');
  else if (gate.status === 'open' && left > 0) lines.push('**还差 ' + left + ' 项没过 → 不许收尾：先 accept_run / 跑 check，再 op=verify 贴证据。**');
  return lines.join('\n');
}

export { clip };
