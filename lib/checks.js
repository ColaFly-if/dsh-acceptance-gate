// 可执行检查执行器：插件自己跑，证据由插件产生，模型只能引用。
// 四种 kind：shell / http / file / ui（交互轨：真跑人流程 + 必须留可见产物）。任何异常都收敛成 fail 证据，不抛出。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

const DEFAULT_SHELL_TIMEOUT = 120000;
const DEFAULT_HTTP_TIMEOUT = 30000;
const MAX_OUTPUT = 8000;

function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function tail(text, max = 1500) {
  const s = String(text == null ? '' : text);
  if (s.length <= max) return s;
  return '…' + s.slice(s.length - max);
}

function cap(text, max = MAX_OUTPUT) {
  const s = String(text == null ? '' : text);
  return s.length <= max ? s : s.slice(0, max) + '…[truncated ' + (s.length - max) + ' chars]';
}

/** 断言值支持三种写法：字符串=包含、/re/flags=正则、数组=任一命中 */
function matchText(haystack, needle) {
  if (needle === undefined || needle === null || needle === '') return { ok: true, how: 'no-assert' };
  const text = String(haystack == null ? '' : haystack);
  if (Array.isArray(needle)) {
    for (const one of needle) {
      const r = matchText(text, one);
      if (r.ok) return { ok: true, how: 'any:' + r.how };
    }
    return { ok: false, how: 'none-matched' };
  }
  const raw = String(needle);
  const re = /^\/(.*)\/([gimsuy]*)$/.exec(raw);
  if (re) {
    try {
      const rx = new RegExp(re[1], re[2]);
      return { ok: rx.test(text), how: 'regex:' + raw };
    } catch (error) {
      return { ok: false, how: 'bad-regex:' + String(error && error.message || error) };
    }
  }
  return { ok: text.includes(raw), how: 'contains:' + raw };
}

function runShell(spec, options) {
  const timeoutMs = Number(spec.timeoutMs) > 0 ? Number(spec.timeoutMs) : (options.shellTimeoutMs || DEFAULT_SHELL_TIMEOUT);
  const cwd = spec.cwd || options.cwd || process.cwd();
  const command = String(spec.cmd || spec.command || '').trim();
  if (!command) {
    return Promise.resolve({ ok: false, reason: 'shell 检查缺 cmd', evidence: { kind: 'shell', error: 'missing cmd', ts: new Date().toISOString() } });
  }
  const started = Date.now();
  return new Promise((resolve) => {
    let child;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };
    try {
      // 默认用宿主的系统 shell（Windows=cmd / POSIX=sh），保证 node/npm/git 这类原生命令能用；
      // 要 bash 语义就显式 spec.shell = "bash"（走 bash -lc，Windows 上取 MSYS/Git bash）。
      const wantBash = String(spec.shell || '').toLowerCase() === 'bash';
      if (wantBash) {
        // 不写死安装路径：env > PATH 上的 bash > 系统 /bin/bash
        const bash = process.env.MSYS_BASH || (process.platform === 'win32' ? 'bash' : '/bin/bash');
        child = spawn(bash, ['-lc', command], { cwd, windowsHide: true });
      } else {
        child = spawn(command, { cwd, shell: true, windowsHide: true });
      }
    } catch (error) {
      finish({
        ok: false,
        reason: 'spawn 失败：' + String(error && error.message || error),
        evidence: { kind: 'shell', cmd: command, cwd, error: String(error && error.message || error), ts: new Date().toISOString(), durationMs: 0 },
      });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({
        ok: false,
        reason: 'shell 执行异常：' + String(error && error.message || error),
        evidence: { kind: 'shell', cmd: command, cwd, error: String(error && error.message || error), ts: new Date().toISOString(), durationMs: Date.now() - started },
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      const expectExit = spec.expectExit === undefined ? 0 : spec.expectExit;
      const stdoutAssert = matchText(stdout, spec.expectStdout ?? spec.expect);
      const stderrAssert = spec.expectStderr === undefined
        ? { ok: true, how: 'no-assert' }
        : matchText(stderr, spec.expectStderr);
      const cleanStderr = spec.expectStderrEmpty === true ? { ok: stderr.trim() === '', how: 'stderr-empty' } : { ok: true, how: 'ignore' };
      const exitOk = spec.expectExit === 'any' ? true : (code === expectExit);
      const ok = !timedOut && exitOk && stdoutAssert.ok && stderrAssert.ok && cleanStderr.ok;
      const failures = [];
      if (timedOut) failures.push('超时 ' + timeoutMs + 'ms');
      if (!exitOk) failures.push('exit=' + code + '，期望 ' + expectExit);
      if (!stdoutAssert.ok) failures.push('stdout 未匹配 ' + stdoutAssert.how);
      if (!stderrAssert.ok) failures.push('stderr 未匹配 ' + stderrAssert.how);
      if (!cleanStderr.ok) failures.push('stderr 非空');
      const evidence = {
        kind: 'shell',
        cmd: command,
        cwd,
        exitCode: code === null ? 'signal:' + signal : code,
        signal: signal || null,
        timedOut,
        durationMs,
        hash: sha256(command + '\n' + String(code) + '\n' + stdout + '\n' + stderr),
        stdoutHash: sha256(stdout),
        stdoutTail: tail(stdout),
        stderrTail: tail(stderr),
        asserts: { exit: exitOk, stdout: stdoutAssert.how, stderr: stderrAssert.how, stderrEmpty: cleanStderr.how },
        ts: new Date().toISOString(),
        host: os.hostname(),
        source: 'accept-plugin',
      };
      finish({ ok, reason: ok ? 'asserts passed' : failures.join('；') || 'asserts failed', evidence });
    });
  });
}

