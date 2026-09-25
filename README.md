# agent-monitor

Local, read-only monitor for Claude Code over `~/.claude`: live sessions per repo, activity, skills, context overhead, harness concerns, and this machine's share of the account's 5-hour usage limit. Zero dependencies (Node 22, `http` + `fs`), runs in Docker on `127.0.0.1:4317`. Nothing leaves the machine.

## Run

```bash
docker compose up -d --build
open http://127.0.0.1:4317
```

Without Docker: `node server.cjs` (reads `~/.claude` directly).

### Windows

Run it with Node directly; no Docker needed. In PowerShell:

```powershell
winget install OpenJS.NodeJS.LTS   # Node 22+, if missing
winget install Git.Git             # then open a new terminal so both are on PATH
git clone https://github.com/khanhnn00/agent-monitor
cd agent-monitor
node server.cjs
Start-Process http://127.0.0.1:4317
```

- Data is read from `%USERPROFILE%\.claude`; the account usage cache from `%TEMP%\ck-usage-limits-cache.json`.
- `git clone` fails with `Filename too long` under deep folders: add `-c core.longpaths=true`.
- To start it at logon, register a scheduled task (run once, from the repo folder):

  ```powershell
  $a = New-ScheduledTaskAction -Execute (Get-Command node).Source -Argument 'server.cjs' -WorkingDirectory $PWD
  Register-ScheduledTask agent-monitor -Action $a -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0)
  ```

  Stop or remove it with `Stop-ScheduledTask agent-monitor` / `Unregister-ScheduledTask agent-monitor`.

With Docker Desktop, `HOME` and `TMPDIR` are usually unset on Windows, so set them in a `.env` file next to `docker-compose.yml` before `docker compose up -d --build`:

```ini
HOME=C:/Users/<you>
TMPDIR=C:/Users/<you>/AppData/Local/Temp
```

## Features

### Dashboard — `/`

Updates live over Server-Sent Events. **Live / Last 7 days** switch and a filter box (repo, session, prompt, skill) apply to every panel.

- **Totals**: live sessions (working · stalled · process count), repos live / active in 7 days, subagents running now, prompts today with a 7-day sparkline, skill loads in 7 days and the top skill, delivery reviews (awaiting approval · unapproved changes · contract updates), context paid per session.
- **Charts**: prompts per day for 14 days stacked by repo, and a day × hour activity heatmap for 7 days; each has a table view.
- **Repos**: one card per repo with working / stalled / live / subagent badges, prompts in 7 days and top skills. Each session row shows:
  - status: working, idle, stalled (busy with no activity for 60 min) or ended; pid and older processes still attached
  - session kind, model, git branch, last activity
  - the latest real prompt (intent), session title, prompt count
  - approval-gate chips: awaiting your approval, unapproved changes, review and check counts
  - context size per prompt as a sparkline, highlighted above 150k tokens
  - running subagents with type and description; skills loaded in the last 30 prompts
  - expandable timeline of the last 25 turns: number, time, model, context start → peak, prompt, skills (how loaded, size), subagents, outcome
- **Activity**: the latest 25 prompts across repos with their skills and subagents.
- **Skills**: loads per skill over 7 days and all time.
- **Context paid up front**: tokens spent on instructions (CLAUDE.md + rules), skill listing, agent listing, tool listing and prompt hooks; plus listed skills that were never loaded.

### Concerns — `/concerns`

Findings from the last 14 days, grouped by rule, with severity, the repos/sessions affected, estimated tokens per week and how-to-fix steps; filterable.

| Rule | Flags when |
|---|---|
| Context never cleared | 5+ prompts in a session start above the context limit and it was never compacted |
| Hook text is the largest recurring cost | Hooks injected 50k+ characters into a repo's prompts |
| Most listed skills are never loaded | More than half of the listed skills were not loaded in the period |
| Tool calls fail often | 5+ prompts, and at least 20% of a repo's prompts, hit tool errors |
| Files rewritten across many prompts | A file was touched in 3+ separate prompts |
| Sessions left running for days | A live session has been idle for 7+ days |

### Usage — `/usage`

The current 5-hour session and how much of it this machine used:

- session start → end and time to reset
- account usage % for the session
- this machine's % of the session limit, and its share of the account's usage
- this machine's active time, message count, input/output tokens and API-equivalent cost

How the numbers are made:

- **Account %** and **session times**: from the cache the `usage-context-awareness` hook writes on the host (`$TMPDIR/ck-usage-limits-cache.json`, source `api/oauth/usage` → `five_hour.utilization`, `resets_at`). Start = `resets_at − 5h`. Sampled every minute into `/data/usage.json`.
- **This machine's tokens**: assistant-message `usage` from `~/.claude/projects/**/*.jsonl`, deduped by message id, priced at API list rates per model and cache tier.
- **This machine's %** (estimate): API-equivalent $ × the lowest %-per-$ seen across sessions with ≥5% utilisation, capped at the account %. Accurate once this machine has had one session largely to itself; if machines always overlap, it overstates this machine.

## Data sources

| Path | Written by | Feeds |
|---|---|---|
| `~/.claude/sessions/<pid>.json` | Claude Code | live sessions, status, pids |
| `~/.claude/projects/**/*.jsonl` | Claude Code | subagents, usage tokens |
| `~/.claude/harness/sessions/<id>.json` | cc-distribution harness hooks | turns, prompts, skills, context, hooks, concerns |
| `~/.claude/harness/skill-stats.json` | cc-distribution harness hooks | skill loads all time |
| `~/.claude/harness/gate/<id>.json` | cc-distribution approval gate | review / approval chips |
| `$TMPDIR/ck-usage-limits-cache.json` | `usage-context-awareness` hook | account usage % |

Without the cc-distribution hooks, only live sessions, subagents and token usage are shown.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/state` | Totals, repos and sessions, activity, skills, overhead, concerns |
| `GET /api/session/:id` | One session's last 25 turns |
| `GET /api/stream` | SSE push of `/api/state` on change |
| `GET /api/usage` | 5h sessions with account %, this machine's % and token/cost totals |

## Configuration

| Env | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `4317` / `127.0.0.1` (`0.0.0.0` in the image) | Listen address |
| `CLAUDE_DIR` | `~/.claude` (`/claude` in the image) | Data root, mounted read-only |
| `HOST_HOME` | `$HOME` | Host home, for mapping container paths back to host paths |
| `USAGE_CACHE` | `$TMPDIR/ck-usage-limits-cache.json` | Account usage cache written by the host hook |
| `DATA_DIR` | `./data` (`/data` volume in the image) | Stored account samples for the usage page |

## Layout

```
server.cjs              HTTP server, routes, SSE, per-minute usage sampling
lib/state.cjs           sessions, subagents, skills, overhead, concerns from ~/.claude
lib/usage-local.cjs     transcript scan → per-minute cost buckets; account cache reader
lib/usage-view.cjs      session store, calibration, /api/usage payload
shared/harness-diagnose.cjs   concern rules (copy of cc-distribution hooks/lib/harness-diagnose.cjs)
public/                 index / concerns / usage pages, charts.js, app.css
```
