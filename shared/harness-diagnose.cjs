#!/usr/bin/env node
/**
 * harness-diagnose.cjs - turns the ledger into findings: what a session or repo is wasting,
 * and what to do about it. Deterministic; no model is called, no I/O.
 *
 * diagnose(sessions, { cfg, days, live }) -> { findings, totals }
 *   finding: { key, severity, scope, target, title, evidence, tokensPerWeek|null, fix }
 * Pure module: no stdin/stdout, no exit codes.
 */
'use strict';

const DAY = 86400000;
const TOK = 4; // chars per token, estimate
const n = (x) => Number(x || 0).toLocaleString('en-US');
const k = (x) => `${Math.round((x || 0) / 1000)}k`;
const perWeek = (chars, days) => Math.round((chars / TOK) * (7 / Math.max(1, days)));

function collect(sessions, since) {
  const repos = new Map();
  for (const s of sessions) {
    const turns = (s.turns || []).filter((t) => t.start && t.start >= since);
    if (!turns.length) continue;
    const name = (s.repo || s.cwd || '?').split('/').filter(Boolean).pop() || '?';
    const r = repos.get(name) || { name, sessions: [], turns: [], files: {}, hooks: {} };
    for (const [hook, h] of Object.entries(s.hooks || {})) {
      const agg = (r.hooks[hook] = r.hooks[hook] || { runs: 0, chars: 0, event: h.event });
      agg.runs += h.runs || 0;
      agg.chars += h.chars || 0;
    }
    r.sessions.push(s);
    r.turns.push(...turns.map((t) => ({ t, s })));
    for (const t of turns) for (const f of t.files || []) r.files[f] = (r.files[f] || 0) + 1;
    repos.set(name, r);
  }
  return [...repos.values()];
}

