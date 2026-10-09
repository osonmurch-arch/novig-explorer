// Novig Explorer — local live server.
// Runs on your computer, holds your read-only Novig key, signs requests and streams live order books
// to the explorer at http://localhost:8787. No dependencies: needs Node 22 or newer.
//
//   node server.mjs            (or double-click start.cmd on Windows)
//
// Settings live in config.json next to this file (copy config.example.json). Your private key never leaves
// this computer: only Novig's API sees requests signed with it.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '..');
const VERSION = '1.0.0';

/* ---------------- config ---------------- */
function loadConfig() {
  const file = path.join(HERE, 'config.json');
  if (!fs.existsSync(file)) fail(`No config.json found.\n  Copy config.example.json to config.json in\n  ${HERE}\n  and fill in your key ID and the path to your key's .pem file.`);
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail(`config.json isn't valid JSON: ${e.message}\n  On Windows, write paths with forward slashes (C:/Users/you/novig.pem) or doubled backslashes.`); }
  cfg.host = (process.env.NOVIG_HOST || cfg.host || 'https://api.novig.com').replace(/\/+$/, '');
  cfg.port = Number(process.env.PORT || cfg.port || 8787);
  if (!cfg.keyId || !/^[0-9a-f-]{36}$/i.test(cfg.keyId)) fail('config.json: "keyId" should be your trading::read key ID (a UUID like 01a1…-…).');
  if (!cfg.keyFile) fail('config.json: "keyFile" should be the path to the private key .pem file for that key.');
  const keyPath = path.resolve(HERE, cfg.keyFile);
  if (!fs.existsSync(keyPath)) fail(`Can't find the key file at ${keyPath}`);
  try { cfg.key = crypto.createPrivateKey(fs.readFileSync(keyPath)); } catch (e) { fail(`Couldn't read the key file as a private key PEM: ${e.message}`); }
  cfg.alg = cfg.key.asymmetricKeyType; // 'ed25519' or 'ec'
  if (!['ed25519', 'ec'].includes(cfg.alg)) fail(`Unsupported key type ${cfg.alg}; Novig keys are Ed25519 or P-256.`);
  cfg.streamMarkets = Math.min(Math.max(Number(cfg.streamMarkets || 30), 1), 2048);
  return cfg;
}
function fail(msg) { console.error('\n  ✖ ' + msg + '\n'); process.exit(1); }
const CFG = loadConfig();

/* ---------------- NOVIG-V3 signing ----------------
   Six lines joined by \n, no trailing newline:
   NOVIG-V3, timestamp ms, METHOD, path, canonical query, hex sha256(body). */
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
function canonicalQuery(raw) {
  if (!raw) return '';
  const pairs = raw.split('&').filter((p) => p.length).map((p) => {
    const i = p.indexOf('=');
    const [k, v] = i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)];
    return [enc(dec(k)), enc(dec(v))];
  });
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}
let clockSkew = 0; // server time − our time, learned from Date headers
function sign(method, pathAndQuery, body = '') {
  const [p, q = ''] = pathAndQuery.split(/\?(.*)/s);
  const ts = String(Date.now() + clockSkew);
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  const canonical = ['NOVIG-V3', ts, method.toUpperCase(), p, canonicalQuery(q), hash].join('\n');
  const sig = CFG.alg === 'ed25519'
    ? crypto.sign(null, Buffer.from(canonical), CFG.key)
    : crypto.sign('sha256', Buffer.from(canonical), { key: CFG.key, dsaEncoding: 'der' });
  return { 'Novig-Key-Id': CFG.keyId, 'Novig-Timestamp': ts, 'Novig-Signature': sig.toString('base64') };
}

async function novig(pathAndQuery) {
  const res = await fetch(CFG.host + pathAndQuery, { headers: { ...sign('GET', pathAndQuery), Accept: 'application/json' } });
  const date = res.headers.get('date');
  if (date) { const d = Date.parse(date) - Date.now(); if (Math.abs(d) > 5000) clockSkew = d; }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* edge errors are HTML */ }
  return { status: res.status, json, text };
}

