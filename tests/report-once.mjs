import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMarkdown, buildJson, buildHtml } from "../lib/report.js";
const dir = path.join(os.homedir(), ".dsh", "acceptance");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.includes("history"));
const gates = files.map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; } }).filter((g) => g && g.status === "passed");
gates.sort((a, b) => String(b.closedAt || "").localeCompare(String(a.closedAt || "")));
const want = process.argv[2] || "";
const gate = want ? (gates.find((g) => g.id === want) || gates[0]) : gates[0];
if (!gate) { console.log("没有已结单"); process.exit(0); }
const out = process.cwd();
fs.writeFileSync(path.join(out, "ACCEPTANCE.md"), buildMarkdown(gate), "utf8");
fs.writeFileSync(path.join(out, "acceptance.json"), JSON.stringify(buildJson(gate), null, 2), "utf8");
fs.writeFileSync(path.join(out, "ACCEPTANCE.html"), buildHtml(gate), "utf8");
console.log("已用脱敏版重新生成：" + gate.id + " / " + gate.title);