import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanSecrets, purgeSecrets, renderScan, scrubText } from "../lib/secrets.js";
const DIR = path.join(os.homedir(), ".dsh", "group-chat");
if (!fs.existsSync(DIR)) { console.log("目录不存在：" + scrubText(DIR)); process.exit(0); }
const r = scanSecrets({ roots: [DIR], limit: 2000 });
console.log(renderScan(r, 20));
const p = purgeSecrets(r, {});
console.log("\n已删除 " + p.removed.length + " 个文件：" );
for (const x of p.removed) console.log("- " + scrubText(x.path) + "  " + (x.bytes || 0) + "B");
if (p.failed.length) for (const x of p.failed) console.log("- 失败 " + scrubText(x.path) + "：" + x.error);
const rest = scanSecrets({ roots: [DIR], limit: 2000 });
console.log("\n复查：" + (rest.ok ? "干净" : "仍有 " + (rest.hits.length + rest.sensitiveFiles.length) + " 处"));
for (const x of rest.sensitiveFiles) console.log("- 残留文件 " + scrubText(x.path));
for (const x of rest.hits) console.log("- 残留命中 " + scrubText(x.path) + ":" + x.line + " [" + x.rule + "]");