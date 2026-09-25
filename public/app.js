'use strict';
const $ = (sel) => document.querySelector(sel);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
const ui = { scope: 'live', q: '', open: new Set(), details: new Map(), loading: new Set(), allSkills: false, hitIds: new Set(), neverOpen: false, tables: {}, state: null, changedAt: 0, connected: false };

const DAY = 86400000;
function ago(value) {
  if (!value) return '—';
  const s = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const clock = (v) => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const day = (v) => new Date(v).toLocaleDateString([], { month: 'short', day: 'numeric' });
const k = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n || 0));
const tok = (chars) => `~${((chars || 0) / 4000).toFixed(1)}k tok`;
const modelShort = (m) => String(m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
const tier = (m) => (/opus/.test(m) ? 'opus' : /sonnet/.test(m) ? 'sonnet' : /haiku/.test(m) ? 'haiku' : /fable/.test(m) ? 'fable' : 'other');
// Case- and accent-insensitive, so "chay" finds "chạy".
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
const matches = (...fields) => !ui.q || fields.some((f) => fold(f).includes(ui.q));
const chip = (text, cls = '') => `<span class="chip ${cls}">${text}</span>`;
const logHit = (p) => matches(p.repo, p.session, p.prompt, ...(p.skills || []), ...(p.agents || []));

function spark(times) {
  const start = new Date().setHours(0, 0, 0, 0);
  const days = [6, 5, 4, 3, 2, 1, 0].map((i) => times.filter((t) => { const x = Date.parse(t); return x >= start - i * DAY && x < start - i * DAY + DAY; }).length);
  const max = Math.max(...days, 1);
  return { today: days[6], html: `<div class="spark" title="prompts per day, last 7 days">${days.map((n, i) => `<i class="${i === 6 ? 'today' : ''}" style="height:${Math.max(8, (n / max) * 100)}%" title="${n} prompts"></i>`).join('')}</div>` };
}

function renderStats(st) {
  const weekAgo = Date.now() - 7 * DAY;
  const times = ui.q ? st.promptLog.filter((p) => logHit(p) && Date.parse(p.at) >= weekAgo).map((p) => p.at) : st.promptTimes;
  const sp = spark(times);
  const top = st.skills.find((x) => x.week);
  const o = st.overhead;
  const cards = [
    { label: 'Live sessions', value: st.totals.live, sub: `${st.totals.busy} working${st.totals.stalled ? ` · ${st.totals.stalled} stalled` : ''} · ${st.totals.processes} processes`, hi: st.totals.busy > 0 },
    { label: 'Repos', value: st.totals.liveRepos, sub: `${st.totals.activeRepos} active in 7 days` },
    { label: 'Subagents', value: st.totals.subagentsRunning, sub: 'running now · active < 90s' },
    { label: 'Prompts today', value: sp.today, sub: `${times.length} in 7 days${ui.q ? ' · filtered' : ''}`, extra: sp.html },
    { label: 'Skill loads · 7d', value: st.totals.skillLoads7d, sub: top ? `top: ${top.name}` : 'none yet' },
    { label: 'Delivery reviews', value: st.totals.reviews, sub: `${st.totals.awaiting} awaiting approval · ${st.totals.unapproved} unapproved changes · ${st.totals.contractUpdates} contract updates` },
    o && { label: 'Paid per session', value: tok(o.instructions + o.skillListing + o.agentListing + o.toolListing), sub: `${o.skillsListed} skills listed · ${o.neverLoaded.length} never loaded` },
  ].filter(Boolean);
  $('#stats').innerHTML = cards.map((c) => `<div class="stat${c.hi ? ' hi' : ''}"><div class="stat-label">${esc(c.label)}</div><div class="stat-value">${esc(c.value)}</div><div class="stat-sub">${esc(c.sub)}</div>${c.extra || ''}</div>`).join('');
}

function sessionRow(v) {
  const open = ui.open.has(v.id);
  const status = v.live ? v.status : 'ended';
  const subs = v.subagents.filter((a) => a.running || open).slice(0, 4);
  const ctxWarn = v.ctx > 150000 ? ' warn' : '';
  return `<div class="proc ${status}${open ? ' open' : ''}" data-id="${esc(v.id)}">
    <div class="proc-head"><div class="proc-id">
      <span class="dot ${status}" title="${esc(status)}"></span>
      <span class="proc-name">${esc(v.name)}</span>
      ${v.pid ? `<span class="mono muted">pid ${v.pid}</span>` : ''}
      ${v.otherPids.length ? `<span class="tag" title="${esc(v.otherPids.map((o) => `pid ${o.pid} · ${o.status} · ${ago(o.activeAt)}`).join('\n'))}">+${v.otherPids.length} older process${v.otherPids.length > 1 ? 'es' : ''}</span>` : ''}
      ${v.kind && v.kind !== 'interactive' ? `<span class="tag">${esc(v.kind)}</span>` : ''}
      ${v.model ? `<span class="badge ${tier(v.model)}">${esc(modelShort(v.model))}</span>` : ''}
      ${v.branch && v.branch !== 'HEAD' ? `<span class="mono muted">⎇ ${esc(v.branch)}</span>` : ''}
      </div><div class="proc-end">
      <span class="muted when" title="${esc(v.activeAt)}">${{ busy: 'working', stalled: 'stalled · last activity' }[status] || esc(status)} · ${ago(v.activeAt)}</span>
      <button class="toggle" data-expand="${esc(v.id)}" aria-expanded="${open}" title="${open ? 'Collapse' : 'Show recent turns'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></button>
    </div></div>
    <div class="intent${v.intent ? '' : ' none'}">${v.intent ? esc(v.intent) : `<em class="muted">${v.tracked ? 'no prompt recorded' : 'not tracked yet — recorded from its next prompt'}</em>`}</div>
    <div class="proc-meta">
      ${v.title ? `<span class="muted">${esc(v.title)}</span><span class="sep">·</span>` : ''}
      <span class="muted">${v.turns} prompts</span>
      ${v.gate && v.gate.awaiting ? chip('awaiting your approval', 'await') : ''}
      ${v.gate && v.gate.unapproved ? chip(`${v.gate.unapproved} unapproved change${v.gate.unapproved > 1 ? 's' : ''}`, 'err') : ''}
      ${v.gate && v.gate.reviews ? `<span class="muted" title="delivery reviews · change checks">· ${v.gate.reviews} reviews · ${v.gate.checks} checks</span>` : ''}
      ${v.ctx ? `<span class="sep">·</span><span class="ctx${ctxWarn}" title="context per prompt (k tokens): ${v.ctxSeries.join(' · ')}">${Charts.sparkline(v.ctxSeries)}<span class="mono">${k(v.ctx)}</span></span>` : ''}
      ${v.subagentsRunning ? chip(`● ${v.subagentsRunning} subagent${v.subagentsRunning > 1 ? 's' : ''} running`, 'run') : ''}
      ${v.skills.map((s) => chip(`${esc(s.name)}${s.n > 1 ? ` <b>×${s.n}</b>` : ''}`)).join('')}
    </div>
    ${subs.length ? `<div class="subs">${subs.map((a) => `<div class="sub"><span class="dot ${a.running ? 'busy' : 'ended'}"></span><span class="mono">${esc(a.type)}</span><span class="muted desc">${esc(a.desc)}</span><span class="spacer"></span><span class="muted">${ago(a.at)}</span></div>`).join('')}</div>` : ''}
    ${open ? `<div class="timeline">${renderDetail(v.id)}<button class="link collapse" data-expand="${esc(v.id)}">Collapse ↑</button></div>` : ''}
  </div>`;
}

function repoCard(r) {
  const sessions = r.sessions.filter((v) => (ui.scope === 'all' || v.live)
    && (matches(r.name, r.path, v.name, v.intent, v.title, v.branch, ...v.skills.map((s) => s.name), ...v.subagents.map((a) => a.type))
      || ui.hitIds.has(v.id)));
  if (!sessions.length) return '';
  return `<article class="repo">
    <header class="repo-head">
      <div><div class="repo-name">${esc(r.name)}</div><div class="mono muted">${esc(r.path)}</div></div>
      <div class="repo-badges">
        ${r.busy ? `<span class="pill busy">${r.busy} working</span>` : ''}
        ${r.stalled ? `<span class="pill stalled">${r.stalled} stalled</span>` : ''}
        ${r.live ? `<span class="pill live">${r.live} live</span>` : '<span class="pill">no live session</span>'}
        ${r.subagentsRunning ? `<span class="pill run">${r.subagentsRunning} subagents</span>` : ''}
      </div>
    </header>
    <div class="procs">${sessions.map(sessionRow).join('')}</div>
    <footer class="repo-foot"><span class="muted">${r.prompts7d} prompts · 7d</span>${r.skills.slice(0, 6).map((s) => chip(`${esc(s.name)} <b>${s.n}</b>`, 'soft')).join('') || '<span class="muted">· no skills loaded</span>'}</footer>
  </article>`;
}

function renderDetail(id) {
  const d = ui.details.get(id);
  if (!d) { loadDetail(id); return '<div class="skeleton short"></div>'; }
  if (d.error) return `<div class="empty">${esc(d.error)}</div>`;
  if (!d.turns.length) return '<div class="empty">No turns recorded.</div>';
  return d.turns.map((t) => `<div class="turn">
    <div class="turn-head"><span class="mono">#${t.n}</span><span class="muted">${day(t.start)} ${clock(t.start)}</span>${t.model ? `<span class="badge ${tier(t.model)}">${esc(modelShort(t.model))}</span>` : ''}<span class="spacer"></span><span class="mono muted" title="context at start → peak">${k(t.ctxStart)} → ${k(t.ctxPeak)}</span></div>
    <div class="turn-prompt">${esc(t.prompt)}</div>
    <div class="chips">${t.skills.map((s) => chip(`${esc(s.name)} <span class="muted">${esc(s.via)}${s.chars ? ` · ${k(s.chars)}` : ''}</span>`)).join('')}${t.agents.map((a) => `<span class="chip agent" title="${esc(a.desc)}">${esc(a.type)}</span>`).join('')}${t.fileCount ? chip(`${t.fileCount} file${t.fileCount > 1 ? 's' : ''}`, 'soft') : ''}${t.hookChars ? chip(`hooks ${k(t.hookChars)} chars`, 'soft') : ''}</div>
    ${t.outcome ? `<div class="turn-out">${esc(t.outcome)}</div>` : ''}
  </div>`).join('');
}

async function loadDetail(id) {
  if (ui.loading.has(id)) return;
  ui.loading.add(id);
  try {
    const r = await fetch(`/api/session/${encodeURIComponent(id)}`);
    ui.details.set(id, r.ok ? { ...(await r.json()), fetchedAt: Date.now() } : { error: 'No turns recorded for this session yet.', fetchedAt: Date.now() });
  } catch (err) {
    ui.details.set(id, { error: String(err.message || err), fetchedAt: Date.now() });
  } finally {
    ui.loading.delete(id);
    render();
  }
}

function renderActivity(st) {
  const items = st.activity.filter((a) => (ui.scope === 'all' || a.live) && matches(a.repo, a.session, a.prompt, ...a.skills, ...a.agents)).slice(0, 25);
  $('#activity').innerHTML = items.map((a) => `<li>
    <div class="feed-head"><span class="mono muted">${day(a.at)} ${clock(a.at)}</span><span class="feed-src">${esc(a.repo)} <span class="muted">· ${esc(a.session)}</span></span></div>
    <div class="feed-prompt">${esc(a.prompt)}</div>
    ${a.skills.length || a.agents.length ? `<div class="chips">${a.skills.map((x) => chip(esc(x))).join('')}${a.agents.map((x) => chip(esc(x), 'agent')).join('')}</div>` : ''}
  </li>`).join('') || '<li class="empty">No prompts in this scope.</li>';
}

function renderSkills(st) {
  const rows = st.skills.filter((x) => matches(x.name, ...x.repos));
  if (!rows.length) { $('#skills').innerHTML = '<div class="empty">No skill loads recorded.</div>'; return; }
  const shown = ui.allSkills ? rows : rows.slice(0, 8);
  const maxLoads = Math.max(1, ...rows.map((x) => x.total));
  $('#skills').innerHTML = `<table class="tbl"><thead><tr><th>Skill</th><th class="num">7d</th><th>All</th><th class="num">Body</th></tr></thead><tbody>${shown.map((x) => `<tr>
    <td><span class="mono">${esc(x.name)}</span><div class="muted small">${esc(x.repos.slice(0, 3).join(', ') || '—')}</div></td>
    <td class="num">${x.week || '—'}</td><td class="bar-cell"><span class="cell-bar"><i style="width:${(x.total / maxLoads) * 100}%"></i></span><span class="num-v">${x.total}</span></td><td class="num mono">${x.chars ? k(x.chars) : '—'}</td></tr>`).join('')}</tbody></table>
    ${rows.length > 8 ? `<button class="link" data-toggle="skills">${ui.allSkills ? 'Show less' : `See all ${rows.length}`}</button>` : ''}`;
}

function renderOverhead(st) {
  const o = st.overhead;
  if (!o) { $('#overhead').innerHTML = '<div class="empty">No session recorded yet.</div>'; return; }
  $('#overhead-src').textContent = `from ${o.session}`;
  const hooks = o.promptHooks.reduce((a, h) => a + h.avg, 0);
  const rows = [
    ['Instructions', 'CLAUDE.md + rules', o.instructions, 'session'],
    ['Skill listing', `${o.skillsListed} skills`, o.skillListing, 'session'],
    ['Agent listing', 'subagent types', o.agentListing, 'session'],
    ['Tool listing', 'deferred tools', o.toolListing, 'session'],
    ['Prompt hooks', o.promptHooks.slice(0, 3).map((h) => h.name.replace(/\.cjs$/, '')).join(', '), hooks, 'prompt'],
  ];
  const max = Math.max(...rows.map((r) => r[2] || 0), 1);
  const never = o.neverLoaded;
  $('#overhead').innerHTML = `<div class="bars">${rows.map(([label, sub, chars, per]) => `<div>
      <div class="bar-label"><span>${esc(label)}</span><span class="mono">${tok(chars)}<span class="muted"> / ${per}</span></span></div>
      <div class="bar"><i class="${per}" style="width:${((chars || 0) / max) * 100}%"></i></div>
      ${sub ? `<div class="muted small">${esc(sub)}</div>` : ''}</div>`).join('')}</div>
    ${never.length ? `<button class="link" data-toggle="never">${ui.neverOpen ? 'Hide' : 'Show'} ${never.length} listed skills never loaded${o.trackedSince ? ` since ${day(o.trackedSince)}` : ''}</button>
    ${ui.neverOpen ? `<div class="chips">${never.map((x) => chip(esc(x), 'soft')).join('')}</div>` : ''}` : ''}
    <div class="muted small note">Tokens estimated at 4 characters each.</div>`;
}

function renderCharts(st) {
  const midnight = new Date().setHours(0, 0, 0, 0);
  const bucket = (iso, span) => Math.floor((new Date(iso).setHours(0, 0, 0, 0) - (midnight - (span - 1) * DAY)) / DAY);
  // Top four repos keep slots 1-4; everything else folds into Other (silver).
  // Slots come from the unfiltered log so a repo keeps its color while the filter narrows the counts.
  const log = ui.q ? st.promptLog.filter(logHit) : st.promptLog;
  const totals = {};
  for (const p of st.promptLog) totals[p.repo] = (totals[p.repo] || 0) + 1;
  const top = Object.entries(totals).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4).map(([r]) => r);
  const keys = Object.keys(totals).length > top.length ? [...top, 'Other'] : [...top];
  const all = keys.map((key, i) => ({ key, color: key === 'Other' ? 'var(--series-other)' : `var(--series-${i + 1})`, values: Array(14).fill(0) }));
  for (const p of log) {
    const d = bucket(p.at, 14);
    if (d < 0 || d > 13 || !all.length) continue;
    const idx = top.indexOf(p.repo);
    all[idx >= 0 ? idx : all.length - 1].values[d]++;
  }
  const series = ui.q ? all.filter((s) => s.values.some(Boolean)) : all;
  const days = Array.from({ length: 14 }, (_, i) => new Date(midnight - (13 - i) * DAY));
  if (ui.tables['table-prompts']) {
    $('#chart-prompts').innerHTML = `<div class="viz-table"><table><thead><tr><th>Day</th>${series.map((s) => `<th>${esc(s.key)}</th>`).join('')}<th>Total</th></tr></thead><tbody>${days.map((d, i) => `<tr><td>${day(d)}</td>${series.map((s) => `<td>${s.values[i] || '—'}</td>`).join('')}<td>${series.reduce((a, s) => a + s.values[i], 0)}</td></tr>`).reverse().join('')}</tbody></table></div>`;
  } else {
    Charts.stackedColumns($('#chart-prompts'), { days, series });
  }
  $('#legend-prompts').innerHTML = series.map((s) => `<span class="key"><i style="background:${s.color}"></i>${esc(s.key)}</span>`).join('') || `<span class="muted small">${ui.q ? 'no prompts match the filter' : 'no prompts recorded'}</span>`;

  const hours = Array.from({ length: 7 }, (_, i) => ({ date: new Date(midnight - (6 - i) * DAY), counts: Array(24).fill(0) }));
  for (const p of log) {
    const d = bucket(p.at, 7);
    if (d >= 0 && d < 7) hours[d].counts[new Date(p.at).getHours()]++;
  }
  if (ui.tables['table-hours']) {
    $('#chart-hours').innerHTML = `<div class="viz-table"><table><thead><tr><th>Day</th>${Array.from({ length: 24 }, (_, h) => `<th>${String(h).padStart(2, '0')}</th>`).join('')}</tr></thead><tbody>${hours.map((r) => `<tr><td>${day(r.date)}</td>${r.counts.map((c) => `<td>${c || '—'}</td>`).join('')}</tr>`).reverse().join('')}</tbody></table></div>`;
  } else {
    Charts.heatmap($('#chart-hours'), { rows: hours });
  }
  const busiest = Math.max(1, ...hours.flatMap((r) => r.counts));
  $('#legend-hours').innerHTML = `<span class="muted small">none</span><span class="ramp">${[0, 1, 2, 3, 4, 5].map((l) => `<i class="seq seq-${l}"></i>`).join('')}</span><span class="muted small">${busiest} in an hour</span>`;
}

