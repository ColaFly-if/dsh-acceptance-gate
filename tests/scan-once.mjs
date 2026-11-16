// 与 cwd 无关：默认扫插件自己；也可传入要扫的目录
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanSecrets, renderScan } from "../lib/secrets.js";
const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = process.argv.slice(2).length ? process.argv.slice(2) : [PLUGIN];
const r = scanSecrets({ roots, limit: 4000 });
console.log(renderScan(r, 40));
console.log("\nHITS=" + r.hits.length + " SENSITIVE=" + r.sensitiveFiles.length + " FILES=" + r.totalFiles);