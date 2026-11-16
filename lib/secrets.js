// 敏感信息扫描器：测试流程的统一一环。
// 两类目标：
//   1) 敏感文件（凭据/私钥/聊天历史/db/cookie/env）—— 可一键删除
//   2) 内容命中（key/私钥/手机号/身份证/邮箱/硬编码用户目录）—— 报位置 + 打码，不删源码
import fs from "node:fs";
import nodePath from "node:path";
import os from "node:os";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".cache", "__pycache__", ".venv"]);
const MAX_FILE = 2 * 1024 * 1024;

const RULES = [
  { id: "deepseek-key", label: "DeepSeek API Key", re: /DEEPSEEK_API_KEY\s*[:=]\s*["\x27]?[A-Za-z0-9_\-.]{16,}/g },
  { id: "sk-token", label: "sk- 风格 token", re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { id: "bearer", label: "Bearer token", re: /Bearer\s+[A-Za-z0-9._-]{20,}/g },
  { id: "pem-private", label: "PEM 私钥", re: /-----BEGIN[ A-Z]*PRIVATE KEY-----/g },
  { id: "generic-secret", label: "通用密钥赋值", re: /(api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*["\x27][^"\x27]{12,}["\x27]/gi },
  { id: "phone-cn", label: "手机号", re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { id: "idcard-cn", label: "身份证号", re: /(?<!\d)\d{17}[\dXx](?!\d)/g },
  { id: "email", label: "邮箱", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { id: "win-userpath", label: "硬编码 Windows 用户目录", re: /[A-Za-z]:\\+Users\\+[^\\\s"\x27]+/gi },
  { id: "nix-userpath", label: "硬编码 unix 家目录", re: /\/(?:Users|home)\/[A-Za-z0-9._-]+/g },
];

const SENSITIVE_FILE = [
  { id: "history-json", label: "聊天历史", test: (f) => /(^|[\\/])history[\\/][^\\/]+\.json$/i.test(f) },
  { id: "credential", label: "凭据文件", test: (f) => /(^|[\\/])(\.credentials[^\\/]*|\.env(\..+)?|credentials\.(json|ya?ml))$/i.test(f) },
  { id: "private-key", label: "私钥文件", test: (f) => /\.(pem|key|pfx|p12)$/i.test(f) || /(^|[\\/])id_(rsa|ed25519)$/.test(f) },
  { id: "cookie-db", label: "cookie/会话数据", test: (f) => /(cookies?|session)[^\\/]*\.(json|sqlite|db)$/i.test(f) },
  { id: "db", label: "数据库文件", test: (f) => /\.(sqlite|sqlite3|db)$/i.test(f) },
  { id: "bots-json", label: "人格库覆盖(可能含用户改的别名/简介)", test: (f) => /(^|[\\/])bots\.json$/i.test(f) },
];

export function mask(text) {
  const s = String(text == null ? "" : text);
  if (s.length <= 8) return s.replace(/./g, "*");
  return s.slice(0, 4) + "*".repeat(Math.min(12, s.length - 8)) + s.slice(-4);
}

function walk(root, out, depth, limit) {
  if (out.length >= limit || depth > 8) return;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= limit) return;
    const full = nodePath.join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, out, depth + 1, limit);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
}

export function scanSecrets(options = {}) {
  const roots = (options.roots && options.roots.length ? options.roots : [process.cwd()]).map((r) => nodePath.resolve(r));
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 4000;
  const files = [];
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      const st = fs.statSync(root);
      if (st.isFile()) files.push(root);
      else walk(root, files, 0, limit);
    } catch { /* ignore */ }
  }

  const sensitiveFiles = [];
  const hits = [];
  let scanned = 0;
  let skippedBinary = 0;

  for (const file of files.slice(0, limit)) {
    for (const rule of SENSITIVE_FILE) {
      if (rule.test(file)) { sensitiveFiles.push({ path: file, rule: rule.id, label: rule.label, bytes: (() => { try { return fs.statSync(file).size; } catch { return 0; } })() }); break; }
    }
    let text = "";
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_FILE) continue;
      text = fs.readFileSync(file, "utf8");
    } catch { continue; }
    if (text.indexOf("\u0000") >= 0) { skippedBinary += 1; continue; }
    scanned += 1;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.length > 4000) continue;
      for (const rule of RULES) {
        rule.re.lastIndex = 0;
        const m = rule.re.exec(line);
        if (!m) continue;
        hits.push({
          path: file,
          line: i + 1,
          rule: rule.id,
          label: rule.label,
          sample: mask(m[0].slice(0, 80)),
          preview: mask(String(line.trim()).slice(0, 120)),
        });
        break;
      }
    }
  }

  const byRule = {};
  for (const h of hits) byRule[h.rule] = (byRule[h.rule] || 0) + 1;

  return {
    roots,
    scannedFiles: scanned,
    skippedBinary,
    totalFiles: files.length,
    hits,
    sensitiveFiles,
    byRule,
    ok: hits.length === 0 && sensitiveFiles.length === 0,
  };
}

export function purgeSecrets(result, options = {}) {
  const dryRun = options.dryRun === true;
  const removed = [];
  const failed = [];
  for (const item of result.sensitiveFiles || []) {
    if (dryRun) { removed.push({ path: item.path, rule: item.rule, dryRun: true }); continue; }
    try {
      fs.rmSync(item.path, { force: true });
      removed.push({ path: item.path, rule: item.rule, bytes: item.bytes });
    } catch (error) {
      failed.push({ path: item.path, error: String((error && error.message) || error) });
    }
  }
  return { removed, failed, dryRun };
}

// 报告脱敏：把绝对路径里的用户名/业务根打掉，避免个人目录结构进证据。
const BS = String.fromCharCode(92);
const SCRUBS = [
  [new RegExp("([A-Za-z]):" + BS + BS + "+Users" + BS + BS + "+[^" + BS + BS + " " + BS + "s|]+", "gi"), "$1:" + BS + "<home>"],
  [new RegExp("/" + "(?:Users|home)/[^/" + " " + BS + "s|]+", "g"), "/<home>"],
  [new RegExp("([A-Za-z]):" + BS + BS + "+[^" + BS + "s|<>" + "]+", "gi"), "$1:" + BS + "<path>"],
  [new RegExp("([A-Za-z]):" + BS + BS + "+AppData" + BS + BS + "+[^" + BS + BS + " " + BS + "s|]+", "gi"), "$1:" + BS + "<appdata>"],
];
const LITERAL_SUBS = [
  ["AppData" + BS + "Local" + BS + "Temp", "<temp>"],
  ["AppData" + BS + "Roaming", "<appdata>"],
];
export function scrubText(value) {
  let t = String(value == null ? "" : value);
  for (const pair of LITERAL_SUBS) t = t.split(pair[0]).join(pair[1]);
  // 运行期动态：家目录 / 临时目录 / 当前工作目录（换台机器照样生效，且不留本机路径）
  for (const dyn of [(() => { try { return os.homedir(); } catch { return ""; } })(), (() => { try { return os.tmpdir(); } catch { return ""; } })(), (() => { try { return process.cwd(); } catch { return ""; } })()]) {
    if (typeof dyn === "string" && dyn.length > 3) t = t.split(dyn).join("<local>");
  }
  const hostName = (() => { try { return os.hostname(); } catch { return ""; } })();
  if (hostName.length > 2) t = t.split(hostName).join("<host>");
  for (const pair of SCRUBS) t = t.replace(pair[0], pair[1]);
  return t;
}

export function scrubDeep(value) {
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = scrubDeep(value[k]);
    return out;
  }
  return value;
}

export function renderScan(result, limit = 30) {
  const lines = [];
  lines.push("敏感信息扫描：" + (result.ok ? "干净" : "命中 " + (result.hits.length + result.sensitiveFiles.length) + " 处"));
  lines.push("扫描根：" + result.roots.join("、"));
  lines.push("文件：" + result.totalFiles + " 个，读过 " + result.scannedFiles + " 个，跳过二进制 " + result.skippedBinary);
  if (result.sensitiveFiles.length) {
    lines.push("");
    lines.push("敏感文件（可删）：");
    for (const f of result.sensitiveFiles.slice(0, limit)) lines.push("- [" + f.rule + "] " + f.path + "  " + f.bytes + "B");
    if (result.sensitiveFiles.length > limit) lines.push("- ……另 " + (result.sensitiveFiles.length - limit) + " 个");
  }
  if (result.hits.length) {
    lines.push("");
    lines.push("内容命中（已打码）：");
    for (const h of result.hits.slice(0, limit)) lines.push("- " + h.path + ":" + h.line + "  [" + h.rule + "] " + h.sample);
    if (result.hits.length > limit) lines.push("- ……另 " + (result.hits.length - limit) + " 处");
  }
  if (!result.ok) {
    lines.push("");
    lines.push("处置：敏感文件用 accept_secrets op=purge 删除；内容命中改代码去掉字面量（读环境变量/配置），别把 key 写进仓库。");
  }
  return lines.join("\n");
}