function render() {
  const st = ui.state;
  if (!st) return;
  // Sessions with any prompt in the last 14 days that matches, not only their latest one.
  ui.hitIds = new Set(ui.q ? st.promptLog.filter(logHit).map((p) => p.id) : []);
  renderStats(st);
  renderCharts(st);
  const cards = st.repos.map(repoCard).filter(Boolean);
  $('#repos').innerHTML = cards.join('') || `<div class="empty big">${ui.q ? 'Nothing matches the filter.' : ui.scope === 'live' ? 'No Claude Code session is running.' : 'Nothing recorded in the last 7 days.'}</div>`;
  $('#repo-count').textContent = `${cards.length} repo${cards.length === 1 ? '' : 's'}`;
  renderActivity(st);
  renderSkills(st);
  renderOverhead(st);
}

function tick() {
  $('#pulse').classList.toggle('on', ui.connected);
  $('#updated').textContent = !ui.connected ? 'reconnecting…' : ui.state ? `live · last change ${ago(ui.changedAt)}` : 'connecting…';
}

const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#theme').innerHTML = theme === 'dark' ? SUN : MOON;
  try { localStorage.setItem('harness-theme', theme); } catch (_) { /* private mode */ }
}

function toggleOpen(id) {
  if (ui.open.has(id)) ui.open.delete(id);
  else { ui.open.add(id); ui.details.delete(id); }
  render();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.open.size) { ui.open.clear(); render(); } });
