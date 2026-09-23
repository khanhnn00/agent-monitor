'use strict';
const $ = (sel) => document.querySelector(sel);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n || 0));
const pct = (n) => `${n >= 10 ? Math.round(n) : n.toFixed(1)}%`;
const hm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const day = (t) => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`; };
const left = (t) => { const m = Math.max(0, Math.round((t - Date.now()) / 60000)); return `${Math.floor(m / 60)}h ${m % 60}m`; };
const MINE = 'var(--series-1)';
const OTHERS = 'var(--series-other)';
const est = (w) => w.minePercent != null;

/** Account bar: this machine's slice, then everyone else's, the rest of 100% left empty. */
function meter(w, tall) {
  const segs = est(w)
    ? `<span class="u-seg" style="width:${w.minePercent}%;background:${MINE}" title="This machine · ${pct(w.minePercent)}"></span>${w.othersPercent < 0.05 ? "" : `<span class="u-seg" style="width:${w.othersPercent}%;background:${OTHERS}" title="Other machines · ${pct(w.othersPercent)}"></span>`}`
    : `<span class="u-seg" style="width:${w.utilization}%;background:${OTHERS}"></span>`;
  return `<div class="u-meter${tall ? ' tall' : ''}" role="img" aria-label="${pct(w.utilization)} of the 5-hour limit used">${segs}</div>`;
}

const legend = (w) => (est(w)
  ? `<span class="u-key"><i style="background:${MINE}"></i>This machine <b>${pct(w.minePercent)}</b></span><span class="u-key"><i style="background:${OTHERS}"></i>Other machines <b>${pct(w.othersPercent)}</b></span>`
  : '<span class="muted">Not calibrated yet — needs one window at ≥5% with activity here.</span>');

function current(v) {
  const w = v.windows.find((x) => x.current);
  if (!w) return '<div class="card empty big">No sample for the current 5-hour window yet — it appears after the next prompt on this machine.</div>';
  const m = w.mine;
  const weekly = v.weekly ? `<div class="stat"><div class="stat-label">Weekly · account</div><div class="stat-value">${pct(v.weekly.utilization)}</div><div class="stat-sub">resets ${day(v.weekly.resetsAt)} ${hm(v.weekly.resetsAt)}</div></div>` : '';
  return `<div class="stats">
      <div class="stat hi"><div class="stat-label">Current session</div><div class="stat-value">${hm(w.start)} → ${hm(w.end)}</div><div class="stat-sub">${day(w.start)} · resets in ${left(w.end)}</div></div>
      <div class="stat"><div class="stat-label">Account used</div><div class="stat-value">${pct(w.utilization)}</div><div class="stat-sub">sampled ${ago(w.sampledAt)}</div></div>
      <div class="stat"><div class="stat-label">This machine</div><div class="stat-value">${est(w) ? pct(w.minePercent) : '—'}</div><div class="stat-sub">${est(w) ? `others ${pct(w.othersPercent)}` : 'not calibrated yet'}</div></div>
      ${weekly}
    </div>
    <div class="card u-now">
      ${meter(w, true)}
      <div class="u-legend">${legend(w)}</div>
      <table class="tbl u-tbl"><thead><tr><th>This machine</th><th class="num">Msgs</th><th class="num">In / out tok</th><th class="num">API-equiv.</th><th class="num">Active</th></tr></thead><tbody><tr>
        <td>${m.messages ? 'Claude Code on this machine' : '<span class="muted">No activity here this window</span>'}</td>
        <td class="num">${m.messages}</td>
        <td class="num mono">${k(m.input + m.cacheWrite + m.cacheRead)} / ${k(m.output)}</td>
        <td class="num mono">$${m.cost.toFixed(2)}</td>
        <td class="num mono">${m.first ? `${hm(m.first)}–${hm(m.last + 60000)}` : '—'}</td>
      </tr></tbody></table>
    </div>`;
}

function history(v) {
  const past = v.windows.filter((w) => !w.current);
  if (!past.length) return '<div class="empty">No finished windows recorded yet.</div>';
  return `<div class="u-hist">${past.map((w) => `<div class="u-row">
    <div class="u-when"><b>${day(w.start)}</b> <span class="mono">${hm(w.start)}–${hm(w.end)}</span></div>
    <div class="u-bar">${meter(w)}</div>
    <div class="num"><b>${pct(w.utilization)}</b></div>
    <div class="u-legend small">${legend(w)}</div>
  </div>`).join('')}</div>`;
}

function render(v) {
  const c = v.calibration;
  $('#summary').innerHTML = `<i></i><span>${c ? `${c.percentPerDollar.toFixed(2)}% per $ · from ${day(c.fromWindowEnd - 5 * 3600000)} ${hm(c.fromWindowEnd - 5 * 3600000)}` : 'not calibrated yet'}</span>`;
  $('#current').innerHTML = current(v);
  $('#history').innerHTML = history(v);
}

async function load() {
  try {
    const r = await fetch('/api/usage');
    const v = await r.json();
    if (!r.ok) throw new Error(v.error || r.status);
    render(v);
  } catch (err) {
    $('#current').innerHTML = `<div class="card empty big">${esc(err.message || err)}</div>`;
  }
}

const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#theme').innerHTML = theme === 'dark' ? SUN : MOON;
  try { localStorage.setItem('harness-theme', theme); } catch (_) { /* private mode */ }
}
$('#theme').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

let saved = null;
try { saved = localStorage.getItem('harness-theme'); } catch (_) { /* private mode */ }
const forced = new URLSearchParams(location.search).get('theme');
applyTheme(/^(light|dark)$/.test(forced || '') ? forced : saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('#year').textContent = new Date().getFullYear();
load();
setInterval(load, 30000);
