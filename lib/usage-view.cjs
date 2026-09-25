/**
 * This machine's share of the account's 5h limit, without talking to any other machine.
 *
 * The account % covers every machine on the account; the transcripts here cover only this
 * one. Each account sample is kept next to this machine's cost up to that instant. The
 * ratio (% per $) is lowest in the window this machine had most to itself, and never below
 * the true rate — so the minimum across windows is the rate used to turn local cost into %.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { localBuckets, accountUsage } = require('./usage-local.cjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'usage.json');
const WINDOW = 5 * 3600000;
const KEEP = 8 * 86400000;
const MINUTE = 60000;
const HOUR = 3600000;
// Utilisation is a whole percent; below this the rounding swamps the ratio.
const MIN_CALIBRATION_PCT = 5;

let db = load();

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { return { windows: {} }; }
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(db));
    fs.renameSync(`${FILE}.tmp`, FILE);
  } catch (e) { console.error(`usage: cannot persist ${FILE}: ${e.message}`); }
}

/** Record the latest account sample. The reset instant jitters by sub-seconds; the minute is the window's id. */
function sample() {
  const a = accountUsage();
  if (!a || !Number.isFinite(a.resetsAt)) return;
  const end = Math.round(a.resetsAt / MINUTE) * MINUTE;
  const w = (db.windows[end] ||= { start: end - WINDOW, end, utilization: 0, sampledAt: 0 });
  if (a.fetchedAt <= w.sampledAt) return;
  w.utilization = Math.max(w.utilization, a.utilization);
  w.sampledAt = a.fetchedAt;
  const now = Date.now();
  for (const k of Object.keys(db.windows)) if (db.windows[k].end < now - KEEP) delete db.windows[k];
  persist();
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

/**
 * Without the host usage cache there is no account sample. Rebuild 5h sessions from this machine's
 * own activity instead: a session starts at the hour of the first message after the previous one ended.
 */
function localWindows(buckets, known) {
  const out = [];
  let end = 0;
  for (const t of Object.keys(buckets).map(Number).sort((a, b) => a - b)) {
    if (t < end || known.some((w) => t >= w.start && t < w.end)) continue;
    const start = Math.floor(t / HOUR) * HOUR;
    end = start + WINDOW;
    out.push({ start, end, utilization: null, sampledAt: null, local: true });
  }
  return out;
}

function view() {
  sample();
  const now = Date.now();
  const buckets = localBuckets(now - KEEP);
  const known = Object.values(db.windows);
  const windows = [...known, ...localWindows(buckets, known)].sort((a, b) => b.end - a.end).map((w) => {
    const mine = sumRange(buckets, w.start, w.end);
    const atSample = w.local ? mine.cost : sumRange(buckets, w.start, Math.min(w.end, w.sampledAt + MINUTE)).cost;
    return { ...w, current: now >= w.start && now < w.end, mine, atSample };
  });

  let rate = null;
  let rateFrom = null;
  for (const w of windows) {
    if (w.local || w.utilization < MIN_CALIBRATION_PCT || w.atSample <= 0) continue;
    const r = w.utilization / w.atSample;
    if (rate == null || r < rate) { rate = r; rateFrom = w.end; }
  }
  for (const w of windows) {
    w.minePercent = rate == null ? null : w.local ? Math.min(100, rate * w.atSample) : Math.min(w.utilization, rate * w.atSample);
    delete w.atSample;
  }
  return { generatedAt: new Date(now).toISOString(), calibration: rate == null ? null : { percentPerDollar: rate, fromWindowEnd: rateFrom }, windows };
}

module.exports = { view, sample };
