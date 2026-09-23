/**
 * Moves usage between machines sharing one Claude account.
 *
 *   Every machine: scans its own transcripts each REPORT_INTERVAL_S and reports to the hub
 *                  (HUB_URL), or to its own store when HUB_URL is unset (it is the hub).
 *   The hub:       listens on HUB_PORT for reports from other machines. That listener only
 *                  serves the usage API and requires HUB_TOKEN, so the dashboard itself can
 *                  stay on loopback.
 */
'use strict';
const http = require('http');
const os = require('os');
const { localBuckets, accountUsage } = require('./usage-local.cjs');
const hub = require('./usage-hub.cjs');

const MACHINE = process.env.MACHINE_NAME || os.hostname();
const HUB_URL = (process.env.HUB_URL || '').replace(/\/+$/, '');
const HUB_TOKEN = process.env.HUB_TOKEN || '';
const HUB_PORT = Number(process.env.HUB_PORT || 4318);
const INTERVAL = Number(process.env.REPORT_INTERVAL_S || 60) * 1000;
const HOUR = 3600000;
const BACKFILL = 7 * 24 * HOUR;
const RECENT = 6 * HOUR;

const status = { machine: MACHINE, hubUrl: HUB_URL || null, lastReportAt: null, lastError: null };
let lastOk = 0;

async function report() {
  const now = Date.now();
  const since = now - (now - lastOk > RECENT ? BACKFILL : RECENT);
  const body = { machine: MACHINE, at: now, since, buckets: localBuckets(since), account: accountUsage() };
  try {
    if (!HUB_URL) hub.ingest(body);
    else {
      const r = await fetch(`${HUB_URL}/api/usage/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${HUB_TOKEN}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error(`hub answered ${r.status}`);
    }
    lastOk = now;
    status.lastReportAt = new Date(now).toISOString();
    status.lastError = null;
  } catch (e) {
    status.lastError = e.message;
  }
}

/** The usage view: straight from the store on the hub, fetched from the hub everywhere else. */
async function usageView() {
  let v;
  if (!HUB_URL) v = hub.view();
  else {
    const r = await fetch(`${HUB_URL}/api/usage`, { headers: { Authorization: `Bearer ${HUB_TOKEN}` }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`hub answered ${r.status}`);
    v = await r.json();
  }
  return { ...v, self: status };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function startHubListener() {
  if (HUB_URL) return;
  if (!HUB_TOKEN) { console.log('usage hub: HUB_TOKEN unset — not accepting reports from other machines'); return; }
  http.createServer(async (req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== `Bearer ${HUB_TOKEN}`) return json(401, { error: 'unauthorized' });
    try {
      if (req.method === 'POST' && req.url === '/api/usage/report') {
        hub.ingest(JSON.parse(await readBody(req, 8 * 1024 * 1024)));
        return json(200, { ok: true });
      }
      if (req.method === 'GET' && req.url === '/api/usage') return json(200, hub.view());
      return json(404, { error: 'not found' });
    } catch (e) {
      return json(400, { error: e.message });
    }
  }).listen(HUB_PORT, process.env.HOST || '127.0.0.1', () => console.log(`usage hub accepting reports on :${HUB_PORT}`));
}

function start() {
  startHubListener();
  report();
  setInterval(report, INTERVAL).unref();
  process.on('SIGTERM', () => { hub.save(); process.exit(0); });
}

module.exports = { start, usageView };