function diagnose(sessions, { cfg, days = 14, live = [] } = {}) {
  const warn = (cfg && cfg.warn) || {};
  const ctxLimit = warn.contextTokens || 150000;
  const since = new Date(Date.now() - days * DAY).toISOString();
  const repos = collect(sessions, since);
  const findings = [];
  const add = (f) => findings.push({ tokensPerWeek: null, steps: [], ...f });

  // A session that grows past the context limit and never compacts pays for the whole history every turn.
  for (const s of sessions) {
    const turns = (s.turns || []).filter((t) => t.start >= since);
    const over = turns.filter((t) => t.ctxStart > ctxLimit);
    const peak = Math.max(0, ...turns.map((t) => t.ctxPeak || t.ctxStart || 0));
    if (over.length >= 5 && !(s.compactions || []).length) {
      add({
        key: `context:${s.id}`, severity: 'high', scope: 'session', target: s.name || String(s.id).slice(0, 8),
        title: 'Context never cleared',
        evidence: `${over.length}/${turns.length} prompts above ${k(ctxLimit)}, peak ${k(peak)}, no compaction`,
        fix: 'Write the handoff and /clear, or compact, before the next long task',
        steps: [
          `In ${s.name || String(s.id).slice(0, 8)}: write .harness/HANDOFF.md, then /clear — the next session reads the handoff instead of the history`,
          `Every prompt past ${k(peak)} re-reads the whole thread; ${over.length} prompts already did`,
          'Keep /compact for when the thread itself matters; /clear plus the handoff is cheaper',
        ],
      });
    }
  }

  // Hook text is pushed into every prompt and every tool call; it is paid again on each one.
  for (const r of repos) {
    const chars = r.turns.reduce((a, x) => a + (x.t.injected || 0) + (x.t.toolInjected || 0), 0);
    if (chars < 50000) continue;
    add({
      key: `hooks:${r.name}`, severity: chars > 300000 ? 'high' : 'medium', scope: 'repo', target: r.name,
      title: 'Hook text is the largest recurring cost',
      evidence: `${n(chars)} chars over ${r.turns.length} prompts (~${n(Math.round(chars / r.turns.length))} per prompt)`,
      tokensPerWeek: perWeek(chars, days),
      fix: 'Trim or gate the UserPromptSubmit and PreToolUse hooks that inject the most',
      steps: Object.entries(r.hooks).sort((a, b) => b[1].chars - a[1].chars).slice(0, 3)
        .map(([hook, h]) => `${r.name} · ${hook} (${h.event}): ${n(h.chars)} chars over ${h.runs} runs`)
        .concat('Gate the biggest injectors to the prompts that need them, or cut their text — hook text is re-read on every later prompt in the same session, not only when it fires'),
    });
  }

  // Every session pays for the whole skill listing; only the skills actually loaded earn it.
  const latest = sessions.filter((s) => s.listing && s.listing.skillChars).sort((a, b) => String(b.updated).localeCompare(String(a.updated)))[0];
  if (latest) {
    const loaded = new Set();
    for (const r of repos) for (const { t } of r.turns) for (const sk of t.skills || []) loaded.add(sk.name);
    const listed = latest.listing.names || [];
    const idle = listed.filter((x) => !loaded.has(x));
    const starts = sessions.filter((s) => s.started >= since).length || 1;
    if (idle.length > listed.length / 2) {
      add({
        key: 'skills:listing', severity: 'medium', scope: 'machine', target: 'skills',
        title: 'Most listed skills are never loaded',
        evidence: `${idle.length} of ${listed.length} skills unused in ${days} days · listing costs ${n(latest.listing.skillChars)} chars in each of ${starts} sessions`,
        tokensPerWeek: perWeek(latest.listing.skillChars * starts, days),
        fix: 'Move rarely used skills to the repos that need them',
        steps: [
          `Never loaded in ${days} days: ${idle.slice(0, 10).join(', ')}${idle.length > 10 ? `, and ${idle.length - 10} more` : ''}`,
          'Move each one to the repo that uses it (<repo>/.claude/skills) so it leaves the global listing',
          `The listing is re-sent at every session start — ${starts} starts in ${days} days`,
        ],
      });
    }
  }

  // Tool errors burn a full turn each; a cluster means the approach is wrong, not the command.
  for (const r of repos) {
    const bad = r.turns.filter((x) => x.t.errors > 0);
    if (bad.length < 5 || bad.length / r.turns.length < 0.2) continue;
    const worst = bad.sort((a, b) => b.t.errors - a.t.errors)[0];
    add({
      key: `errors:${r.name}`, severity: 'medium', scope: 'repo', target: r.name,
      title: 'Tool calls fail often',
      evidence: `${bad.length}/${r.turns.length} prompts hit tool errors (${bad.reduce((a, x) => a + x.t.errors, 0)} in total); worst prompt #${worst.t.n} with ${worst.t.errors}`,
      fix: 'Read the failing command in the journal before the next attempt',
      steps: bad.sort((a, b) => b.t.errors - a.t.errors).slice(0, 3)
        .map((x) => `${x.s.name || String(x.s.id).slice(0, 8)} prompt #${x.t.n}: ${x.t.errors} errors${x.t.commands && x.t.commands.length ? ` — first command: ${String(x.t.commands[0]).slice(0, 70)}` : ''}`)
        .concat('A cluster in one prompt usually means the approach is wrong, not the command'),
    });
  }

  // The same file rewritten across many separate prompts is rework, not progress.
  for (const r of repos) {
    const churn = Object.entries(r.files).filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]);
    if (!churn.length) continue;
    add({
      key: `rework:${r.name}`, severity: 'low', scope: 'repo', target: r.name,
      title: 'Files rewritten across many prompts',
      evidence: `${churn.length} files touched in 3+ separate prompts; worst ${churn[0][0].split('/').pop()} (${churn[0][1]}×)`,
      fix: 'Agree the shape before editing when a file keeps coming back',
      steps: churn.slice(0, 4).map(([file, count]) => `${file.replace(process.env.HOME || '~', '~')}: ${count} separate prompts`)
        .concat('Settle the structure in one pass before editing when a file keeps returning'),
    });
  }

  // Processes left running keep their session registered and their context alive.
  const stale = live.filter((x) => x.idleDays >= 7);
  if (stale.length) {
    add({
      key: 'sessions:sprawl', severity: 'low', scope: 'machine', target: 'sessions',
      title: 'Sessions left running for days',
      evidence: `${stale.length} live sessions idle 7+ days (oldest ${Math.max(...stale.map((x) => x.idleDays))} days)`,
      fix: 'Close the ones you will not return to',
      steps: stale.sort((a, b) => b.idleDays - a.idleDays).slice(0, 6)
        .map((x) => `${x.name}${x.pid ? ` (pid ${x.pid})` : ''}: idle ${x.idleDays} days`)
        .concat('Each one keeps its registry entry and its process alive'),
    });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.tokensPerWeek || 0) - (a.tokensPerWeek || 0));
  return {
    findings,
    totals: {
      days,
      prompts: repos.reduce((a, r) => a + r.turns.length, 0),
      tokensPerWeek: findings.reduce((a, f) => a + (f.tokensPerWeek || 0), 0),
      high: findings.filter((f) => f.severity === 'high').length,
    },
  };
}

/** One row per rule: targets fold inside, cost adds up. -> [{ rule, title, severity, count, tokensPerWeek, fix, items }] */
function group(findings) {
  const rank = { high: 0, medium: 1, low: 2 };
  const byRule = new Map();
  for (const f of findings) {
    const rule = String(f.key).split(':')[0];
    const g = byRule.get(rule) || { rule, title: f.title, severity: f.severity, fix: f.fix, tokensPerWeek: 0, items: [] };
    g.items.push({ target: f.target, scope: f.scope, evidence: f.evidence, tokensPerWeek: f.tokensPerWeek, steps: f.steps || [] });
    g.tokensPerWeek += f.tokensPerWeek || 0;
    if (rank[f.severity] < rank[g.severity]) g.severity = f.severity;
    byRule.set(rule, g);
  }
  return [...byRule.values()]
    .map((g) => ({ ...g, count: g.items.length, items: g.items.sort((a, b) => (b.tokensPerWeek || 0) - (a.tokensPerWeek || 0)) }))
    .sort((a, b) => rank[a.severity] - rank[b.severity] || b.tokensPerWeek - a.tokensPerWeek);
}

module.exports = { diagnose, group };
