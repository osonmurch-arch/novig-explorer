// One-time setup: use your Novig MANAGEMENT key to create a READ-ONLY (trading::read) key for the explorer.
//
//   node make-read-key.mjs      (or double-click make-read-key.cmd on Windows)
//
// It reads config.json (which should hold your management key), then:
//   1. picks one of your subaccounts, or opens a new one if you have none (no money moves),
//   2. asks Novig for a trading::read key on it, generating the keypair on this computer,
//   3. saves the new private key next to your management key file and points config.json at it.
// Nothing changes on your Novig account until you confirm. Private keys never leave this computer.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(HERE, 'config.json');

const say = (s = '') => console.log('  ' + s);
function stop(msg) { console.log('\n  ✖ ' + msg + '\n'); process.exit(1); }

/* ---------- config and key ---------- */
if (!fs.existsSync(CONFIG)) stop('No config.json yet. Run start.cmd once to create it, put your management key ID and key file in it, then run this again.');
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const HOST = (process.env.NOVIG_HOST || cfg.host || 'https://api.novig.com').replace(/\/+$/, '');
let keyPath = path.resolve(HERE, cfg.keyFile || '');
if (!fs.existsSync(keyPath) && fs.existsSync(keyPath + '.txt')) keyPath += '.txt';
if (!cfg.keyId || !fs.existsSync(keyPath)) stop('config.json needs "keyId" and "keyFile" for your management key.');

function readKey(text) {
  const t = text.replace(/^﻿/, '').replace(/\r/g, '').trim();
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t)) {
    return crypto.createPrivateKey(t.replace(/-----(BEGIN|END) ([A-Z ]+)-----/g, '\n-----$1 $2-----\n').replace(/\n{2,}/g, '\n').trim() + '\n');
  }
  const der = Buffer.from(t.replace(/\s+/g, ''), 'base64');
  if (der.length === 32) return crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), der]), format: 'der', type: 'pkcs8' });
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}
let MGMT;
try { MGMT = readKey(fs.readFileSync(keyPath, 'utf8')); } catch (e) { stop(`Couldn't read ${keyPath} as a private key: ${e.message}`); }

/* ---------- NOVIG-V3 signing ---------- */
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
function canonicalQuery(raw) {
  if (!raw) return '';
  return raw.split('&').filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    const [k, v] = i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)];
    const d = (x) => { try { return decodeURIComponent(x); } catch { return x; } };
    return [enc(d(k)), enc(d(v))];
  }).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
}
let skew = 0;
function signed(key, keyId, method, pathAndQuery, body = '') {
  const [p, q = ''] = pathAndQuery.split(/\?(.*)/s);
  const ts = String(Date.now() + skew);
  const canonical = ['NOVIG-V3', ts, method, p, canonicalQuery(q), crypto.createHash('sha256').update(body).digest('hex')].join('\n');
  const sig = key.asymmetricKeyType === 'ed25519'
    ? crypto.sign(null, Buffer.from(canonical), key)
    : crypto.sign('sha256', Buffer.from(canonical), { key, dsaEncoding: 'der' });
  return { 'Novig-Key-Id': keyId, 'Novig-Timestamp': ts, 'Novig-Signature': sig.toString('base64') };
}
async function call(method, p, bodyObj, key = MGMT, keyId = cfg.keyId) {
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  const headers = { ...signed(key, keyId, method, p, body), Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(HOST + p, { method, headers, body: body || undefined });
  const date = res.headers.get('date');
  if (date) { const d = Date.parse(date) - Date.now(); if (Math.abs(d) > 5000) skew = d; }
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* html */ }
  return { status: res.status, json, text };
}
const why = (r) => `${r.status}${r.json && r.json.code ? ' ' + r.json.code : ''}${r.json && r.json.message ? ': ' + r.json.message : r.text ? ': ' + r.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) : ''}`;
function explain(r) {
  if (r.status === 451) say('  → Location check: turn off any VPN, be in a state Novig serves, and open the Novig app on your phone so it geolocates.');
  if (r.status === 401) say('  → Key not accepted: check keyId matches this key file, and your PC clock (Settings → Time → Sync now).');
  if (r.status === 403 && r.json && /KYC/.test(r.json.code || '')) say('  → Novig needs your identity verification (KYC) finished in the app first.');
}

function newKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicPem: publicKey.export({ type: 'spki', format: 'pem' }), privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }), privateKey };
}

/* ---------- run ---------- */
// Answers are read line by line, so this works typed in a window or piped in.
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
let waiters = [];
let closed = false;
rl.on('line', (l) => { if (waiters.length) waiters.shift()(l); else lines.push(l); });
rl.on('close', () => { closed = true; waiters.forEach((w) => w('')); waiters = []; });
function ask(q) {
  process.stdout.write('  ' + q);
  if (lines.length) return Promise.resolve(lines.shift().trim());
  if (closed) return Promise.resolve('');
  return new Promise((res) => waiters.push((x) => res(String(x).trim())));
}

