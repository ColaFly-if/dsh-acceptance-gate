# dsh-acceptance-gate

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tests: 31 passing](https://img.shields.io/badge/tests-31%20passing-brightgreen)](tests/smoke.mjs)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4a9eff)](https://github.com/deepseek-ai)
[![Evidence: plugin-run](https://img.shields.io/badge/evidence-plugin--run-informational)](lib/checks.js)

**Turn "it should be fixed now" into evidence. A DeepSeek Harness plugin that registers an acceptance gate before a change, runs the checks itself after the change, and refuses to let the turn end while anything is still failing.**

[中文说明](README.zh-CN.md)

---

## The problem

An agent says "done" because the code looks right. The claim is self-reported, the check is whatever the agent remembered to run, and nothing compares the result against the original request. This plugin makes the three failure modes impossible:

| Failure mode | What the gate does |
|---|---|
| The agent marks its own homework | Checks are executed by the plugin, and the evidence carries exit code, stdout, SHA-256 and duration |
| The check does not answer the question | The quality gate rejects vague requirements, unexecutable checks, and non-asserting commands at registration time |
| The work stops half-verified | When the turn goes idle with an open gate, the plugin nudges the agent back with `agent.followup()` |

## Features

- **Acceptance ledger per session** — `accept_gate op=open` records requirement, human-readable check, severity and an optional machine-executable `auto` spec.
- **Plugin-run evidence** — `accept_run` executes `shell` / `http` / `file` checks concurrently (default 4), records exit code, output tail, SHA-256 and timing. Manual verdicts are labelled `UNSIGNED` and never outrank `AUTO`.
- **Baseline diff** — `mode=baseline` before the fix, `mode=verify` after. Unchanged output on a "fix" item is flagged as suspicious, because it usually means nothing changed.
- **Flake detection** — a failure is retried once; passing only on retry is marked `FLAKY`, never silently green.
- **Quality gate** — refuses requirements like "works fine", checks with no command/URL/path, and `auto` specs with no expectation.
- **Impact scan** — `op=scope` reads `git diff` and lists downstream files and sibling tests that must enter the regression set.
- **Turn watchdog** — up to 3 nudges with cooldown; a gate that is still open after that is reported, not silently dropped.
- **Reports** — `ACCEPTANCE.md`, `acceptance.json`, `ACCEPTANCE.html` on close, with absolute paths and host names scrubbed.
- **Secret scan** — `accept_secrets` finds API keys, PEM blocks, phone/ID numbers, hard-coded home directories, chat history, credential files and databases; `op=purge` deletes the files it proves are sensitive.

## Two test tracks

Every change is verified on up to two tracks. The gate refuses a job that only ran one of them.

| Track | `auto.kind` | Proves | Required when |
|---|---|---|---|
| Code | `shell` / `http` / `file` | logic, API contract, file content | always |
| Interactive | `ui` | a real person-facing flow: open the page, click, type, and the expected result actually shows up | the change touches a UI, buttons, forms, terminal input or any GUI |

Enforced by `accept_gate op=open` with `interactive: true|false`:

- `interactive: true` requires at least one `ui` item, otherwise the gate rejects the whole sheet.
- A `ui` item must carry both `cmd` (a real interaction script) and `artifact` (screenshot / recording / log path). Missing or empty artifact = not verified.
- `interactive: false` (pure backend, pure logic, pure config) skips the interactive track; the code track still applies.

```json
{ "kind": "ui", "cmd": "node tests/live-browser-test.mjs",
  "expectStdout": "LIVE_REPLY_OK", "artifact": "tests/_live-shot.png" }
```

Why: an endpoint returning 200 proves the endpoint works — not that the button is wired, the render path is intact, or the reply reaches the screen.
## Install

DSH host plugin: mounts inside the DSH web server, no extra port, no child process.

1. Link the folder into your DSH profile:

   ```bash
   # Windows (junction, no admin needed)
   mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-acceptance-gate" "<path-to-repo>\dsh-acceptance-gate"
   # macOS / Linux
   ln -s "<path-to-repo>/dsh-acceptance-gate" ~/.dsh/profiles/desktop/node_modules/dsh-acceptance-gate
   ```

2. Add it to the profile patch layer (`~/.dsh/profiles/desktop/cordis.patch.yml`):

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

3. Restart DSH. The tools `accept_gate`, `accept_run` and `accept_secrets` become available and the protocol text is injected every turn.

## Quick start

```text
# 1. register before touching code
accept_gate { op: "open", kind: "fix", severity: "P0", title: "login retry",
  items: [{ requirement: "Retry after a 500 shows the second response",
            check: "node test/login.mjs",
            auto: { kind: "shell", cmd: "node test/login.mjs", expectExit: 0, expectStdout: "RECEIVED 2" } }] }

# 2. record the broken state (optional but recommended)
accept_run { mode: "baseline" }

# 3. after the fix, run the same check
accept_run {}                      # -> pass/fail with plugin-produced evidence

# 4. reports are written on close
accept_gate { op: "report" }
```

### Check kinds

| `auto.kind` | Fields | Passes when |
|---|---|---|
| `shell` | `cmd`, `expectExit`, `expectStdout`, `expectStderr`, `timeoutMs` | exit code matches and stdout/stderr contain the expected text |
| `http` | `url`, `method`, `headers`, `body`, `expectStatus`, `expectBody` | status and body match |
| `file` | `path`, `expectExists`, `expectMatch` | file exists/absent and content matches |

## Tools

### `accept_gate`

| `op` | Purpose |
|---|---|
| `open` | Start a ledger (`title`, `kind`, `severity`, `items[]`) |
| `status` | Show the current ledger and progress |
| `baseline` | Record the pre-fix symptom manually |
| `verify` | Manual verdict (needs `evidence`; refused for `auto` items unless `allowManualPass`) |
| `add` / `drop` | Extend or remove items |
| `scope` | Impact scan from `git diff` |
| `report` | Write `ACCEPTANCE.md` / `.json` / `.html` |
| `close` | Close the ledger (refused while items are pending) |
| `stats` / `history` | KPI and past ledgers |
| `reset` | Archive and clear |

### `accept_run`

`{ id?: "3" | "all", mode?: "baseline" | "verify" }` — runs the `auto` checks of the selected items and writes back evidence, verdict, delta-vs-baseline and flake flag.

### `accept_secrets`

`{ op: "scan" | "purge", roots?: string[], limit?: number, dryRun?: boolean }` — scans source and data directories; `purge` deletes sensitive **files** (history, credentials, keys, databases) while content hits are reported with masked previews so you fix the code instead of shredding it.

## Configuration

All keys are optional; defaults shown.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch |
| `sectionOrder` | `70` | Order of the injected prompt section |
| `sectionName` | `acceptance-gate` | Prompt section name |
| `strictMode` | `true` | Quality gate on registration |
| `strictPass` | `true` | Manual verdict must carry evidence |
| `allowManualPass` | `false` | Allow manual pass on items that have an `auto` |
| `requireAuto` | `false` | Require every item to declare `auto` |
| `autoRunVerify` | `true` | `accept_run` defaults to `mode=verify` |
| `autoClose` | `true` | Close automatically when everything passes |
| `writeReportOnClose` | `true` | Write reports on close |
| `kpi` | `true` | Append to the KPI log |
| `watchdog` | `true` | Turn-end nudge while the gate is open |
| `watchdogMax` | `3` | Maximum nudges per gate |
| `watchdogCooldownMs` | `15000` | Minimum gap between nudges |
| `watchdogDelayMs` | `400` | Delay after idle before nudging |
| `watchdogFreshMs` | `600000` | Ignore gates older than this |
| `shellTimeoutMs` | `120000` | Per-command timeout |
| `httpTimeoutMs` | `30000` | Per-request timeout |
| `maxOutputChars` | `8000` | Output retained as evidence |
| `runConcurrency` | `4` | Parallel `auto` checks |
| `retryOnFail` | `1` | Retries used to detect flakiness |

## How it works

```text
system prompt ──▶ accept_gate(open) ──▶ accept_run ──▶ evidence ──▶ verdict ──▶ report
      ▲                                   │                                     │
      └──── watchdog (agent.followup) ◀───┴──── pending items stay visible ◀──────┘
```

| File | Role |
|---|---|
| `lib/index.js` | Tools, config, prompt section, close/report wiring |
| `lib/checks.js` | `shell` / `http` / `file` runners, SHA-256, timeouts |
| `lib/quality.js` | Registration-time quality gate |
| `lib/store.js` | Ledger persistence, history, KPI |
| `lib/protocol.js` | Injected protocol text and live ledger block |
| `lib/watchdog.js` | Turn-end nudge |
| `lib/impact.js` | `git diff` → regression candidates |
| `lib/report.js` | Markdown / JSON / HTML reports (scrubbed) |
| `lib/secrets.js` | Secret and sensitive-file scanning, path scrubbing |

State lives in `~/.dsh/acceptance/`: `<sessionId>.json` for the live ledger, `history.jsonl` for closed ones, `kpi.jsonl` for stats.

## Development

```bash
node tests/smoke.mjs                                  # 31 assertions, temp dirs
node tests/publish-check.mjs .                        # GitHub-release gate
node tests/scan-once.mjs                              # secret scan, read-only
```

`publish-check` fails the build on absolute paths, local user names, host names, API keys, phone numbers and ID numbers — the same class of leak that a report can carry.

## Limitations

- Evidence quality is bounded by the check: a wrong `expectStdout` still "passes" honestly.
- `impact` needs a git work tree; outside git it returns an empty set.
- The watchdog needs a host that supports `agent.followup()`; without it the gate is still enforced by the prompt section.
- Reports contain command output (masked), not a sandbox trace.

## License

[MIT](LICENSE)
