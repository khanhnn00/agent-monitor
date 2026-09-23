#!/usr/bin/env node
/**
 * Harness dashboard — zero-dependency HTTP server over a read-only ~/.claude.
 *
 *   GET /                  UI (public/)
 *   GET /api/state         Claude sessions per repo: status, intent, subagents, skills, context overhead
 *   GET /api/session/:id   one session's recent turns
 *   GET /api/stream        Server-Sent Events: /api/state, pushed whenever it changes
 *   GET /api/usage         5h windows: account % and each machine's share (see lib/usage-sync.cjs)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildState, sessionDetail } = require('./lib/state.cjs');
const usage = require('./lib/usage-sync.cjs');

const PORT = Number(process.env.PORT || 4317);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const clients = new Set();
let snap = { at: 0, body: '{}', hash: '' };

function snapshot() {
  if (Date.now() - snap.at < 1500) return snap;
  const state = buildState();
  const { generatedAt, ...stable } = state;
  snap = { at: Date.now(), body: JSON.stringify(state), hash: crypto.createHash('sha1').update(JSON.stringify(stable)).digest('hex') };
  return snap;
}

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

setInterval(() => {
  if (!clients.size) return;
  let s;
  try { s = snapshot(); } catch (_) { return; }
  for (const c of clients) {
    if (c.hash === s.hash) continue;
    c.res.write(`data: ${s.body}\n\n`);
    c.hash = s.hash;
  }
}, 3000);
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 15000);

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/state') return send(res, 200, snapshot().body, 'application/json');
    if (url.pathname === '/api/usage') {
      usage.usageView()
        .then((v) => send(res, 200, JSON.stringify(v), 'application/json'))
        .catch((e) => send(res, 502, JSON.stringify({ error: e.message }), 'application/json'));
      return undefined;
    }
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const s = snapshot();
      const client = { res, hash: s.hash };
      res.write(`data: ${s.body}\n\n`);
      clients.add(client);
      req.on('close', () => clients.delete(client));
      return undefined;
    }
    const m = url.pathname.match(/^\/api\/session\/([\w-]{8,64})$/);
    if (m) {
      const detail = sessionDetail(m[1]);
      return send(res, detail ? 200 : 404, JSON.stringify(detail || { error: 'not recorded by the harness' }), 'application/json');
    }
    const page = url.pathname === '/' ? 'index.html' : url.pathname === '/concerns' ? 'concerns.html' : url.pathname === '/usage' ? 'usage.html' : url.pathname.slice(1);
    const file = path.resolve(PUBLIC, page);
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'not found', 'text/plain');
    return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    return send(res, 500, JSON.stringify({ error: e.message }), 'application/json');
  }
}).listen(PORT, HOST, () => console.log(`harness dashboard on http://${HOST}:${PORT} · data ${process.env.CLAUDE_DIR || '~/.claude'}`));

usage.start();
