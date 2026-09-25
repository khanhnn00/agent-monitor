#!/usr/bin/env node
/**
 * ledger.cjs - minimal Claude Code hook that writes the harness ledger agent-monitor reads.
 * One script for three events (hook JSON on stdin):
 *
 *   SessionStart       create harness/sessions/<id>.json; a 'compact' start is logged as a compaction
 *   UserPromptSubmit   open a turn: prompt, start time, transcript offset
 *   Stop               close the turn from the transcript since that offset: model, context start/peak,
 *                      skills, subagents, files edited, commands, tool errors, outcome; bump skill-stats.json
 *
 *                      and the up-front listing (instructions, skills, agents, deferred tools) from the transcript
 *
 * Works on macOS, Linux and Windows. Never blocks Claude: prints nothing and always exits 0.
 * Does not fill `hooks` or the approval gate (cc-distribution only).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = process.env.CLAUDE_DIR || path.join(os.homedir(), '.claude');
const DIR = path.join(ROOT, 'harness', 'sessions');
const STATS = path.join(ROOT, 'harness', 'skill-stats.json');
const KEEP_TURNS = 200;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const AGENT_TOOLS = new Set(['Task', 'Agent']);

const now = () => new Date().toISOString();
const clip = (s, max) => (String(s || '').length > max ? `${String(s).slice(0, max)}…` : String(s || ''));

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

// Write to a temp file and rename, so agent-monitor never reads half a file.
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (_) { return null; }
}

function load(input) {
  const id = String(input.session_id || '').replace(/[^\w-]/g, '');
  if (!id) return null;
  const file = path.join(DIR, `${id}.json`);
  const s = readJson(file, null) || { id, started: now(), turns: [], compactions: [] };
  const cwd = input.cwd || s.cwd || process.cwd();
  if (!s.repo || s.cwd !== cwd) {
    const top = git(cwd, ['rev-parse', '--show-toplevel']);
    s.cwd = cwd;
    // git prints C:/x on Windows; match the separators Claude Code uses for cwd.
    s.repo = top ? path.resolve(top) : cwd;
  }
  s.branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || s.branch || null;
  if (input.transcript_path) s.transcript = input.transcript_path;
  return { s, file };
}

function transcriptSize(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

/** Parse the transcript from `offset` on: everything the current turn produced. */
function readTurn(p, offset) {
  const out = { model: null, ctxStart: 0, ctxPeak: 0, skills: [], agents: [], files: [], commands: [], errors: 0, outcome: '' };
  let text = '';
  try {
    const fd = fs.openSync(p, 'r');
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.max(0, size - offset));
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch (_) { return out; }
  const seen = new Set();
  const files = new Set();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (_) { continue; }
    const m = r.message;
    if (!m || !Array.isArray(m.content)) continue;
    if (m.role === 'assistant') {
      if (m.model && m.model !== '<synthetic>') out.model = m.model;
      // One API message spans several lines, each repeating usage: count it once.
      if (m.usage && !seen.has(m.id)) {
        seen.add(m.id);
        const u = m.usage;
        const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        if (!out.ctxStart) out.ctxStart = ctx;
        out.ctxPeak = Math.max(out.ctxPeak, ctx);
      }
      for (const b of m.content) {
        if (b.type === 'text' && b.text && b.text.trim()) out.outcome = b.text.trim();
        if (b.type !== 'tool_use') continue;
        const x = b.input || {};
        if (b.name === 'Skill' && x.skill) out.skills.push({ name: String(x.skill), via: 'tool', chars: 0 });
        else if (AGENT_TOOLS.has(b.name)) out.agents.push({ type: x.subagent_type || 'agent', desc: clip(x.description, 120) });
        else if (EDIT_TOOLS.has(b.name) && (x.file_path || x.notebook_path)) files.add(x.file_path || x.notebook_path);
        else if (SHELL_TOOLS.has(b.name) && x.command && out.commands.length < 20) out.commands.push(clip(x.command, 200));
      }
    } else if (m.role === 'user') {
      for (const b of m.content) if (b.type === 'tool_result' && b.is_error) out.errors++;
    }
  }
  out.files = [...files];
  out.outcome = clip(out.outcome.split('\n')[0], 300);
  return out;
}

const INSTR_RE = /Contents of ([^\n]+?) \([^\n]*\):\n+([\s\S]*?)(?=\n+Contents of |<\/system-reminder>|$)/g;

/**
 * What the session pays for up front, from the listing attachments Claude Code writes into the transcript.
 * Scans only what was appended since the last Stop; listings arrive as an initial set plus deltas.
 */
