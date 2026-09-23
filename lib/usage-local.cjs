/**
 * This machine's Claude usage, read from its own transcripts (~/.claude/projects/**.jsonl).
 *
 * Every assistant message carries `usage`; it is priced at API list rates so tokens from
 * different models and cache tiers land on one scale. The 5h limit is not dollars, but it
 * moves with this cost, so a machine's share of the cost is its share of the account %.
 * Output: per-minute buckets, so any 5h window can be summed later on the hub.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.CLAUDE_DIR || path.join(os.homedir(), '.claude');
const PROJECTS = path.join(ROOT, 'projects');
const MINUTE = 60000;

// $ per 1M tokens [input, output]; first matching prefix wins.
const PRICES = [
  ['claude-fable', 10, 50], ['claude-mythos', 10, 50],
  ['claude-opus-5-5', 4, 20], ['claude-opus', 5, 25],
  ['claude-sonnet-5', 2, 10], ['claude-sonnet', 3, 15],
  ['claude-haiku', 1, 5],
];
const priceOf = (model) => PRICES.find(([p]) => String(model || '').startsWith(p)) || PRICES[3];

/** API-equivalent $ for one message's usage block. */
function costOf(model, u) {
  const [, inp, out] = priceOf(model);
  const cc = u.cache_creation || {};
  const cw1h = cc.ephemeral_1h_input_tokens || 0;
  const cw5m = cc.ephemeral_5m_input_tokens != null ? cc.ephemeral_5m_input_tokens : Math.max(0, (u.cache_creation_input_tokens || 0) - cw1h);
  return ((u.input_tokens || 0) * inp + (u.output_tokens || 0) * out
    + cw5m * inp * 1.25 + cw1h * inp * 2 + (u.cache_read_input_tokens || 0) * inp * 0.1) / 1e6;
}

function walk(dir, since, out) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, since, out);
    else if (e.name.endsWith('.jsonl')) {
      try { const st = fs.statSync(p); if (st.mtimeMs >= since) out.push({ p, key: `${st.size}:${st.mtimeMs}` }); } catch (_) { /* vanished */ }
    }
  }
  return out;
}

const fileCache = new Map(); // path -> { key, msgs: Map(id -> row) }

function parseFile(p) {
  const msgs = new Map();
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch (_) { return msgs; }
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let r;
    try { r = JSON.parse(line); } catch (_) { continue; }
    const m = r.message;
    if (!m || m.role !== 'assistant' || !m.usage || !r.timestamp || m.model === '<synthetic>') continue;
    const u = m.usage;
    // One API message is written as several lines (one per content block), each repeating usage.
    msgs.set(m.id || r.requestId || r.uuid, {
      t: Date.parse(r.timestamp), cost: costOf(m.model, u),
      i: u.input_tokens || 0, o: u.output_tokens || 0,
      cw: u.cache_creation_input_tokens || 0, cr: u.cache_read_input_tokens || 0,
    });
  }
  return msgs;
}

/** Per-minute buckets of this machine's usage since `since` (ms). */
function localBuckets(since) {
  const seen = new Set();
  const buckets = {};
  const live = new Set();
  for (const { p, key } of walk(PROJECTS, since, [])) {
    live.add(p);
    let c = fileCache.get(p);
    if (!c || c.key !== key) { c = { key, msgs: parseFile(p) }; fileCache.set(p, c); }
    for (const [id, m] of c.msgs) {
      if (m.t < since || seen.has(id)) continue;
      seen.add(id);
      const b = (buckets[Math.floor(m.t / MINUTE) * MINUTE] ||= { c: 0, i: 0, o: 0, cw: 0, cr: 0, n: 0 });
      b.c += m.cost; b.i += m.i; b.o += m.o; b.cw += m.cw; b.cr += m.cr; b.n += 1;
    }
  }
  for (const p of fileCache.keys()) if (!live.has(p)) fileCache.delete(p);
  return buckets;
}

/** Account-wide 5h utilisation, from the cache the usage-context-awareness hook writes on the host. */
function accountUsage() {
  const file = process.env.USAGE_CACHE || path.join(os.tmpdir(), 'ck-usage-limits-cache.json');
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    const fh = c.status === 'available' && c.data && c.data.five_hour;
    if (!fh || fh.utilization == null || !fh.resets_at) return null;
    return { utilization: fh.utilization, resetsAt: Date.parse(fh.resets_at), fetchedAt: c.timestamp,
      weekly: c.data.seven_day ? { utilization: c.data.seven_day.utilization, resetsAt: Date.parse(c.data.seven_day.resets_at) } : null };
  } catch (_) { return null; }
}

module.exports = { localBuckets, accountUsage, costOf };