/* ---------------- read-only REST proxy ----------------
   Only GETs on read routes are forwarded. Nothing that places orders or moves money. */
const ALLOWED = [/^\/v3\/catalog\//, /^\/v3\/types\//, /^\/v3\/history\/(markets|events)/, /^\/v3\/limits$/];

/* ---------------- live books over one websocket ---------------- */
const books = new Map(); // marketId -> { seq, outcomes: Map<outcomeId, [{orderId, price, qty}]>, where: Map<orderId, outcomeId>, at }
const watchers = new Map(); // client id -> Set(marketIds)
const subscribed = new Set();
const pending = new Set();
const clients = new Map(); // client id -> res (SSE)
let ws = null;
let wsState = 'idle';
let wsError = '';
let nonce = 0;
let backoff = 1000;
const dirty = new Set();

// Client-side model of the stream bucket: 512 tokens, ~4/s refill; book costs 16 per market, the upgrade 32.
const bucket = { tokens: 512 - 32, cap: 512, rate: 4, last: Date.now() };
function tokens() {
  const now = Date.now();
  bucket.tokens = Math.min(bucket.cap, bucket.tokens + ((now - bucket.last) / 1000) * bucket.rate);
  bucket.last = now;
  return bucket.tokens;
}

function wanted() {
  const all = new Set();
  for (const set of watchers.values()) for (const id of set) all.add(id);
  return all;
}

function send(obj) {
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify(obj));
  return true;
}

let syncTimer = null;
function sync() {
  clearTimeout(syncTimer);
  if (!ws || ws.readyState !== 1) return;
  const want = wanted();
  const drop = [...subscribed].filter((id) => !want.has(id));
  if (drop.length) {
    send({ nonce: ++nonce, unsubscribe: drop.map((id) => `market:${id}`) });
    drop.forEach((id) => { subscribed.delete(id); books.delete(id); });
  }
  const add = [...want].filter((id) => !subscribed.has(id) && !pending.has(id));
  if (!add.length) return;
  const can = Math.floor(tokens() / 16);
  const batch = add.slice(0, Math.max(0, can));
  if (batch.length) {
    bucket.tokens -= batch.length * 16;
    batch.forEach((id) => pending.add(id));
    send({ nonce: ++nonce, subscribe: { markets: Object.fromEntries(batch.map((id) => [id, 'book'])) } });
  }
  if (batch.length < add.length) syncTimer = setTimeout(sync, Math.ceil(((16 - (tokens() % 16)) / bucket.rate) * 1000));
}

function loadBook(marketId, snap) {
  const outcomes = new Map();
  const where = new Map();
  for (const [oid, list] of Object.entries(snap.orders || {})) {
    outcomes.set(oid, list.map((o) => ({ orderId: o.order ?? o.orderId, price: String(o.price), qty: Number(o.qty) })));
    list.forEach((o) => where.set(o.order ?? o.orderId, oid));
  }
  books.set(marketId, { seq: snap.seq, outcomes, where, at: Date.now() });
  dirty.add(marketId);
}

function applyDeltas(marketId, b) {
  const book = books.get(marketId);
  if (!book) return;
  if (typeof b.seq === 'number' && typeof book.seq === 'number' && b.seq !== book.seq + 1) {
    if (b.seq <= book.seq) return; // old news
    resync(marketId);
    return;
  }
  book.seq = b.seq;
  for (const d of b.deltas || []) {
    if (d.kind === 'add') {
      const oid = d.outcome;
      if (!book.outcomes.has(oid)) book.outcomes.set(oid, []);
      const list = book.outcomes.get(oid);
      const p = Number(d.price);
      let i = list.findIndex((o) => Number(o.price) < p);
      if (i < 0) i = list.length;
      list.splice(i, 0, { orderId: d.order, price: String(d.price), qty: Number(d.qty) });
      book.where.set(d.order, oid);
    } else if (d.kind === 'remove') {
      const oid = book.where.get(d.order);
      if (oid && book.outcomes.has(oid)) {
        const list = book.outcomes.get(oid);
        const i = list.findIndex((o) => o.orderId === d.order);
        if (i >= 0) list.splice(i, 1);
      }
      book.where.delete(d.order);
    }
  }
  book.at = Date.now();
  dirty.add(marketId);
}