console.log('\n  Novig Explorer — make a read-only key\n');
say(`Using key ${cfg.keyId.slice(0, 8)}… from ${keyPath}`);

// 1. Is this the management key?
const keys = await call('GET', '/v3/keys').catch((e) => ({ status: 0, text: e.message }));
if (keys.status !== 200) {
  const asRead = await call('GET', '/v3/types/sports').catch(() => ({ status: 0 }));
  if (asRead.status === 200) {
    say('✔ This key can already read markets. You don’t need this setup: just run start.cmd.');
    rl.close(); process.exit(0);
  }
  console.log(); say(`✖ Novig didn't accept this as a management key (${why(keys)}).`); explain(keys);
  rl.close(); process.exit(1);
}
say('✔ Management key accepted');

// 2. Pick or open a subaccount.
const subsRes = await call('GET', '/v3/account/subaccounts');
if (subsRes.status !== 200) { say(`✖ Couldn't list your subaccounts (${why(subsRes)}).`); explain(subsRes); rl.close(); process.exit(1); }
const subs = Array.isArray(subsRes.json) ? subsRes.json : (subsRes.json && subsRes.json.items) || [];
let sub = null;
let opening = false;
console.log();
if (subs.length) {
  say(`You have ${subs.length} subaccount${subs.length === 1 ? '' : 's'}:`);
  subs.forEach((s, i) => say(`  ${i + 1}. ${s.label || '(no label)'}  — balance $${Number(s.balance || 0).toFixed(2)}`));
  say('A read-only key can see markets only. It can’t trade or move this subaccount’s money.');
  const pick = await ask(subs.length === 1 ? 'Add a read-only key to it? Type yes to continue: ' : `Which one gets the read-only key? Type its number (or n to stop): `);
  if (subs.length === 1) { if (!/^y(es)?$/i.test(pick)) { say('Stopped. Nothing was changed.'); rl.close(); process.exit(0); } sub = subs[0]; }
  else { const n = Number(pick); if (!(n >= 1 && n <= subs.length)) { say('Stopped. Nothing was changed.'); rl.close(); process.exit(0); } sub = subs[n - 1]; }
} else {
  say('You have no subaccounts yet. Novig puts API keys on subaccounts, so this will:');
  say('  • open a subaccount called "explorer" with a $0 balance (no money moves), and');
  say('  • give it a read-only key that can see markets but can’t trade or move money.');
  say('Opening a subaccount also makes a trading key for it. This program throws that key’s private half');
  say('away immediately, so nobody can trade with it; you can replace it later from your management key.');
  const ok = await ask('Type yes to continue: ');
  if (!/^y(es)?$/i.test(ok)) { say('Stopped. Nothing was changed.'); rl.close(); process.exit(0); }
  opening = true;
}

if (opening) {
  const trading = newKeypair(); // private half is never saved
  const r = await call('POST', '/v3/account/subaccounts', { algorithm: 'Ed25519', label: 'explorer', publicKey: trading.publicPem });
  if (r.status !== 201 && r.status !== 200) { say(`✖ Novig didn't open the subaccount (${why(r)}).`); explain(r); rl.close(); process.exit(1); }
  sub = r.json;
  say(`✔ Opened subaccount "${sub.label}"`);
}

// 3. Mint the read-only key.
const reader = newKeypair();
const r = await call('POST', `/v3/account/subaccounts/${sub.keyId}/keys`, { algorithm: 'Ed25519', name: 'explorer-read', publicKey: reader.publicPem, scope: 'trading::read' });
if (r.status !== 201 && r.status !== 200) { say(`✖ Novig didn't create the read-only key (${why(r)}).`); explain(r); rl.close(); process.exit(1); }
const readKeyId = r.json.keyId;
say(`✔ Read-only key created: ${readKeyId.slice(0, 8)}…`);

// 4. Save it beside the management key and point config.json at it.
const dir = path.dirname(keyPath);
let out = path.join(dir, 'novig-read.pem');
for (let i = 2; fs.existsSync(out); i++) out = path.join(dir, `novig-read-${i}.pem`);
fs.writeFileSync(out, reader.privatePem, { mode: 0o600 });
const next = { ...cfg, keyId: readKeyId, keyFile: out.replace(/\\/g, '/') };
fs.writeFileSync(CONFIG, JSON.stringify(next, null, 2) + '\n');
say(`✔ Saved it to ${out}`);
say('✔ config.json now uses the read-only key');

// 5. Check it works.
await new Promise((res) => setTimeout(res, 1500));
const check = await call('GET', '/v3/types/sports', null, reader.privateKey, readKeyId);
console.log();
if (check.status === 200) say('✔ The read-only key works. Double-click start.cmd to see live markets.');
else { say(`The key was made, but its first check came back ${why(check)}.`); explain(check); say('Give it a minute and run start.cmd; the window will say whether it works.'); }
console.log();
say('Your management key is no longer used by this program. It can move money, so keep');
say(`${keyPath} somewhere safe, or delete it: you can always make a new one on novig.com.`);
console.log();
rl.close();