function updateListing(s) {
  const size = transcriptSize(s.transcript);
  const from = s.listingOffset && s.listingOffset <= size ? s.listingOffset : 0;
  if (size <= from) return;
  let text = '';
  try {
    const fd = fs.openSync(s.transcript, 'r');
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch (_) { return; }
  const L = s.listing || {};
  const instr = { ...(L.instr || {}) };
  let agents = { ...(L.agents || {}) };
  const tools = { ...(L.tools || {}) };
  let skillChars = L.skillChars || 0;
  let names = L.names || [];
  const lastNl = text.lastIndexOf('\n');
  if (lastNl < 0) return; // the last line is still being written
  for (const line of text.slice(0, lastNl).split('\n')) {
    if (!line.includes('"attachment"') && !line.includes('Contents of ')) continue;
    let r;
    try { r = JSON.parse(line); } catch (_) { continue; }
    const a = r.attachment;
    if (a && a.type === 'skill_listing') {
      if (a.isInitial || !skillChars) { skillChars = 0; names = []; }
      skillChars += String(a.content || '').length;
      names = [...new Set([...names, ...(a.names || [])])];
    } else if (a && a.type === 'agent_listing_delta') {
      if (a.isInitial) agents = {};
      for (const t of a.removedTypes || []) delete agents[t];
      (a.addedTypes || []).forEach((t, i) => { agents[t] = String((a.addedLines || [])[i] || t).length; });
    } else if (a && a.type === 'deferred_tools_delta') {
      for (const t of a.removedNames || []) delete tools[t];
      (a.addedNames || []).forEach((t, i) => { tools[t] = String((a.addedLines || [])[i] || t).length; });
    } else if (a && a.type === 'nested_memory' && a.content) {
      instr[a.path || a.displayPath] = String(a.content.content || '').length;
    } else if (r.type === 'user' && r.message) {
      // CLAUDE.md and rules arrive as "Contents of <path> (...):" sections in a meta user message.
      const c = r.message.content;
      for (const b of typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : []) {
        if (b.type !== 'text' || !b.text || !b.text.includes('Contents of ')) continue;
        for (const m of b.text.matchAll(INSTR_RE)) instr[m[1]] = m[2].trim().length;
      }
    }
  }
  const sum = (o) => Object.values(o).reduce((x, y) => x + y, 0);
  s.listing = {
    instructionChars: sum(instr), skillChars, skills: names.length, names,
    agentChars: sum(agents), toolChars: sum(tools), instr, agents, tools,
  };
  s.listingOffset = from + Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8');
}

/** Prompts carry harness <system-reminder> blocks ahead of what the user typed. */
const userText = (p) => String(p || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();

function bumpSkills(skills, repo) {
  if (!skills.length) return;
  const st = readJson(STATS, null) || { since: now(), skills: {} };
  for (const k of skills) {
    const x = (st.skills[k.name] ||= { count: 0, repos: {}, last: null, chars: 0 });
    x.count++;
    x.repos[repo] = (x.repos[repo] || 0) + 1;
    x.last = now();
  }
  writeJson(STATS, st);
}

function handle(input) {
  const got = load(input);
  if (!got) return;
  const { s, file } = got;
  const event = input.hook_event_name;

  if (event === 'SessionStart') {
    if (input.source === 'compact') s.compactions.push(now());
  } else if (event === 'UserPromptSubmit') {
    const t = { n: s.turns.length ? s.turns[s.turns.length - 1].n + 1 : 1, start: now(), end: null, prompt: clip(userText(input.prompt) || input.prompt, 2000), model: null, outcome: '', skills: [], agents: [], files: [], commands: [], errors: 0, ctxStart: 0, ctxPeak: 0, offset: transcriptSize(s.transcript) };
    s.turns.push(t);
    s.live = { prompt: t.prompt, since: t.start };
  } else if (event === 'Stop') {
    const t = s.turns[s.turns.length - 1];
    if (t && !t.end) {
      Object.assign(t, readTurn(s.transcript, t.offset || 0), { end: now() });
      delete t.offset;
      bumpSkills(t.skills, path.basename(s.repo));
    }
    updateListing(s);
    s.live = null;
  } else {
    return;
  }
  if (s.turns.length > KEEP_TURNS) s.turns = s.turns.slice(-KEEP_TURNS);
  s.updated = now();
  writeJson(file, s);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  // A BOM shows up when the input is piped through Windows PowerShell.
  try { handle(JSON.parse(raw.replace(/^﻿/, ''))); } catch (_) { /* never block Claude */ }
  process.exit(0);
});
