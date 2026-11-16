# Changelog

## 0.1.1

此前 0.1.0 – 0.4.0 为内部迭代，能力已并入本版本。

### 两轨测试

- 代码轨：`auto.kind` = `shell` / `http` / `file`。
- 交互轨：`auto.kind` = `ui`，真跑人流程（打开页面 → 点击/输入 → 断言界面出现预期结果），必须给 `artifact`（截图/录像/日志），缺失或 0 字节判 fail。
- `accept_gate op=open` 的 `interactive: true|false`：申报 `true` 却没交交互轨，整张单被质量守门拒收；申报 `false` 只跑代码轨。
- `inspectTracks()` 校验两轨完整性，并提醒「只有交互轨、缺边界覆盖」。
- 状态与报告输出 `轨道：代码 x/y　交互 a/b`。

### 证据

- `accept_run` 执行器：跑 check，产出 exit code、输出、sha256、耗时；并发、失败重试、与基线的 Δ 比对。
- 质量守门：空话 requirement、跑不出来的 check、空验收单，一律拒收。
- 回合闸门（watchdog）：欠账未清零时把 agent 拽回来继续。
- 报告：Markdown / JSON / HTML，落盘前清洗绝对路径、家目录、临时目录、主机名。

### 安全与运维

- `accept_secrets`：密钥与敏感文件扫描（`scan` / `purge`）。
- 影响面采集（`op=scope`）、KPI（`op=stats`）、历史（`op=history`）。
- MIT 许可、中英双 README、`check:publish` / `check:secrets`。

### 测试

- `tests/smoke.mjs`：35 条断言，其中 4 条专测两轨守门（涉及交互却没交互轨被拒、交互轨登记成功、状态显示两轨、交互轨缺 artifact 被拒）。
