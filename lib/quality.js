// 用例质量守门：把"应该能正常用"这类不可判定条目挡在门外。
// 依据：测试工程的等价类/边界值/判定表思路——每条 requirement 必须能落地成一个判据。

const EMPTY_WORDS = [
  '正常', '能用', '可用', '没问题', '无问题', '应该', '差不多', '看起来', '基本',
  '功能正常', '运行正常', '测试一下', '验证一下', '检查一下', '看看',
];

const EXECUTABLE_HINTS = [
  /\b(npm|pnpm|yarn|node|python|pytest|jest|vitest|go test|cargo|make|curl|bash|sh|pwsh)\b/i,
  /\/(api|v\d)\/[\w\-./{}$?=&%:]+/i,
  /https?:\/\//i,
  /[A-Za-z0-9_\-]+\.(mjs|cjs|js|ts|tsx|jsx|py|sh|ps1|json|md|yml|yaml|sql)\b/i,
  /(exit|退出码|返回码|状态码|HTTP|status)\s*[:=]?\s*\d{3}/i,
  /(包含|匹配|等于|输出|打印|返回|断言|期望|assert|expect|contains|equals|match)/i,
  /[<>]=?\s*\d+|==\s*\S+/,
];

const BOUNDARY_HINTS = [
  '空值 / null / undefined / 空字符串',
  '边界值：0、1、最大长度、最大并发',
  '异常路径：超时、断网、权限不足、重复提交',
  '幂等与重试：同一次请求发两遍结果是否一致',
  '相邻功能回归：改动点上下游各一条主流程',
  '数据一致性：写后读、跨表/跨服务对账',
];

function onlyEmptyWords(text) {
  const raw = String(text || '').trim();
  if (raw.length < 4) return true;
  const stripped = EMPTY_WORDS.reduce((acc, word) => acc.split(word).join(''), raw).replace(/[\s，。,.、；;：:（）()!！?？]/g, '');
  return stripped.length <= 2;
}

function hasExecutable(check) {
  const text = String(check || '');
  if (text.trim().length < 6) return false;
  return EXECUTABLE_HINTS.some((rx) => rx.test(text));
}

/**
 * 校验一条待登记条目。
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function inspectItem(item, options = {}) {
  const strict = options.strictMode !== false;
  const errors = [];
  const warnings = [];
  const requirement = String(item?.requirement || '').trim();
  const check = String(item?.check || '').trim();
  const auto = item?.auto && typeof item.auto === 'object' ? item.auto : null;

  if (requirement.length < 6) errors.push('requirement 太短（<6 字）：写清楚"改成什么样"，不是"改一下"');
  if (onlyEmptyWords(requirement)) errors.push('requirement 全是空话（正常/能用/没问题之类），无法判定：换成用户可观察的结果');

  if (!check && !auto) errors.push('缺 check：必须写清判定方式，或给 auto 让它可自动执行');
  if (check && onlyEmptyWords(check)) errors.push('check 全是空话，跑不出来：换成命令/URL/文件路径/期望值');
  if (check && !auto && !hasExecutable(check)) {
    const line = 'check 里没有可执行成分（命令、URL、文件路径、期望值都没有）：' + JSON.stringify(check).slice(0, 80);
    if (strict) errors.push(line + ' —— 要么给 auto，要么写成可执行的判据');
    else warnings.push(line);
  }
  if (auto) {
    const kind = String(auto.kind || '').toLowerCase() || (auto.cmd ? 'shell' : auto.url ? 'http' : auto.path ? 'file' : '');
    if (!kind) errors.push('auto 缺 kind（shell / http / file / ui）');
    if (kind === 'shell' && !String(auto.cmd || '').trim()) errors.push('auto.kind=shell 但没给 cmd');
    if (kind === 'http' && !String(auto.url || '').trim()) errors.push('auto.kind=http 但没给 url');
    if (kind === 'file' && !String(auto.path || '').trim()) errors.push('auto.kind=file 但没给 path');
    if (kind === 'ui' && !String(auto.cmd || '').trim()) errors.push('auto.kind=ui 但没给 cmd：交互轨要跑真实的人流程脚本（打开页面→操作→断言）');
    if (kind === 'ui' && !String(auto.artifact || '').trim()) errors.push('auto.kind=ui 但没给 artifact：交互测试必须留下截图/录像/日志路径，否则人眼无法复核');
    if (kind === 'shell' && auto.expectExit === undefined && auto.expect === undefined && auto.expectStdout === undefined) {
      warnings.push('shell 检查没写任何断言（expectExit / expectStdout）：只能证明"跑完了"，证明不了"跑对了"');
    }
    if (kind === 'http' && auto.expectStatus === undefined && auto.expectBody === undefined) {
      warnings.push('http 检查没写 expectStatus / expectBody：建议至少卡状态码');
    }
    if (kind === 'file' && auto.expectMatch === undefined && auto.expectExists === undefined) {
      warnings.push('file 检查没写 expectMatch：只能证明文件在，不能证明内容对');
    }
  }
  if (!auto) warnings.push('这条只能人工验（无 auto）：证据会标 UNSIGNED，结单时按低可信度计');
  if (/^(修复|fix)/i.test(String(options.kind || '')) && !/复现|原|现象|报错|失败|复现步骤/.test(requirement + check)) {
    warnings.push('修复类单子建议留一条"原始现象"条目：同入口先把 bug 复现出来，修完再跑同一条');
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function boundaryHints() {
  return BOUNDARY_HINTS.slice();
}

export function hasExecutableHint(check) {
  return hasExecutable(check);
}

/**
 * 两轨测试校验：
 * - interactive=true（改动涉及页面/按钮/终端/GUI 等真人交互）：代码轨 + 交互轨都必须有；
 * - interactive=false（纯后端/纯逻辑）：只要求代码轨，交互轨可省略。
 */
export function inspectTracks(items, options = {}) {
  const interactive = options.interactive === true;
  const list = Array.isArray(items) ? items : [];
  const ui = list.filter((i) => String(i?.auto?.kind || '').toLowerCase() === 'ui');
  const code = list.filter((i) => i?.auto && String(i?.auto?.kind || '').toLowerCase() !== 'ui');
  const errors = [];
  const warnings = [];
  if (interactive && ui.length === 0) {
    errors.push('这次改动涉及人机交互：必须登记至少一条交互轨（auto.kind="ui"，跑真实点击/输入流程，并给 artifact 截图或日志）。只跑接口测试不算验过界面');
  }
  if (interactive && code.length === 0) {
    warnings.push('涉及交互但没登记代码轨（shell/http/file）：交互之外仍要有一条纯代码运行测试');
  }
  if (!interactive && ui.length > 0) {
    warnings.push('登记了交互轨但 interactive 没传 true：确认本次改动是否真的不碰界面');
  }
  if (list.length > 0 && code.length === 0 && ui.length > 0) {
    warnings.push('只有交互轨：交互能证明“人看到的效果”，但证明不了边界与异常，建议补代码轨');
  }
  return { ok: errors.length === 0, errors, warnings, tracks: { code: code.length, ui: ui.length } };
}

export { onlyEmptyWords, hasExecutable };
