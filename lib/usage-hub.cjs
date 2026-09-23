/**
 * Hub store: every machine on the account pushes its per-minute usage buckets and, when it
 * has one, the account's 5h utilisation. A window's account % is split across machines by
 * their share of API-equivalent cost inside that window.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'usage.json');
const WINDOW = 5 * 3600000;
const KEEP = 8 * 86400000;
const MINUTE = 60000;

let db = load();

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { return { machines: {}, windows: {} }; }
}

let dirty = false;
function save() {
  if (!dirty) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(db));
    fs.renameSync(`${FILE}.tmp`, FILE);
    dirty = false;
  } catch (e) { console.error(`usage hub: cannot persist ${FILE}: ${e.message}`); }
}
setInterval(save, 10000).unref();

/** The reset instant jitters by sub-seconds between fetches; the minute identifies the window. */
const windowKey = (resetsAt) => String(Math.round(resetsAt / MINUTE) * MINUTE);

/**
 * report = { machine, at, since, buckets: { minuteTs: {c,i,o,cw,cr,n} }, account: {utilization, resetsAt, fetchedAt} | null }
 * The reporter recomputes everything from `since` on, so those buckets are replaced wholesale.
 */
function ingest(report) {
  const name = String(report.machine || '').trim().slice(0, 64);
  if (!name || typeof report.buckets !== 'object' || !Number.isFinite(report.since)) throw new Error('bad report');
  const now = Date.now();
  const m = (db.machines[name] ||= { buckets: {} });
  for (const ts of Object.keys(m.buckets)) if (+ts >= report.since || +ts < now - KEEP) delete m.buckets[ts];
  for (const [ts, b] of Object.entries(report.buckets)) if (+ts >= report.since) m.buckets[ts] = b;
  m.lastSeen = now;

  const a = report.account;
  if (a && Number.isFinite(a.resetsAt) && Number.isFinite(a.utilization)) {
    const key = windowKey(a.resetsAt);
    const w = (db.windows[key] ||= { end: +key, start: +key - WINDOW, utilization: 0, sampledAt: 0 });
    if ((a.fetchedAt || 0) >= w.sampledAt) {
      w.utilization = Math.max(w.utilization, a.utilization); // only ever rises within a window
      w.sampledAt = a.fetchedAt || now;
      w.sampledBy = name;
    }
    if (a.weekly && (a.fetchedAt || 0) >= ((db.weekly && db.weekly.sampledAt) || 0)) db.weekly = { ...a.weekly, sampledAt: a.fetchedAt || now };
  }
  for (const k of Object.keys(db.windows)) if (db.windows[k].end < now - KEEP) delete db.windows[k];
  dirty = true;
}

function sumRange(buckets, start, end) {
  const s = { cost: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0, first: null, last: null };
  for (const [ts, b] of Object.entries(buckets)) {
    const t = +ts;
    if (t < start || t >= end) continue;
    s.cost += b.c; s.input += b.i; s.output += b.o; s.cacheWrite += b.cw; s.cacheRead += b.cr; s.messages += b.n;
    if (s.first == null || t < s.first) s.first = t;
    if (s.last == null || t > s.last) s.last = t;
  }
  return s;
}

function view() {
  const now = Date.now();
  const names = Object.keys(db.machines).sort();
  const windows = Object.values(db.windows).sort((a, b) => b.end - a.end).map((w) => {
    const rows = names.map((name) => ({ machine: name, ...sumRange(db.machines[name].buckets, w.start, w.end) }));
    const total = rows.reduce((n, r) => n + r.cost, 0);
    for (const r of rows) {
      r.share = total ? r.cost / total : 0;
      r.percent = w.utilization * r.share;
    }
    return { ...w, current: now >= w.start && now < w.end, totalCost: total, machines: rows.filter((r) => r.messages) };
  });
  return {
    generatedAt: new Date(now).toISOString(),
    machines: names.map((name) => ({ name, lastSeen: db.machines[name].lastSeen })),
    weekly: db.weekly || null,
    windows,
  };
}

module.exports = { ingest, view, save };