document.addEventListener('click', (e) => {
  const scope = e.target.closest('[data-scope]');
  if (scope) {
    ui.scope = scope.dataset.scope;
    document.querySelectorAll('[data-scope]').forEach((b) => b.classList.toggle('active', b === scope));
    render();
    return;
  }
  const toggle = e.target.closest('[data-toggle]');
  if (toggle) {
    const which = toggle.dataset.toggle;
    if (which === 'skills') ui.allSkills = !ui.allSkills;
    else if (which === 'never') ui.neverOpen = !ui.neverOpen;
    else ui.tables[which] = !ui.tables[which];
    render();
    return;
  }
  const expand = e.target.closest('[data-expand]');
  if (expand) { toggleOpen(expand.dataset.expand); return; }
  if (e.target.closest('#theme')) { applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); return; }
  const head = e.target.closest('.proc-head, .proc:not(.open)');
  if (!head || String(window.getSelection())) return;
  toggleOpen(head.closest('.proc').dataset.id);
});
$('#search').addEventListener('input', (e) => { ui.q = fold(e.target.value.trim()); render(); });

function connect() {
  const es = new EventSource('/api/stream');
  es.onopen = () => { ui.connected = true; tick(); };
  es.onmessage = (e) => {
    ui.state = JSON.parse(e.data);
    ui.changedAt = Date.now();
    ui.connected = true;
    for (const id of ui.open) {
      const d = ui.details.get(id);
      if (d && Date.now() - d.fetchedAt > 4000) ui.details.delete(id);
    }
    render();
    tick();
  };
  es.onerror = () => { ui.connected = false; tick(); };
}

let saved = null;
try { saved = localStorage.getItem('harness-theme'); } catch (_) { /* private mode */ }
const forced = new URLSearchParams(location.search).get('theme');
applyTheme(/^(light|dark)$/.test(forced || '') ? forced : saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('#year').textContent = new Date().getFullYear();
const deepLink = decodeURIComponent(location.hash.replace(/^#open=/, ''));
if (/^[\w-]{8,64}$/.test(deepLink)) ui.open.add(deepLink);
setInterval(tick, 1000);
setInterval(render, 30000);
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); });
if (new URLSearchParams(location.search).has('snapshot')) {
  fetch('/api/state').then((r) => r.json()).then((st) => { ui.state = st; ui.changedAt = Date.now(); ui.connected = true; render(); tick(); });
} else {
  connect();
}
