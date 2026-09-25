#!/usr/bin/env node
/**
 * state.cjs - machine-wide snapshot for agent-monitor. Read-only.
 *
 * Sources, host ~/.claude mounted under CLAUDE_DIR:
 *   sessions/<pid>.json                          Claude Code's process registry — a file exists while its process runs
 *   harness/sessions/<id>.json                   harness ledger: turns, skills, subagents, live prompt
 *   harness/skill-stats.json                     skill loads across repos
 *   projects/<slug>/<id>/subagents/*.meta.json   subagent type + description; its transcript mtime = activity
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

let diagnose = () => ({ findings: [], totals: {} });
let group = () => [];
for (const candidate of ['../shared/harness-diagnose.cjs', '../../hooks/lib/harness-diagnose.cjs']) {
  try { ({ diagnose, group } = require(candidate)); break; } catch (_) { /* next location */ }
}

const ROOT = process.env.CLAUDE_DIR || path.join(os.homedir(), '.claude');
// A Windows host home (C:\Users\me or C:/Users/me) stays a Windows path even when read inside a Linux container.
const HOME_IN = process.env.HOST_HOME || os.homedir();
const WIN_HOST = /^[A-Za-z]:[\\/]/.test(HOME_IN);
const HOST_HOME = WIN_HOST ? path.win32.normalize(HOME_IN) : HOME_IN;
const HOST_CLAUDE = (WIN_HOST ? path.win32 : path).join(HOST_HOME, '.claude');
const DAY = 86400000;
const RUNNING_MS = 90000;
const STALL_MS = 60 * 60000; // 'busy' with no hook event, turn or subagent write for this long reads as stalled

const memo = new Map();
function readJson(file) {
  let st;
  try { st = fs.statSync(file); } catch (_) { return null; }
  const hit = memo.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.data;
  let data = null;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* caught mid-write: keep the last good read */ }
  if (data) memo.set(file, { mtime: st.mtimeMs, size: st.size, data });
  return data || (hit && hit.data) || null;
}

const files = (dir, re) => { try { return fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f)); } catch (_) { return []; } };
const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '?';
const tilde = (p) => (p && p.startsWith(HOST_HOME) ? `~${p.slice(HOST_HOME.length)}` : p || '');
const toLocal = (p) => (p && p.startsWith(HOST_CLAUDE) ? path.join(ROOT, ...p.slice(HOST_CLAUDE.length).split(/[\\/]/)) : p);
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const lastTurn = (s) => (s && s.turns && s.turns.length ? s.turns[s.turns.length - 1] : null);
const lastActive = (s) => { const t = lastTurn(s); return (t && t.end) || (s && s.updated) || ''; };
const NOT_INTENT = /^\s*(\[Request interrupted|<task-notification>|Stop hook feedback|\/(clear|compact|model|resume)\b)/i;
// Harness <system-reminder> blocks ride ahead of the typed prompt; older ledger entries still carry them.
const typed = (p) => { const t = String(p || '').replace(/<system-reminder>[\s\S]*?(<\/system-reminder>|$)/g, '').trim(); return t && !NOT_INTENT.test(t) ? t : ''; };
function lastIntent(s) {
  if (!s) return '';
  if (s.live && typed(s.live.prompt)) return typed(s.live.prompt);
  for (let i = s.turns.length - 1; i >= 0; i--) if (typed(s.turns[i].prompt)) return typed(s.turns[i].prompt);
  return '';
}
const ranked = (names) => Object.entries(names.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {}))
  .sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));