async function runHttp(spec, options) {
  const timeoutMs = Number(spec.timeoutMs) > 0 ? Number(spec.timeoutMs) : (options.httpTimeoutMs || DEFAULT_HTTP_TIMEOUT);
  const url = String(spec.url || '').trim();
  if (!url) return { ok: false, reason: 'http 检查缺 url', evidence: { kind: 'http', error: 'missing url', ts: new Date().toISOString() } };
  const started = Date.now();
  try {
    const method = String(spec.method || 'GET').toUpperCase();
    const headers = spec.headers && typeof spec.headers === 'object' ? spec.headers : undefined;
    const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (spec.body !== undefined && method !== 'GET' && method !== 'HEAD') {
      init.body = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
      if (!init.headers || !Object.keys(init.headers).some((k) => k.toLowerCase() === 'content-type')) {
        init.headers = { ...(init.headers || {}), 'content-type': 'application/json' };
      }
    }
    const response = await fetch(url, init);
    const body = await response.text();
    const durationMs = Date.now() - started;
    const expectStatus = spec.expectStatus === undefined ? null : spec.expectStatus;
    const statusOk = expectStatus === null
      ? (response.status >= 200 && response.status < 400)
      : (Array.isArray(expectStatus) ? expectStatus.includes(response.status) : response.status === Number(expectStatus));
    const bodyAssert = matchText(body, spec.expectBody ?? spec.expect);
    const ok = statusOk && bodyAssert.ok;
    const failures = [];
    if (!statusOk) failures.push('HTTP ' + response.status + '，期望 ' + (expectStatus === null ? '2xx/3xx' : JSON.stringify(expectStatus)));
    if (!bodyAssert.ok) failures.push('响应体未匹配 ' + bodyAssert.how);
    return {
      ok,
      reason: ok ? 'asserts passed' : failures.join('；'),
      evidence: {
        kind: 'http',
        method,
        url,
        status: response.status,
        durationMs,
        hash: sha256(method + ' ' + url + ' ' + response.status + ' ' + body),
        bodyHash: sha256(body),
        bodyTail: tail(body),
        asserts: { status: statusOk, body: bodyAssert.how },
        ts: new Date().toISOString(),
        host: os.hostname(),
        source: 'accept-plugin',
      },
    };
  } catch (error) {
    const message = String(error && error.message || error);
    return {
      ok: false,
      reason: '请求失败：' + message,
      evidence: {
        kind: 'http',
        url,
        error: message,
        durationMs: Date.now() - started,
        ts: new Date().toISOString(),
        host: os.hostname(),
        source: 'accept-plugin',
      },
    };
  }
}

