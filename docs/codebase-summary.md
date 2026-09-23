# Codebase Summary

Zero-dependency Node 22 server plus static pages. Everything is read from a read-only `~/.claude` mount; the only write is the usage sample store.

## Data flow

```
~/.claude/sessions/<pid>.json ─┐
~/.claude/harness/sessions/*.json ─┼─> lib/state.cjs ──> /api/state, /api/stream (SSE), /api/session/:id ──> public/app.js, concerns.js
~/.claude/harness/skill-stats.json ─┘        └─ shared/harness-diagnose.cjs (concerns)

~/.claude/projects/**/*.jsonl ────> lib/usage-local.cjs (per-minute cost buckets) ─┐
$TMPDIR/ck-usage-limits-cache.json > lib/usage-local.cjs (account 5h / 7d %) ──────┼─> lib/usage-view.cjs ──> /api/usage ──> public/usage.js
                                     DATA_DIR/usage.json (window samples) <────────┘
```

## Modules

| File | Role |
|---|---|
| `server.cjs` | Routes (`/`, `/concerns`, `/usage`, `/api/*`), static files from `public/`, 1.5s state snapshot cache, SSE push every 3s on change, usage sampling every 60s |
| `lib/state.cjs` | Joins Claude's process registry (`sessions/<pid>.json`) with the harness ledger: one row per session grouped by repo, status (busy / stalled / idle), prompts and skill loads over 7 and 14 days, context overhead of the latest session, concerns |
| `shared/harness-diagnose.cjs` | Concern rules (`diagnose`, `group`); copy of `cc-distribution/hooks/lib/harness-diagnose.cjs` |
| `lib/usage-local.cjs` | Scans transcripts modified in the last 8 days, dedupes assistant messages by `message.id`, prices `usage` at API list rates → per-minute buckets. Parsed files are cached by size+mtime. Reads the host hook's usage cache |
| `lib/usage-view.cjs` | Stores the latest account sample per 5h window (keyed by `resets_at` rounded to the minute, kept 8 days; history only feeds calibration). Calibrates %-per-$ as the minimum over windows ≥5%; this machine's % = cost up to the sample × rate, capped at the account % |
| `public/` | `index.html`/`app.js`/`charts.js` (sessions), `concerns.*`, `usage.*`; shared tokens and components in `app.css`; theme stored in `localStorage` |

## Pricing weights (`lib/usage-local.cjs`)

| Model prefix | Input $/MTok | Output $/MTok |
|---|---|---|
| `claude-fable`, `claude-mythos` | 10 | 50 |
| `claude-opus-5-5` | 4 | 20 |
| `claude-opus` (other; also unknown models) | 5 | 25 |
| `claude-sonnet-5` | 2 | 10 |
| `claude-sonnet` (other) | 3 | 15 |
| `claude-haiku` | 1 | 5 |

Cache write 5m ×1.25, 1h ×2, cache read ×0.1 of the input rate.

## Runtime

- Docker: `docker-compose.yml` publishes `127.0.0.1:4317`, mounts `~/.claude/{sessions,harness,projects}` read-only, `${TMPDIR:-/tmp}` at `/host-tmp` read-only, and the `usage-data` volume at `/data`
- Health check: `GET /api/state`
