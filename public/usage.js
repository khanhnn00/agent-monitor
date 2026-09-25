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

function render(v) {
  const w = v.windows.find((x) => x.current);
  if (!w) { $('#current').innerHTML = '<div class="card empty big">No sample for the current 5-hour session yet — it appears after the next prompt on this machine.</div>'; return; }
  const m = w.mine;
  const mine = w.minePercent;
  const acct = w.utilization;
  // A local window has no account sample: the session is rebuilt from this machine's own messages.
  const acctSub = w.local ? 'no account sample — local estimate from transcripts' : `sampled ${ago(w.sampledAt)}`;
  const mineSub = mine == null ? (w.local ? `$${m.cost.toFixed(2)} API-equivalent here` : 'needs one session ≥5% with activity here')
    : acct == null ? 'estimated from past calibration' : `${acct ? Math.round((mine / acct) * 100) : 0}% of the account's usage`;
  $('#current').innerHTML = `<div class="stats">
      <div class="stat hi"><div class="stat-label">Session</div><div class="stat-value">${hm(w.start)} → ${hm(w.end)}</div><div class="stat-sub">${day(w.start)} · resets in ${left(w.end)}${w.local ? ' (estimated)' : ''}</div></div>
      <div class="stat"><div class="stat-label">Account used</div><div class="stat-value">${acct == null ? '—' : pct(acct)}</div><div class="stat-sub">${esc(acctSub)}</div></div>
      <div class="stat"><div class="stat-label">This machine used</div><div class="stat-value">${mine == null ? '—' : pct(mine)}</div><div class="stat-sub">${esc(mineSub)}</div></div>
    </div>
    <div class="card u-now">
      ${acct == null && mine == null ? '' : `<div class="u-meter tall" role="img" aria-label="${acct == null ? 'account unknown' : `${pct(acct)} of the session limit used`}, ${mine == null ? 'this machine unknown' : pct(mine) + ' by this machine'}">
        <span class="u-seg" style="width:${mine || 0}%;background:${MINE}"></span><span class="u-seg" style="width:${Math.max(0, (acct || 0) - (mine || 0))}%;background:var(--series-other)"></span>
      </div>`}
      <table class="tbl u-tbl"><thead><tr><th>Active on this machine</th><th class="num">Msgs</th><th class="num">In / out tok</th><th class="num">API-equiv.</th></tr></thead><tbody><tr>
        <td class="mono">${m.first ? `${hm(m.first)} – ${hm(m.last + 60000)}` : '<span class="muted">No activity this session</span>'}</td>
        <td class="num">${m.messages}</td>
        <td class="num mono">${k(m.input + m.cacheWrite + m.cacheRead)} / ${k(m.output)}</td>
        <td class="num mono">$${m.cost.toFixed(2)}</td>
      </tr></tbody></table>
    </div>`;
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