function runFile(spec, options) {
  const started = Date.now();
  const target = String(spec.path || '').trim();
  const resolved = target ? nodePath.resolve(options.cwd || process.cwd(), target) : '';
  if (!resolved) return { ok: false, reason: 'file 检查缺 path', evidence: { kind: 'file', error: 'missing path', ts: new Date().toISOString() } };
  const exists = fs.existsSync(resolved);
  const expectExists = spec.expectExists === false ? false : true;
  if (exists !== expectExists) {
    return {
      ok: false,
      reason: exists ? '文件存在，但期望不存在' : '文件不存在：' + resolved,
      evidence: { kind: 'file', path: resolved, exists, durationMs: Date.now() - started, ts: new Date().toISOString(), source: 'accept-plugin' },
    };
  }
  if (!exists) {
    return { ok: true, reason: '文件确实不存在（符合期望）', evidence: { kind: 'file', path: resolved, exists, durationMs: Date.now() - started, ts: new Date().toISOString(), source: 'accept-plugin' } };
  }
  let content = '';
  try {
    const stat = fs.statSync(resolved);
    content = stat.size > 2 * 1024 * 1024 ? fs.readFileSync(resolved, 'utf8').slice(0, 2 * 1024 * 1024) : fs.readFileSync(resolved, 'utf8');
  } catch (error) {
    return {
      ok: false,
      reason: '读文件失败：' + String(error && error.message || error),
      evidence: { kind: 'file', path: resolved, exists, durationMs: Date.now() - started, ts: new Date().toISOString(), source: 'accept-plugin' },
    };
  }
  const assert = matchText(content, spec.expectMatch ?? spec.expect);
  const lines = content.split('\n').length;
  return {
    ok: assert.ok,
    reason: assert.ok ? 'asserts passed' : '内容未匹配 ' + assert.how,
    evidence: {
      kind: 'file',
      path: resolved,
      exists,
      bytes: content.length,
      lines,
      durationMs: Date.now() - started,
      hash: sha256(content),
      asserts: { match: assert.how },
      ts: new Date().toISOString(),
      host: os.hostname(),
      source: 'accept-plugin',
    },
  };
}

/**
 * 交互轨：跑一段真实的人机交互脚本（浏览器点按钮 / CLI 交互 / GUI 自动化），
 * 并且必须留下可见产物（截图/录像/日志）。没有产物就不算跑过交互。
 */
async function runUi(spec, options) {
  const artifact = String(spec.artifact || '').trim();
  const started = Date.now();
  const res = await runShell(spec, options);
  const evidence = Object.assign({}, res.evidence, { kind: 'ui', track: 'interactive' });
  const failures = res.ok ? [] : [res.reason];
  if (artifact) {
    const resolved = nodePath.resolve(options.cwd || process.cwd(), artifact);
    let exists = false;
    let bytes = 0;
    try { const st = fs.statSync(resolved); exists = true; bytes = st.size; } catch { exists = false; }
    evidence.artifact = { path: resolved, exists, bytes };
    if (!exists) failures.push('交互产物不存在：' + artifact + '（交互测试必须留截图/录像/日志）');
    else if (bytes === 0) failures.push('交互产物是空文件：' + artifact);
  } else {
    failures.push('交互检查必须给 artifact（截图/录像/日志路径）：没有可见产物不算跑过交互');
  }
  const ok = res.ok && failures.length === 0;
  return { ok, reason: ok ? 'asserts passed（交互轨）' : failures.join('；'), evidence: Object.assign(evidence, { ok, durationMs: Date.now() - started, artifact }) };
}
export function hasAuto(item) {
  return Boolean(item && item.auto && typeof item.auto === 'object' && (item.auto.cmd || item.auto.url || item.auto.path));
}

export async function runAuto(item, options = {}) {
  const spec = item?.auto || {};
  const kind = String(spec.kind || '').toLowerCase() || (spec.cmd ? 'shell' : spec.url ? 'http' : spec.path ? 'file' : '');
  if (kind === 'shell') return runShell(spec, options);
  if (kind === 'http') return runHttp(spec, options);
  if (kind === 'file') return runFile(spec, options);
  if (kind === 'ui') return runUi(spec, options);
  return {
    ok: false,
    reason: '不认识的 auto.kind：' + (kind || '(空)') + '（支持 shell / http / file / ui）',
    evidence: { kind: kind || 'unknown', error: 'unknown-kind', ts: new Date().toISOString() },
  };
}

export function hashOf(text) {
  return sha256(text);
}

export { matchText, tail, cap };
