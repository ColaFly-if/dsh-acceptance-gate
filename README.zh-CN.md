# dsh-acceptance-gate（验收闭环）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tests: 31 passing](https://img.shields.io/badge/tests-31%20passing-brightgreen)](tests/smoke.mjs)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4a9eff)](https://github.com/deepseek-ai)
[![Evidence: plugin-run](https://img.shields.io/badge/evidence-plugin--run-informational)](lib/checks.js)

**把「应该改好了」变成证据。** 一个 DeepSeek Harness 插件：改动前登记验收单，改动后由插件自己跑 check，只要还有没清零的条目，就不让这一回合结束。

[English](README.md)

---

## 它解决什么

模型说「好了」，是因为代码看起来对。这句话是自证的，check 是它自己记得跑的那条，也没人拿结果跟最初的需求对一遍。这个插件把三种翻车方式堵死：

| 翻车方式 | 闸门怎么拦 |
|---|---|
| 自己给自己判卷 | check 由插件执行，证据带 exit code、stdout、SHA-256、耗时 |
| check 答不上问题 | 质量守门在登记时就拒收空话需求、跑不出来的判据、没有断言的命令 |
| 验一半就收工 | 回合转空闲而验收单没清零，插件用 `agent.followup()` 把模型拽回来，最多 3 次 |

## 功能

- **按会话的验收单**：`accept_gate op=open` 记下需求（人话）、判定方式、严重级，以及可选的 `auto` 判据。
- **插件跑出来的证据**：`accept_run` 并发执行 `shell` / `http` / `file`（默认 4 路），记 exit code、输出尾、SHA-256、耗时。人工判定标 `UNSIGNED`，永远压不过 `AUTO`。
- **基线对比**：修前 `mode=baseline`，修后 `mode=verify`。修复类条目输出与基线完全一致会被标成可疑——通常意味着根本没改。
- **偶发识别**：失败自动重跑一次；只有重跑才过 = `FLAKY`，不会悄悄变绿。
- **质量守门**：拒收「功能正常」「测试一下」这类需求、没有命令/URL/路径的 check、没有期望值的 `auto`。
- **影响面采集**：`op=scope` 读 `git diff`，列出下游文件与同名测试，一起进回归范围。
- **回合闸门**：带冷却与上限的提醒；超过还在挂着就如实汇报，不会静默丢弃。
- **报告**：结单写 `ACCEPTANCE.md`、`acceptance.json`、`ACCEPTANCE.html`，绝对路径与主机名落盘前打码。
- **敏感信息扫描**：`accept_secrets` 找 API key、PEM 私钥、手机号/身份证、硬编码家目录、聊天记录、凭据文件、数据库；`op=purge` 删除确认敏感的**文件**。

## 两轨测试

每一次改动最多两轨验收，缺轨会被直接拒收。

| 轨道 | `auto.kind` | 证明什么 | 什么时候必须做 |
|---|---|---|---|
| 代码轨 | `shell` / `http` / `file` | 逻辑、接口契约、文件内容 | 始终 |
| 交互轨 | `ui` | 真人流程真的走通：打开页面、点击、输入，界面上确实出现了预期结果 | 改动涉及页面、按钮、表单、终端输入、任何 GUI |

`accept_gate op=open` 用 `interactive: true|false` 申报并强制：

- 申报 `true` 却没有一条 `ui` 条目 → 整张单被拒收。
- `ui` 条目必须同时给 `cmd`（真跑交互的脚本）和 `artifact`（截图/录像/日志路径）；产物缺失或为空一律不算跑过。
- 申报 `false`（纯后端/纯逻辑/纯配置）可省交互轨，代码轨照跑。

```json
{ "kind": "ui", "cmd": "node tests/live-browser-test.mjs",
  "expectStdout": "LIVE_REPLY_OK", "artifact": "tests/_live-shot.png" }
```

为什么：接口返回 200 只能证明接口通，证明不了按钮接上了、渲染链路没断、回复真的到了屏幕上。
## 安装

DSH 宿主插件：挂在 DSH 的 web server 上，不开端口、不起子进程。

1. 把目录链接进 DSH profile：

   ```bash
   # Windows（junction，不需要管理员）
   mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-acceptance-gate" "<path-to-repo>\dsh-acceptance-gate"
   # macOS / Linux
   ln -s "<path-to-repo>/dsh-acceptance-gate" ~/.dsh/profiles/desktop/node_modules/dsh-acceptance-gate
   ```

2. 在 profile 补丁层（`~/.dsh/profiles/desktop/cordis.patch.yml`）注册：

   ```yaml
   - insert:
       - id: dsh-acceptance-gate
         name: dsh-acceptance-gate
         config:
           strictMode: true
           strictPass: true
           allowManualPass: false
           autoClose: true
           runConcurrency: 4
   ```

3. 重启 DSH。`accept_gate`、`accept_run`、`accept_secrets` 三个工具可用，协议文本每轮自动注入。

## 五分钟上手

```text
# 1. 动代码之前先登记
accept_gate { op: "open", kind: "fix", severity: "P0", title: "登录重试",
  items: [{ requirement: "接口 500 后重试能显示第二次响应",
            check: "node test/login.mjs",
            auto: { kind: "shell", cmd: "node test/login.mjs", expectExit: 0, expectStdout: "RECEIVED 2" } }] }

# 2. 记修前现象（可选但建议）
accept_run { mode: "baseline" }

# 3. 改完跑同一条
accept_run {}                      # → pass/fail，证据由插件产生

# 4. 结单落报告
accept_gate { op: "report" }
```

### check 类型

| `auto.kind` | 字段 | 通过条件 |
|---|---|---|
| `shell` | `cmd`、`expectExit`、`expectStdout`、`expectStderr`、`timeoutMs` | exit code 匹配且输出含期望文本 |
| `http` | `url`、`method`、`headers`、`body`、`expectStatus`、`expectBody` | 状态码与响应体匹配 |
| `file` | `path`、`expectExists`、`expectMatch` | 文件存在/不存在且内容匹配 |

## 工具

### `accept_gate`

| `op` | 作用 |
|---|---|
| `open` | 开单（`title`、`kind`、`severity`、`items[]`） |
| `status` | 看当前单与进度 |
| `baseline` | 人工记修前现象 |
| `verify` | 人工结案（必须带 `evidence`；有 `auto` 的条目会被要求用 `accept_run`） |
| `add` / `drop` | 追加或删除条目 |
| `scope` | 按 `git diff` 采影响面 |
| `report` | 落 `ACCEPTANCE.md` / `.json` / `.html` |
| `close` | 结单（还有未结条目时拒绝） |
| `stats` / `history` | KPI 与历史单 |
| `reset` | 归档并清空 |

### `accept_run`

`{ id?: "3" | "all", mode?: "baseline" | "verify" }` —— 执行选中条目的 `auto` 判据，回写证据、结论、与基线的差异、偶发标记。

### `accept_secrets`

`{ op: "scan" | "purge", roots?: string[], limit?: number, dryRun?: boolean }` —— 扫源码与数据目录；`purge` 删敏感**文件**（历史、凭据、私钥、数据库），内容命中只报位置并打码，让你改代码而不是把源码删了。

## 配置

全部可选，下表是默认值。

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `sectionOrder` | `70` | 注入提示词段的位置 |
| `sectionName` | `acceptance-gate` | 提示词段名 |
| `strictMode` | `true` | 登记时质量守门 |
| `strictPass` | `true` | 人工结案必须带证据 |
| `allowManualPass` | `false` | 有 `auto` 的条目是否允许人工 pass |
| `requireAuto` | `false` | 每条都必须带 `auto` |
| `autoRunVerify` | `true` | `accept_run` 默认 `mode=verify` |
| `autoClose` | `true` | 全通过自动结单 |
| `writeReportOnClose` | `true` | 结单时落报告 |
| `kpi` | `true` | 写 KPI 日志 |
| `watchdog` | `true` | 回合闸门 |
| `watchdogMax` | `3` | 单个单最多提醒次数 |
| `watchdogCooldownMs` | `15000` | 提醒最小间隔 |
| `watchdogDelayMs` | `400` | 空闲后延迟多久提醒 |
| `watchdogFreshMs` | `600000` | 超过这个时长的单不再提醒 |
| `shellTimeoutMs` | `120000` | 单条命令超时 |
| `httpTimeoutMs` | `30000` | 单次请求超时 |
| `maxOutputChars` | `8000` | 留作证据的输出长度 |
| `runConcurrency` | `4` | `auto` 并发数 |
| `retryOnFail` | `1` | 重跑次数（只为识别偶发） |

## 实现结构

```text
系统提示 ──▶ accept_gate(open) ──▶ accept_run ──▶ 证据 ──▶ 结论 ──▶ 报告
    ▲                              │                              │
    └──── watchdog（agent.followup）◀┴──── 未结条目一直可见 ◀──────┘
```

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 工具、配置、提示词段、结单与报告 |
| `lib/checks.js` | `shell` / `http` / `file` 执行器、SHA-256、超时 |
| `lib/quality.js` | 登记时质量守门 |
| `lib/store.js` | 验收单持久化、历史、KPI |
| `lib/protocol.js` | 注入的协议文本与实时状态块 |
| `lib/watchdog.js` | 回合闸门 |
| `lib/impact.js` | `git diff` → 回归候选 |
| `lib/report.js` | Markdown / JSON / HTML 报告（脱敏） |
| `lib/secrets.js` | 敏感信息与敏感文件扫描、路径打码 |

状态在 `~/.dsh/acceptance/`：`<sessionId>.json` 是当前单，`history.jsonl` 是已结单，`kpi.jsonl` 是统计。

## 开发与测试

```bash
node tests/smoke.mjs               # 31 条断言，临时目录
node tests/publish-check.mjs .     # 发布前门禁
node tests/scan-once.mjs           # 敏感信息扫描（只读）
```

`publish-check` 会在发现绝对路径、本机用户名、主机名、API key、手机号、身份证时直接失败——正是报告最容易带出去的那类泄露。

## 限制

- 证据质量的上限由 check 决定：`expectStdout` 写错了，它也会「诚实地通过」。
- `impact` 依赖 git 工作树；不在 git 里会返回空集。
- watchdog 需要宿主支持 `agent.followup()`；不支持时仍由提示词段约束。
- 报告里是命令输出（已打码），不是完整沙箱审计轨迹。

## 许可

[MIT](LICENSE)
