# cc-harness-dashboard

Local, read-only dashboard over `~/.claude` for Claude Code: live sessions per repo, harness concerns, and this machine's share of the account's 5-hour usage limit. Zero dependencies (Node 22, `http` + `fs`), runs in Docker on `127.0.0.1:4317`. Nothing leaves the machine.

## Run

```bash
docker compose up -d --build
open http://127.0.0.1:4317
```

Without Docker: `node server.cjs` (reads `~/.claude` directly).

## Pages

| Path | Shows |
|---|---|
| `/` | Claude sessions per repo: status, intent, subagents, skills, context overhead, activity charts |
| `/concerns` | What the harness wastes (hook/skill token cost per week), with fixes |
| `/usage` | Current 5h session (start → end), account %, this machine's % of it, this machine's active time and tokens |

## API

| Endpoint | Returns |
|---|---|
| `GET /api/state` | Sessions per repo + concerns |
| `GET /api/session/:id` | One session's recent turns |
| `GET /api/stream` | SSE push of `/api/state` on change |
| `GET /api/usage` | 5h windows with account %, this machine's % and token/cost totals |

## Usage page — how the numbers are made

- **Account %** and **window times**: from the cache the `usage-context-awareness` hook writes on the host (`$TMPDIR/ck-usage-limits-cache.json`, source `api/oauth/usage` → `five_hour.utilization`, `resets_at`). Window start = `resets_at − 5h`. Sampled every minute into `/data/usage.json`.
- **This machine's usage**: assistant-message `usage` from `~/.claude/projects/**/*.jsonl`, deduped by message id, priced at API list rates per model and cache tier (API-equivalent $).
- **This machine's %** (estimate): API-equivalent $ × the lowest %-per-$ seen across windows with ≥5% utilisation, capped at the account %. It is accurate once this machine has had one window largely to itself; if machines always overlap, it overstates this machine.

Requires the `usage-context-awareness` hook on the host; without it the page shows no account %.

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
lib/state.cjs           sessions, subagents, skills, concerns from ~/.claude
lib/usage-local.cjs     transcript scan → per-minute cost buckets; account cache reader
lib/usage-view.cjs      window store, calibration, /api/usage payload
shared/harness-diagnose.cjs   concern rules (copy of cc-distribution hooks/lib/harness-diagnose.cjs)
public/                 index / concerns / usage pages, app.css
```