function resync(marketId) {
  // A skipped seq: drop and resubscribe to get a fresh snapshot.
  console.log(`  ↻ gap on ${marketId.slice(0, 8)}…, resubscribing`);
  send({ nonce: ++nonce, unsubscribe: [`market:${marketId}`] });
  subscribed.delete(marketId);
  books.delete(marketId);
  setTimeout(sync, 250);
}

function onMessage(raw) {
  let msg;
  try { msg = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')); } catch { return; }
  if (msg.code && msg.message) {
    console.log(`  ⚠ Novig: ${msg.code} — ${msg.message}`);
    broadcast('notice', { code: msg.code, message: msg.message });
    if (msg.nonce) { pending.clear(); setTimeout(sync, 2000); }
    return;
  }
  if (msg.subscribed && msg.subscribed.markets) {
    for (const id of Object.keys(msg.subscribed.markets)) { pending.delete(id); subscribed.add(id); }
  }
  const snap = msg.snapshot || {};
  for (const [id, m] of Object.entries(snap)) if (m && m.book) loadBook(id, m.book);
  const delta = msg.delta || {};
  for (const [id, m] of Object.entries(delta)) {
    if (m && m.book) applyDeltas(id, m.book);
    if (m && m.lifecycle) broadcast('lifecycle', { marketId: id, lifecycle: m.lifecycle });
  }
}

function connect() {
  wsState = 'connecting';
  status();
  const url = CFG.host.replace(/^http/, 'ws') + '/v3/ws';
  try {
    ws = new WebSocket(url, { headers: sign('GET', '/v3/ws') });
  } catch (e) {
    wsError = e.message;
    return retry();
  }
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    wsState = 'live'; wsError = ''; backoff = 1000;
    bucket.tokens = Math.max(0, tokens() - 32);
    console.log('  ● Streaming from Novig');
    subscribed.clear(); pending.clear();
    status();
    sync();
  };
  ws.onmessage = (ev) => onMessage(ev.data);
  ws.onerror = (ev) => { wsError = (ev && ev.message) || 'connection error'; };
  ws.onclose = (ev) => {
    if (wsState === 'live') console.log(`  ○ Stream closed (${ev.code}${ev.reason ? ' ' + ev.reason : ''})`);
    wsState = 'down';
    if (ev.code === 1008) wsError = 'SLOW_CONSUMER: this computer fell behind the stream';
    else if (!wsError) wsError = `closed ${ev.code}${ev.reason ? ': ' + ev.reason : ''}`;
    subscribed.clear(); pending.clear();
    status();
    retry();
  };
}
function retry() {
  setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 30000);
}

/* ---------------- browser stream (Server-Sent Events) ---------------- */
function bookJson(marketId) {
  const b = books.get(marketId);
  if (!b) return null;
  const orders = {};
  for (const [oid, list] of b.outcomes) orders[oid] = list.slice(0, 200);
  return { marketId, seq: b.seq, orders, at: b.at };
}
function broadcast(event, data) {
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients.values()) res.write(line);
}
function status() {
  broadcast('status', { ws: wsState, error: wsError, streaming: subscribed.size, waiting: Math.max(0, wanted().size - subscribed.size) });
}
setInterval(() => {
  if (!dirty.size) return;
  for (const id of dirty) {
    if (!wanted().has(id)) continue;
    const b = bookJson(id);
    if (b) broadcast('book', b);
  }
  dirty.clear();
}, 150);
setInterval(status, 5000);
setInterval(() => { for (const res of clients.values()) res.write(': ping\n\n'); }, 20000);