function subagents(s) {
  if (!s || !s.transcript) return [];
  const dir = path.join(toLocal(path.dirname(s.transcript)), s.id, 'subagents');
  return files(dir, /\.meta\.json$/).map((meta) => {
    const m = readJson(meta) || {};
    let at = 0;
    try { at = fs.statSync(meta.replace(/\.meta\.json$/, '.jsonl')).mtimeMs; } catch (_) { /* transcript not written yet */ }
    return { type: m.agentType || 'agent', desc: m.description || '', at: iso(at), running: Date.now() - at < RUNNING_MS };
  }).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

function gateView(id, native, t) {
  const g = readJson(path.join(ROOT, 'harness', 'gate', `${String(id).replace(/[^\w-]/g, '')}.json`));
  if (!g) return null;
  const st = g.stats || {};
  // Locked with a review reply other than the protocol's all-clear line = proposals wait for the user.
  const awaiting = Boolean(native) && Boolean(g.locked) && !/^\s*✓ reviewed/.test((t && t.outcome) || '');
  return { awaiting, reviews: st.reviews || 0, checks: st.authChecks || 0, unapproved: st.changesWhileLocked || 0, contractUpdates: st.contractUpdates || 0 };
}

function sessionView(native, s) {
  const t = lastTurn(s);
  const subs = subagents(s);
  const id = native ? native.sessionId : s.id;
  // Claude Code's registry can keep a process 'busy' for days; last real activity decides.
  const seen = [native && iso(native.statusUpdatedAt || native.updatedAt), s && s.live && s.live.since, t && (t.end || t.start), ...subs.filter((x) => x.running).map((x) => x.at)]
    .filter(Boolean).sort().pop() || null;
  const fresh = Boolean(seen) && Date.now() - Date.parse(seen) < STALL_MS;
  const status = !native ? 'ended' : native.status === 'busy' && !fresh ? 'stalled' : native.status || 'idle';
  return {
    id,
    pid: native ? native.pid : null,
    name: (native && native.name) || (s && s.name) || String(id).slice(0, 8),
    kind: (native && native.kind) || (s && s.kind) || null,
    live: Boolean(native),
    status,
    repoKey: (s && s.repo) || (native && native.cwd) || (s && s.cwd) || '?',
    cwd: tilde((native && native.cwd) || (s && s.cwd)),
    startedAt: native ? iso(native.startedAt) : s.started,
    activeAt: seen || lastActive(s),
    model: t ? t.model : null,
    branch: s ? s.branch : null,
    title: s ? s.title : null,
    intent: lastIntent(s),
    turns: s ? s.turns.length : 0,
    ctx: t ? t.ctxPeak || t.ctxStart : 0,
    ctxSeries: s ? s.turns.slice(-24).map((x) => Math.round((x.ctxStart || 0) / 1000)) : [],
    skills: s ? ranked(s.turns.slice(-30).flatMap((x) => x.skills.map((k) => k.name))).slice(0, 6) : [],
    subagents: subs.slice(0, 5),
    subagentsRunning: subs.filter((x) => x.running).length,
    tracked: Boolean(s),
    otherPids: native && native.others ? native.others : [],
    gate: gateView(id, native, t),
  };
}

function buildState() {
  const now = Date.now();
  const since = new Date(now - 7 * DAY).toISOString();
  const since14 = new Date(now - 14 * DAY).toISOString();
  const natives = files(path.join(ROOT, 'sessions'), /^\d+\.json$/).map(readJson).filter((x) => x && x.sessionId);
  // A resumed session can keep its old process alive: one row per session, extra processes listed on it.
  const bySession = new Map();
  const activeMs = (n) => n.statusUpdatedAt || n.updatedAt || 0;
  for (const n of [...natives].sort((a, b) => activeMs(b) - activeMs(a))) {
    const g = bySession.get(n.sessionId);
    if (!g) { bySession.set(n.sessionId, { ...n, others: [] }); continue; }
    g.others.push({ pid: n.pid, status: n.status, activeAt: iso(activeMs(n)) });
    if (n.status === 'busy') g.status = 'busy';
  }
  const primaries = [...bySession.values()];
  const ledger = files(path.join(ROOT, 'harness', 'sessions'), /^[\w-]+\.json$/).map(readJson).filter((s) => s && s.id && Array.isArray(s.turns));
  const byId = new Map(ledger.map((s) => [s.id, s]));
  const liveIds = new Set(natives.map((n) => n.sessionId));
  const views = [
    ...primaries.map((n) => sessionView(n, byId.get(n.sessionId))),
    ...ledger.filter((s) => !liveIds.has(s.id) && lastActive(s) >= since).map((s) => sessionView(null, s)),
  ];

  const repos = new Map();
  for (const v of views) {
    const r = repos.get(v.repoKey) || { key: v.repoKey, name: base(v.repoKey), path: tilde(v.repoKey), sessions: [], prompts7d: 0, skills: [], lastActive: '' };
    r.sessions.push(v);
    if (String(v.activeAt) > r.lastActive) r.lastActive = String(v.activeAt);
    repos.set(v.repoKey, r);
  }

  const promptTimes = [];
  const promptLog = [];
  const activity = [];
  for (const s of ledger) {
    const r = repos.get(s.repo || s.cwd);
    for (const t of s.turns) {
      if (!t.start || !typed(t.prompt)) continue;
      // Enough per prompt for the UI filter to narrow the charts and find sessions by any past prompt.
      if (t.start >= since14) {
        promptLog.push({
          at: t.start, repo: base(s.repo || s.cwd), id: s.id, session: (bySession.get(s.id) || {}).name || s.name || s.id.slice(0, 8),
          prompt: typed(t.prompt).slice(0, 200), skills: t.skills.map((k) => k.name), agents: t.agents.map((a) => a.type),
        });
      }
      if (t.start < since) continue;
      promptTimes.push(t.start);
      activity.push({
        at: t.start, repo: base(s.repo || s.cwd), session: (bySession.get(s.id) || {}).name || s.name || s.id.slice(0, 8), live: liveIds.has(s.id),
        prompt: typed(t.prompt), model: t.model, skills: t.skills.map((k) => k.name), agents: t.agents.map((a) => a.type),
      });
      if (r) {
        r.prompts7d++;
        r.skills.push(...t.skills.map((k) => k.name));
      }
    }
  }

  const repoList = [...repos.values()].map((r) => ({
    ...r,
    skills: ranked(r.skills),
    live: r.sessions.filter((x) => x.live).length,
    busy: r.sessions.filter((x) => x.status === 'busy').length,
    stalled: r.sessions.filter((x) => x.status === 'stalled').length,
    subagentsRunning: r.sessions.reduce((a, x) => a + x.subagentsRunning, 0),
    sessions: r.sessions.sort((a, b) => (b.live - a.live) || ((b.status === 'busy') - (a.status === 'busy')) || String(b.activeAt).localeCompare(String(a.activeAt))),
  })).sort((a, b) => ((b.busy > 0) - (a.busy > 0)) || b.lastActive.localeCompare(a.lastActive));

  const stats = readJson(path.join(ROOT, 'harness', 'skill-stats.json')) || { since: null, skills: {} };
  const week = {};
  for (const a of activity) for (const k of a.skills) week[k] = (week[k] || 0) + 1;
  const names = new Set([...Object.keys(stats.skills), ...Object.keys(week)]);
  const skills = [...names].map((name) => {
    const x = stats.skills[name] || {};
    return { name, week: week[name] || 0, total: Math.max(x.count || 0, week[name] || 0), repos: Object.keys(x.repos || {}), last: x.last || null, chars: x.chars || 0 };
  }).sort((a, b) => (b.week - a.week) || (b.total - a.total));

  const latest = ledger.filter((s) => s.listing && s.listing.skillChars).sort((a, b) => String(lastActive(b)).localeCompare(String(lastActive(a))))[0];
  const overhead = latest ? {
    session: (bySession.get(latest.id) || {}).name || latest.name || latest.id.slice(0, 8),
    instructions: latest.listing.instructionChars || 0,
    skillListing: latest.listing.skillChars || 0,
    skillsListed: latest.listing.skills || 0,
    agentListing: latest.listing.agentChars || 0,
    toolListing: latest.listing.toolChars || 0,
    promptHooks: Object.entries(latest.hooks || {}).filter(([, h]) => h.event === 'UserPromptSubmit' && h.runs)
      .map(([name, h]) => ({ name, avg: Math.round(h.chars / h.runs), runs: h.runs })).sort((a, b) => b.avg - a.avg),
    neverLoaded: (latest.listing.names || []).filter((x) => !stats.skills[x] && !week[x]),
    trackedSince: stats.since,
  } : null;

  const liveIdle = views.filter((v) => v.live).map((v) => ({ name: v.name, pid: v.pid, idleDays: Math.floor((now - Date.parse(v.activeAt || 0)) / DAY) }));
  const { findings, totals: diagTotals } = diagnose(ledger, { days: 14, live: liveIdle });
  for (const r of repoList) r.findings = findings.filter((f) => f.scope === 'repo' && f.target === r.name);
  const sessionOf = {};
  for (const v of views) sessionOf[v.name] = v;
  return {
    generatedAt: new Date(now).toISOString(),
    concerns: group(findings),
    concernTokens: diagTotals.tokensPerWeek || 0,
    totals: {
      live: primaries.length,
      processes: natives.length,
      busy: views.filter((v) => v.status === 'busy').length,
      stalled: views.filter((v) => v.status === 'stalled').length,
      reviews: views.reduce((a, v) => a + (v.gate ? v.gate.reviews : 0), 0),
      awaiting: views.filter((v) => v.gate && v.gate.awaiting).length,
      unapproved: views.reduce((a, v) => a + (v.gate ? v.gate.unapproved : 0), 0),
      contractUpdates: views.reduce((a, v) => a + (v.gate ? v.gate.contractUpdates : 0), 0),
      liveRepos: repoList.filter((r) => r.live).length,
      activeRepos: repoList.length,
      subagentsRunning: views.reduce((a, v) => a + v.subagentsRunning, 0),
      skillLoads7d: activity.reduce((a, x) => a + x.skills.length, 0),
    },
    promptTimes,
    promptLog,
    repos: repoList,
    activity: activity.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40),
    skills,
    overhead,
  };
}

function sessionDetail(id) {
  const s = readJson(path.join(ROOT, 'harness', 'sessions', `${String(id).replace(/[^\w-]/g, '')}.json`));
  if (!s || !Array.isArray(s.turns)) return null;
  return {
    id: s.id, name: s.name, repo: tilde(s.repo || s.cwd), title: s.title, summary: s.summary, branch: s.branch,
    compactions: (s.compactions || []).length,
    turns: s.turns.slice(-25).reverse().map((t) => ({
      n: t.n, start: t.start, end: t.end, model: t.model, prompt: typed(t.prompt) || t.prompt, outcome: t.outcome,
      skills: t.skills.map((k) => ({ name: k.name, via: k.via, chars: k.chars || 0 })), agents: t.agents,
      fileCount: t.files.length, ctxStart: t.ctxStart, ctxPeak: t.ctxPeak, hookChars: (t.injected || 0) + (t.toolInjected || 0),
    })),
  };
}

module.exports = { buildState, sessionDetail };
