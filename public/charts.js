'use strict';
/* Zero-dependency SVG charts for the harness dashboard: stacked columns, heatmap, sparkline.
   Marks follow the dataviz spec — ≤24px columns with a 4px rounded data-end, 2px surface gaps,
   hairline grid, selective direct labels, a hover/focus tooltip filled with textContent only. */
const Charts = (() => {
  const SVGNS = 'http://www.w3.org/2000/svg';
  let tip;

  function el(tag, attrs, parent) {
    const node = document.createElementNS(SVGNS, tag);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
    if (parent) parent.appendChild(node);
    return node;
  }

  function showTip(point, title, rows) {
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'viz-tip';
      tip.hidden = true;
      document.body.appendChild(tip);
    }
    tip.replaceChildren();
    const head = document.createElement('div');
    head.className = 'viz-tip-title';
    head.textContent = title;
    tip.appendChild(head);
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'viz-tip-row';
      const key = document.createElement('i');
      if (r.color) key.style.background = r.color;
      const value = document.createElement('b');
      value.textContent = r.value;
      const label = document.createElement('span');
      label.textContent = r.label;
      row.append(key, value, label);
      tip.appendChild(row);
    }
    tip.hidden = false;
    const pad = 14;
    let x = point.x + pad;
    let y = point.y + pad;
    if (x + tip.offsetWidth > window.innerWidth - 8) x = point.x - tip.offsetWidth - pad;
    if (y + tip.offsetHeight > window.innerHeight - 8) y = point.y - tip.offsetHeight - pad;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }
  const hideTip = () => { if (tip) tip.hidden = true; };

  function bindTip(node, title, rows) {
    node.addEventListener('pointermove', (e) => showTip({ x: e.clientX, y: e.clientY }, title, rows()));
    node.addEventListener('pointerleave', hideTip);
    node.addEventListener('focus', () => {
      const b = node.getBoundingClientRect();
      showTip({ x: b.left + b.width / 2, y: b.top }, title, rows());
    });
    node.addEventListener('blur', hideTip);
  }

  function niceScale(value) {
    const raw = Math.max(1, value) / 4;
    const pow = 10 ** Math.floor(Math.log10(raw));
    const step = Math.max(1, [1, 2, 2.5, 5, 10].map((k) => k * pow).find((s) => s >= raw));
    const max = Math.ceil(Math.max(1, value) / step) * step;
    const ticks = [];
    for (let t = 0; t <= max; t += step) ticks.push(Math.round(t));
    return { max, ticks };
  }

  const roundTop = (x, y, w, h, r) => `M${x},${y + h}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h}Z`;
  const square = (x, y, w, h) => `M${x},${y}H${x + w}V${y + h}H${x}Z`;
  const dayLabel = (d) => d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

  /** Columns per day, stacked by series. data: { days: Date[], series: [{ key, color, values[] }] } */
  function stackedColumns(root, { days, series }) {
    root.replaceChildren();
    const W = Math.max(280, root.clientWidth || 600);
    const H = 236;
    const m = { l: 34, r: 8, t: 20, b: 26 };
    const pw = W - m.l - m.r;
    const ph = H - m.t - m.b;
    const n = days.length;
    const totals = days.map((_, i) => series.reduce((a, s) => a + s.values[i], 0));
    const { max, ticks } = niceScale(Math.max(...totals));
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, class: 'viz-svg' }, root);
    const y = (v) => m.t + ph - (v / max) * ph;
    for (const t of ticks) {
      el('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: t === 0 ? 'viz-axis' : 'viz-grid' }, svg);
      el('text', { x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'viz-tick' }, svg).textContent = t.toLocaleString('en-US');
    }
    const band = pw / n;
    const bw = Math.min(24, band * 0.6);
    const peak = totals.indexOf(Math.max(...totals));
    days.forEach((day, i) => {
      const cx = m.l + band * i + band / 2;
      const parts = series.map((s) => ({ s, v: s.values[i] })).filter((p) => p.v > 0);
      let base = m.t + ph;
      parts.forEach(({ s, v }, j) => {
        const h = (v / max) * ph;
        const y0 = base - h;
        const y1 = j > 0 ? base - 2 : base;
        if (y1 - y0 > 0.5) {
          const r = Math.min(4, y1 - y0, bw / 2);
          el('path', { d: j === parts.length - 1 ? roundTop(cx - bw / 2, y0, bw, y1 - y0, r) : square(cx - bw / 2, y0, bw, y1 - y0) }, svg).style.fill = s.color;
        }
        base -= h;
      });
      if (band >= 30 || (n - 1 - i) % 2 === 0) {
        el('text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: i === n - 1 ? 'viz-tick strong' : 'viz-tick' }, svg).textContent = i === n - 1 ? 'Today' : String(day.getDate());
      }
      if ((i === peak || i === n - 1) && totals[i]) {
        el('text', { x: cx, y: y(totals[i]) - 6, 'text-anchor': 'middle', class: 'viz-label' }, svg).textContent = totals[i];
      }
      const hit = el('rect', { x: m.l + band * i, y: m.t, width: band, height: ph, class: 'viz-hit', tabindex: 0, 'aria-label': `${dayLabel(day)}: ${totals[i]} prompts` }, svg);
      bindTip(hit, dayLabel(day), () => [
        { label: 'total', value: String(totals[i]) },
        ...series.filter((s) => s.values[i]).map((s) => ({ label: s.key, value: String(s.values[i]), color: s.color })),
      ]);
    });
  }

  /** Day × hour grid. data: { rows: [{ date: Date, counts: number[24] }] } — sequential single-hue bins 0–5. */
  function heatmap(root, { rows }) {
    root.replaceChildren();
    const W = Math.max(280, root.clientWidth || 600);
    const m = { l: 58, r: 4, t: 2, b: 22 };
    const cw = (W - m.l - m.r) / 24;
    const ch = 20;
    const H = m.t + rows.length * (ch + 2) + m.b;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, class: 'viz-svg' }, root);
    const max = Math.max(1, ...rows.flatMap((r) => r.counts));
    rows.forEach((row, ri) => {
      const top = m.t + ri * (ch + 2);
      const today = ri === rows.length - 1;
      const name = today ? 'Today' : row.date.toLocaleDateString([], { weekday: 'short', day: 'numeric' });
      el('text', { x: m.l - 8, y: top + ch / 2 + 4, 'text-anchor': 'end', class: today ? 'viz-tick strong' : 'viz-tick' }, svg).textContent = name;
      row.counts.forEach((count, hour) => {
        const level = count ? Math.min(5, Math.ceil((count / max) * 5)) : 0;
        const cell = el('rect', { x: m.l + hour * cw + 1, y: top, width: Math.max(1, cw - 2), height: ch, rx: 3, class: `viz-cell seq-${level}` }, svg);
        const span = `${String(hour).padStart(2, '0')}:00–${String((hour + 1) % 24).padStart(2, '0')}:00`;
        bindTip(cell, `${name} · ${span}`, () => [{ label: count === 1 ? 'prompt' : 'prompts', value: String(count) }]);
      });
    });
    for (const hour of [0, 6, 12, 18, 23]) {
      el('text', { x: m.l + hour * cw + cw / 2, y: H - 6, 'text-anchor': 'middle', class: 'viz-tick' }, svg).textContent = `${String(hour).padStart(2, '0')}h`;
    }
  }

  /** Inline trend: de-emphasis line, current value as an accent dot with a surface ring. Numbers only. */
  function sparkline(values, w = 88, h = 22) {
    if (!Array.isArray(values) || values.length < 2) return '';
    const lo = Math.min(...values);
    const span = Math.max(1, Math.max(...values) - lo);
    const pts = values.map((v, i) => [4 + (i / (values.length - 1)) * (w - 8), h - 4 - ((v - lo) / span) * (h - 8)]);
    const d = pts.map(([x, yy], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${yy.toFixed(1)}`).join('');
    const [lx, ly] = pts[pts.length - 1];
    return `<svg class="spark-svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path class="spark-path" d="${d}"/><circle class="spark-dot" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="4"/></svg>`;
  }

  return { stackedColumns, heatmap, sparkline, hideTip };
})();
