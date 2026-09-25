#!/usr/bin/env node
/**
 * install.cjs - register hooks/ledger.cjs in ~/.claude/settings.json (SessionStart, UserPromptSubmit, Stop).
 *
 *   node hooks/install.cjs              add the hooks (backs up settings.json first)
 *   node hooks/install.cjs --dry-run    print the resulting hooks block, change nothing
 *   node hooks/install.cjs --uninstall  remove them again
 *
 * Idempotent; leaves every other setting and hook untouched.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.CLAUDE_DIR || path.join(os.homedir(), '.claude');
const SETTINGS = path.join(ROOT, 'settings.json');
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop'];
// Forward slashes work in both Git Bash and cmd, which Claude Code may use to run hooks on Windows.
const SCRIPT = path.join(__dirname, 'ledger.cjs').split(path.sep).join('/');
const COMMAND = `node "${SCRIPT}"`;
const ours = (h) => h && typeof h.command === 'string' && h.command.includes('ledger.cjs') && h.command.includes('agent-monitor');

const dry = process.argv.includes('--dry-run');
const uninstall = process.argv.includes('--uninstall');

let raw = '';
try { raw = fs.readFileSync(SETTINGS, 'utf8'); } catch (_) { /* no settings yet */ }
let settings;
try { settings = raw.trim() ? JSON.parse(raw) : {}; } catch (e) {
  console.error(`${SETTINGS} is not valid JSON (${e.message}); fix it first, nothing changed.`);
  process.exit(1);
}

const hooks = settings.hooks || {};
for (const ev of EVENTS) {
  // Drop any earlier copy of our hook, then add it back once (unless uninstalling).
  const groups = (hooks[ev] || [])
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !ours(h)) }))
    .filter((g) => g.hooks.length);
  if (!uninstall) groups.push({ hooks: [{ type: 'command', command: COMMAND, timeout: 10 }] });
  if (groups.length) hooks[ev] = groups; else delete hooks[ev];
}
if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;

if (dry) {
  console.log(JSON.stringify({ hooks: settings.hooks || {} }, null, 2));
  process.exit(0);
}
if (raw) {
  const backup = `${SETTINGS}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.writeFileSync(backup, raw);
  console.log(`backup: ${backup}`);
}
fs.mkdirSync(ROOT, { recursive: true });
fs.writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
console.log(`${uninstall ? 'removed' : 'installed'} agent-monitor ledger hooks in ${SETTINGS}`);
if (!uninstall) console.log('New Claude Code sessions will write ~/.claude/harness/; restart open ones to pick it up.');
