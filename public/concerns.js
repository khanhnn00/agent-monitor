'use strict';
const $ = (sel) => document.querySelector(sel);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
const k = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n || 0));
const ui = { q: '', state: null };

/** First `max` rows inline, the rest folded away — a merged card holds every repo's rows, so the cap has to sit here. */
function clamp(arr, max, tag, cls, fn, noun) {
  const head = arr.slice(0, max), tail = arr.slice(max);
  const list = (rows, start) => `<${tag}${cls ? ` class="${cls}"` : ''}${tag === 'ol' && start ? ` start="${start}"` : ''}>${rows.map(fn).join('')}</${tag}>`;
  return list(head) + (tail.length ? `<details class="more"><summary>+${tail.length} ${noun}</summary>${list(tail, max + 1)}</details>` : '');
}

/** How-to-fix stays collapsed: merged across repos the hook card alone carries 22 steps. */
function steps(g) {
  const all = [...new Set(g.items.flatMap((i) => i.steps || []))];
  if (!all.length) return '';
  return `<details class="steps"><summary>How to fix<span class="muted"> · ${all.length} steps</span></summary>${
    clamp(all, 5, 'ul', '', (s) => `<li>${esc(s)}</li>`, 'more steps')}</details>`;
}

function render() {
  const st = ui.state;
  if (!st) return;
  const groups = (st.concerns || []).filter((g) => !ui.q
    || [g.title, g.fix, ...g.items.map((i) => `${i.target} ${i.evidence}`)].join(' ').toLowerCase().includes(ui.q));
  const high = groups.filter((g) => g.severity === 'high').length;
  $('#summary').innerHTML = `<i></i><span>${groups.length} findings · ${high} high · ~${k(st.concernTokens || 0)} tokens/week</span>`;
  $('#findings').innerHTML = groups.map((g) => `<article class="finding-card ${esc(g.severity)}">
    <header>
      <span class="sev ${esc(g.severity)}"></span>
      <h2>${esc(g.title)}</h2>
      <span class="muted">${g.items.length} ${g.items.length === 1 ? 'place' : 'places'}</span>
      <span class="spacer"></span>
      ${g.tokensPerWeek ? `<span class="cost mono">~${k(g.tokensPerWeek)} tok/wk</span>` : ''}
    </header>
    ${clamp(g.items, 4, 'ol', 'finding-items', (i) => `<li>
      <b>${esc(i.target)}</b>${i.tokensPerWeek ? ` <span class="mono muted">~${k(i.tokensPerWeek)}/wk</span>` : ''}
      <div class="muted">${esc(i.evidence)}</div>
    </li>`, g.items.length - 4 === 1 ? 'more place' : 'more places')}
    <div class="finding-fix">→ ${esc(g.fix)}</div>
    ${steps(g)}
  </article>`).join('') || '<div class="empty big">Nothing flagged.</div>';
}

async function load() {
  try {
    const r = await fetch('/api/state');
    ui.state = await r.json();
    render();
  } catch (err) {
    $('#findings').innerHTML = `<div class="empty big">${esc(err.message || err)}</div>`;
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
$('#search').addEventListener('input', (e) => { ui.q = e.target.value.trim().toLowerCase(); render(); });

let saved = null;
try { saved = localStorage.getItem('harness-theme'); } catch (_) { /* private mode */ }
const forced = new URLSearchParams(location.search).get('theme');
applyTheme(/^(light|dark)$/.test(forced || '') ? forced : saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('#year').textContent = new Date().getFullYear();
load();
setInterval(load, 15000);