/* ---------------- http server ---------------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/plain; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // Only answer this computer. The server binds to 127.0.0.1, and this blocks other sites from using it.
  const origin = req.headers.origin;
  const host = String(req.headers.host || '');
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) || (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) { res.writeHead(403); return res.end(); }

  if (url.pathname === '/local/status') {
    const r = await novig('/v3/limits').catch((e) => ({ status: 0, text: e.message }));
    const ok = r.status === 200;
    return json(res, ok ? 200 : 502, {
      ok, version: VERSION, host: CFG.host, keyId: CFG.keyId.slice(0, 8) + '…', status: r.status,
      code: r.json && r.json.code, message: ok ? '' : (r.json && r.json.message) || r.text.slice(0, 200), limits: ok ? r.json : null,
      stream: { ws: wsState, error: wsError, max: CFG.streamMarkets },
    });
  }

  if (url.pathname.startsWith('/local/api/')) {
    const p = url.pathname.slice('/local/api'.length);
    if (req.method !== 'GET' || !ALLOWED.some((re) => re.test(p))) return json(res, 403, { code: 'NOT_ALLOWED', message: 'This local server only forwards read-only routes.' });
    try {
      const r = await novig(p + url.search);
      res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(r.json ? JSON.stringify(r.json) : JSON.stringify({ code: 'UPSTREAM', message: r.text.slice(0, 300) }));
    } catch (e) {
      return json(res, 502, { code: 'UNREACHABLE', message: e.message });
    }
  }

  if (url.pathname === '/local/stream') {
    const id = crypto.randomUUID();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ client: id, max: CFG.streamMarkets })}\n\n`);
    clients.set(id, res);
    watchers.set(id, new Set());
    status();
    req.on('close', () => { clients.delete(id); watchers.delete(id); sync(); });
    return;
  }

  if (url.pathname === '/local/watch' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch { return json(res, 400, { code: 'BAD_JSON' }); }
      if (!watchers.has(data.client)) return json(res, 404, { code: 'NO_CLIENT' });
      const ids = (Array.isArray(data.markets) ? data.markets : []).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, CFG.streamMarkets);
      watchers.set(data.client, new Set(ids));
      sync();
      ids.forEach((mid) => { const b = bookJson(mid); if (b) clients.get(data.client).write(`event: book\ndata: ${JSON.stringify(b)}\n\n`); });
      status();
      json(res, 200, { ok: true, watching: ids.length });
    });
    return;
  }

  // Static files: the explorer itself.
  let file = path.normalize(path.join(SITE, decodeURIComponent(url.pathname)));
  const rel = path.relative(SITE, file);
  if (rel.startsWith('..') || path.isAbsolute(rel) || file.startsWith(HERE) || rel.split(path.sep).some((seg) => seg.startsWith('.')) || /\.(pem|key)$/i.test(file)) { res.writeHead(404); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
});

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

/* ---------------- start ---------------- */
console.log(`\n  Novig Explorer — local live server ${VERSION}`);
console.log(`  Key ${CFG.keyId.slice(0, 8)}… (${CFG.alg === 'ed25519' ? 'Ed25519' : 'P-256'}) → ${CFG.host}`);
server.on('error', (e) => fail(e.code === 'EADDRINUSE' ? `Port ${CFG.port} is busy. Close the other copy, or set "port" in config.json.` : e.message));
server.listen(CFG.port, '127.0.0.1', async () => {
  console.log(`  Open http://localhost:${CFG.port}  (Ctrl+C to stop)\n`);
  const check = await novig('/v3/limits').catch((e) => ({ status: 0, text: e.message, json: null }));
  if (check.status === 200) {
    console.log('  ✔ Key accepted');
  } else {
    const code = (check.json && check.json.code) || '';
    const msg = (check.json && check.json.message) || String(check.text || '').slice(0, 200);
    console.log(`  ✖ Novig refused the key check (${check.status}${code ? ' ' + code : ''}): ${msg}`);
    if (check.status === 451) console.log('    That is the location check: be in a state Novig serves, turn off any VPN, and open the Novig app on your phone so it geolocates.');
    if (check.status === 401 || check.status === 403) console.log("    Check the key ID, that the .pem is that key's private half, and that your computer clock is correct.");
    console.log('    The site still works; it uses public data until the key does.');
  }
  connect();
});
