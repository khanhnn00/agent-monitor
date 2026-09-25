# agent-monitor

Local read-only dashboard over `~/.claude`: Claude Code sessions per repo, harness concerns, and this machine's share of the account's 5h usage limit. Zero-dependency Node, runs in Docker on `127.0.0.1:4317`; never sends data off the machine.

## Subsystems

1. `server.cjs` — HTTP routes, SSE stream, per-minute usage sampling
2. `lib/state.cjs` — sessions, subagents, skills, concerns (`/api/state`, `/api/session/:id`)
3. `lib/usage-local.cjs` — transcript scan → per-minute API-equivalent cost buckets; host usage-cache reader
4. `lib/usage-view.cjs` — 5h window store (`DATA_DIR/usage.json`), calibration, `/api/usage`
5. `shared/harness-diagnose.cjs` — concern rules used by `state.cjs`
6. `public/` — `index`, `concerns`, `usage` pages; shared `app.css` tokens
7. `hooks/` — optional minimal ledger writer (`ledger.cjs`) and its settings.json installer; must stay silent and exit 0

## Build & Test

- Run: `docker compose up -d --build`; without Docker: `node server.cjs`
- No test suite; verify with `curl -s 127.0.0.1:4317/api/state` / `/api/usage` and a look at `/usage`
- Syntax check: `node --check <file>`

## Conventions

- No npm dependencies; CommonJS `.cjs`; browser JS is plain scripts, no build step
- Pages reuse `app.css` tokens (`--series-*`, `.card`, `.stat`, `.tbl`); usage styles are `.u-*`
- All `~/.claude` mounts are read-only; the only writable state is the `usage-data` volume

## Gotchas

- `shared/harness-diagnose.cjs` is a copy of `cc-distribution/hooks/lib/harness-diagnose.cjs` — changes do not sync
- Account % comes from the host hook's cache in `$TMPDIR`; compose mounts `${TMPDIR:-/tmp}` at `/host-tmp`
- Session `cwd` / transcript paths are host paths: on a Windows host they stay `C:\...` inside the Linux container, so split on both separators (`base()` in `state.cjs`), never `path.basename`
- `five_hour.utilization` is a whole percent; calibration ignores windows under 5%
- This machine's % is an estimate (lowest %-per-$ across windows); it overstates when machines always overlap
- Transcript lines repeat `usage` per content block — dedupe by `message.id`

## Config Toggles

- `PORT`, `HOST`, `CLAUDE_DIR`, `HOST_HOME`, `USAGE_CACHE`, `DATA_DIR` — see README
