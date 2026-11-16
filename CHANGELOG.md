# Changelog

## 0.4.0

### 新增：两轨测试（代码轨 + 交互轨）

- 新增 `auto.kind = "ui"`：交互轨。跑真实人流程（打开页面→点击/输入→断言界面出现预期结果），并强制要求 `artifact`（截图/录像/日志路径），产物缺失或为空一律判 fail。
- `accept_gate op=open` 新增 `interactive: true|false`：申报 `true` 时若没有一条 `ui` 条目，整张单被质量守门拒收；申报 `false` 只跑代码轨。
- `inspectTracks()`：统一校验两轨完整性，并给出「只有交互轨缺边界覆盖」等提醒。
- 状态与报告新增轨道统计：`轨道：代码 x/y　交互 a/b`。
- 协议提示词新增「两轨测试」章节：有交互就两轨都做，没交互只做代码轨。
- smoke 新增 4 条断言：涉及交互却没交互轨被拒、交互轨登记成功、状态显示两轨、交互轨缺 artifact 被拒。
## 0.3.1

- Tests and scanners resolve the plugin root from their own location, so `npm test` works from any working directory.
- Add `CONTRIBUTING.md`, `check:publish` / `check:secrets` scripts.

## 0.3.0

- Add `accept_secrets`: secret and sensitive-file scanning (`scan` / `purge`).
- Scrub absolute paths, home directories, temp dirs and host names before writing reports (Markdown, JSON, HTML).
- Remove hard-coded install paths from the shell runner.
- Add MIT license, bilingual README, package metadata, publish check.

## 0.2.0

- `accept_run` executor: shell / http / file checks, SHA-256 evidence, concurrency, flake retry, delta-vs-baseline.
- Quality gate, turn watchdog, impact scan, KPI, Markdown/JSON/HTML reports.

## 0.1.0

- First version: ledger, manual verdicts, prompt section.
