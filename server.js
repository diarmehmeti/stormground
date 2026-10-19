#!/usr/bin/env node
/* Stormground server - zero dependencies (Node 18+).
   Serves the game, creates accounts (email / Google / Apple), stores progress,
   and relays multiplayer (rooms, presence, events) over WebSockets. */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os'), https = require('https');

/* ---------- config (config.json or environment variables) ---------- */
let cfgFile = {};
try { cfgFile = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch (e) {}
const CFG = {
  port: +(process.env.PORT || cfgFile.port || 3000),
  googleClientId: process.env.GOOGLE_CLIENT_ID || cfgFile.googleClientId || '',
  appleClientId: process.env.APPLE_CLIENT_ID || cfgFile.appleClientId || '',        // Apple "Services ID"
  appleRedirectUri: process.env.APPLE_REDIRECT_URI || cfgFile.appleRedirectUri || ''  // must be https
};
const PUB = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

/* ---------- tiny JSON store ---------- */
function loadJSON(f, d) { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch (e) { return d; } }
const timers = {};
function saveJSON(f, obj) {
  clearTimeout(timers[f]);
  timers[f] = setTimeout(() => {
    const tmp = path.join(DATA, f + '.tmp');
    try { fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, path.join(DATA, f)); } catch (e) { console.error('save failed', e.message); }
  }, 300);
}
const users = loadJSON('users.json', { byId: {}, byEmail: {}, byGoogle: {}, byApple: {} });
const docs = loadJSON('db.json', {});
let SECRET;
try { SECRET = fs.readFileSync(path.join(DATA, 'secret.key'), 'utf8'); } catch (e) { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(path.join(DATA, 'secret.key'), SECRET, { mode: 0o600 }); }

/* ---------- auth helpers ---------- */
const b64u = b => Buffer.from(b).toString('base64url');
function makeToken(uid) {
  const body = uid + '.' + (Date.now() + 60 * 864e5);
  return body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
}
function readToken(t) {
  if (typeof t !== 'string') return null;
  const p = t.split('.'); if (p.length !== 3) return null;
  const body = p[0] + '.' + p[1];
  const good = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(good), b = Buffer.from(p[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (+p[1] < Date.now()) return null;
  return users.byId[p[0]] ? p[0] : null;
}
function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }
function newUser(fields) {
  const id = 'u' + crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'x');
  const u = Object.assign({ id, created: Date.now() }, fields);
  users.byId[id] = u; saveJSON('users.json', users); return u;
}
const pub = u => ({ id: u.id, email: u.email || '', provider: u.provider });
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,200}\.[^\s@]{2,}$/;
const attempts = new Map(); /* ip+email -> {n, t} */
function throttled(key) {
  const a = attempts.get(key), t = Date.now();
  if (!a || t - a.t > 10 * 60e3) { attempts.set(key, { n: 1, t }); return false; }
  a.n++; return a.n > 12;
}
function getJSON(url) {
  return new Promise((res, rej) => https.get(url, r => { let s = ''; r.on('data', c => s += c); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on('error', rej));
}
async function verifyGoogle(credential) {
  if (!CFG.googleClientId) throw httpErr(503, 'Google sign-in is not set up on this server.');
  const j = await getJSON('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
  if (!j || j.aud !== CFG.googleClientId || !j.sub || !['accounts.google.com', 'https://accounts.google.com'].includes(j.iss) || +j.exp * 1000 < Date.now()) throw httpErr(401, 'Google sign-in failed.');
  return { sub: j.sub, email: (j.email || '').toLowerCase(), verified: j.email_verified === 'true' || j.email_verified === true };
}
let appleKeys = { t: 0, keys: [] };
async function verifyApple(idToken) {
  if (!CFG.appleClientId) throw httpErr(503, 'Apple sign-in is not set up on this server.');
  const parts = String(idToken).split('.'); if (parts.length !== 3) throw httpErr(401, 'Apple sign-in failed.');
  const head = JSON.parse(Buffer.from(parts[0], 'base64url')), claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  if (Date.now() - appleKeys.t > 36e5) { appleKeys = { t: Date.now(), keys: (await getJSON('https://appleid.apple.com/auth/keys')).keys || [] }; }
  const jwk = appleKeys.keys.find(k => k.kid === head.kid); if (!jwk || head.alg !== 'RS256') throw httpErr(401, 'Apple sign-in failed.');
  const ok = crypto.createVerify('RSA-SHA256').update(parts[0] + '.' + parts[1]).verify(crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  if (!ok || claims.iss !== 'https://appleid.apple.com' || claims.aud !== CFG.appleClientId || +claims.exp * 1000 < Date.now()) throw httpErr(401, 'Apple sign-in failed.');
  return { sub: claims.sub, email: (claims.email || '').toLowerCase() };
}
function httpErr(status, msg) { const e = new Error(msg); e.status = status; return e; }
function socialUser(kind, sub, email) {
  const idx = kind === 'google' ? users.byGoogle : users.byApple;
  if (idx[sub]) return users.byId[idx[sub]];
  let u = email && users.byEmail[email] ? users.byId[users.byEmail[email]] : null; /* link to an existing account with the same email */
  if (u) { (u[kind] = sub); } else {
    u = newUser({ email, provider: kind, [kind]: sub });
    if (email && !users.byEmail[email]) users.byEmail[email] = u.id;
  }
  idx[sub] = u.id; saveJSON('users.json', users); return u;
}

/* ---------- API routes ---------- */
const MAXBODY = 64 * 1024;
function readBody(req) {
  return new Promise((res, rej) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > MAXBODY) { rej(httpErr(413, 'Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { res(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch (e) { rej(httpErr(400, 'Bad JSON')); } });
    req.on('error', rej);
  });
}
function send(res, code, obj) { const s = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(s); }
const authUid = req => { const h = req.headers.authorization || ''; return readToken(h.startsWith('Bearer ') ? h.slice(7) : ''); };

const isNum = v => typeof v === 'number' && isFinite(v);
function cleanLeader(d) {
  if (!d || typeof d !== 'object') throw httpErr(400, 'Bad data');
  return { name: String(d.name || 'Player').slice(0, 30), nameLower: String(d.nameLower || '').slice(0, 30), wins: isNum(d.wins) ? Math.max(0, d.wins | 0) : 0, kills: isNum(d.kills) ? Math.max(0, d.kills | 0) : 0, matches: isNum(d.matches) ? Math.max(0, d.matches | 0) : 0, t: Date.now() };
}
function handleDb(uid, b) {
  const p = String(b.path || '');
  const mine = p.match(/^data\/users\/([\w-]+)\/profile$/), lead = p.match(/^leaders\/([\w-]+)$/);
  if (b.op === 'get') {
    if (mine) { if (mine[1] !== uid) throw httpErr(403, 'Not allowed'); return { data: docs[p] || null }; }
    if (lead) return { data: docs[p] || null };
    throw httpErr(403, 'Not allowed');
  }
  if (b.op === 'set') {
    if (mine) {
      if (mine[1] !== uid) throw httpErr(403, 'Not allowed');
      const s = JSON.stringify(b.data); if (!s || s.length > 30000) throw httpErr(413, 'Too large');
      docs[p] = JSON.parse(s);
    } else if (lead) {
      if (lead[1] !== uid) throw httpErr(403, 'Not allowed');
      const d = cleanLeader(b.data);
      if (d.nameLower) for (const k in docs) if (k.startsWith('leaders/') && k !== p && docs[k].nameLower === d.nameLower) throw httpErr(409, 'That name is taken.');
      docs[p] = d;
    } else throw httpErr(403, 'Not allowed');
    saveJSON('db.json', docs); return { ok: true };
  }
  if (b.op === 'query') {
    if (b.collection !== 'leaders') throw httpErr(403, 'Not allowed');
    let rows = Object.keys(docs).filter(k => k.startsWith('leaders/')).map(k => ({ id: k.slice(8), data: docs[k] }));
    if (Array.isArray(b.where) && b.where[1] === '==' && /^(nameLower|name)$/.test(b.where[0])) rows = rows.filter(r => r.data[b.where[0]] === b.where[2]);
    if (Array.isArray(b.orderBy) && /^(wins|kills|matches)$/.test(b.orderBy[0])) { const f = b.orderBy[0], s = b.orderBy[1] === 'asc' ? 1 : -1; rows.sort((x, y) => s * ((x.data[f] || 0) - (y.data[f] || 0))); }
    return { docs: rows.slice(0, Math.min(50, Math.max(1, b.limit | 0 || 50))) };
  }
  throw httpErr(400, 'Bad op');
}

async function api(req, res, route) {
  if (route === '/api/config') {
    return send(res, 200, { google: CFG.googleClientId || '', apple: CFG.appleClientId ? { clientId: CFG.appleClientId, redirectURI: CFG.appleRedirectUri } : null });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const b = await readBody(req);
  const ip = req.socket.remoteAddress || '';
  if (route === '/api/signup') {
    const email = String(b.email || '').trim().toLowerCase(), pw = String(b.password || '');
    if (!EMAIL_RE.test(email)) throw httpErr(400, 'Enter a valid email address.');
    if (pw.length < 8 || pw.length > 100) throw httpErr(400, 'Password must be at least 8 characters.');
    if (throttled('s' + ip)) throw httpErr(429, 'Too many tries. Wait a few minutes.');
    if (users.byEmail[email]) throw httpErr(409, 'That email already has an account. Sign in instead.');
    const salt = crypto.randomBytes(16).toString('hex');
    const u = newUser({ email, provider: 'email', salt, hash: hashPw(pw, salt) });
    users.byEmail[email] = u.id; saveJSON('users.json', users);
    return send(res, 200, { token: makeToken(u.id), user: pub(u) });
  }
  if (route === '/api/login') {
    const email = String(b.email || '').trim().toLowerCase(), pw = String(b.password || '');
    if (throttled('l' + ip + email)) throw httpErr(429, 'Too many tries. Wait a few minutes.');
    const u = users.byId[users.byEmail[email]];
    if (!u || !u.hash) throw httpErr(401, u ? 'This account uses Google or Apple sign-in.' : 'Wrong email or password.');
    const a = Buffer.from(hashPw(pw.slice(0, 100), u.salt)), c = Buffer.from(u.hash);
    if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) throw httpErr(401, 'Wrong email or password.');
    return send(res, 200, { token: makeToken(u.id), user: pub(u) });
  }
  if (route === '/api/google') { const g = await verifyGoogle(b.credential); const u = socialUser('google', g.sub, g.verified ? g.email : ''); return send(res, 200, { token: makeToken(u.id), user: pub(u) }); }
  if (route === '/api/apple') { const a = await verifyApple(b.id_token); const u = socialUser('apple', a.sub, a.email); return send(res, 200, { token: makeToken(u.id), user: pub(u) }); }
  const uid = authUid(req);
  if (!uid) throw httpErr(401, 'Please sign in.');
  if (route === '/api/me') return send(res, 200, pub(users.byId[uid]));
  if (route === '/api/db') return send(res, 200, handleDb(uid, b));
  throw httpErr(404, 'Not found');
}

/* ---------- static files ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
let threeBusy = null;
function ensureThree() { /* download three.js once so the game also works offline afterwards */
  const f = path.join(PUB, 'three.min.js');
  if (fs.existsSync(f) && fs.statSync(f).size > 100000) return Promise.resolve(true);
  if (threeBusy) return threeBusy;
  threeBusy = new Promise(ok => {
    https.get(THREE_URL, r => {
      if (r.statusCode !== 200) { r.resume(); return ok(false); }
      const ch = []; r.on('data', c => ch.push(c)); r.on('end', () => { try { fs.writeFileSync(f, Buffer.concat(ch)); ok(true); } catch (e) { ok(false); } });
    }).on('error', () => ok(false));
  }).then(v => { threeBusy = null; return v; });
  return threeBusy;
}
async function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/three.min.js' && !(await ensureThree())) { res.writeHead(302, { Location: THREE_URL }); return res.end(); }
  const f = path.normalize(path.join(PUB, decodeURIComponent(pathname)));
  if (!f.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': pathname === '/index.html' ? 'no-cache' : 'public, max-age=3600' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  try {
    if (pathname.startsWith('/api/')) await api(req, res, pathname);
    else await serveStatic(req, res, pathname);
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
    if (!e.status) console.error(e);
  }
});

/* ---------- WebSocket (hand-rolled, RFC 6455) ---------- */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function wsSend(c, obj) {
  if (c.dead || c.socket.writableLength > 600000) return; /* drop for slow clients */
  const data = Buffer.from(JSON.stringify(obj)), n = data.length;
  let head;
  if (n < 126) head = Buffer.from([0x81, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  try { c.socket.write(Buffer.concat([head, data])); } catch (e) {}
}
const rooms = new Map(); /* name -> Map(peerId -> conn) */
const conns = new Set();
const ROOM_RE = /^[\w-]{1,40}$/;
function bcast(room, obj, except) { const m = rooms.get(room); if (m) for (const c of m.values()) if (c !== except) wsSend(c, obj); }
function leaveRoom(c, room) {
  const m = rooms.get(room); if (!m || !c.rooms.has(room)) return;
  m.delete(c.id); c.rooms.delete(room);
  if (!m.size) rooms.delete(room); else bcast(room, { t: 'pl', room, peer: c.id });
}
function onMsg(c, msg) {
  const room = typeof msg.room === 'string' && ROOM_RE.test(msg.room) ? msg.room : null; if (!room) return;
  if (msg.t === 'join') {
    if (c.rooms.has(room) || c.rooms.size >= 4) return;
    let m = rooms.get(room); if (!m) rooms.set(room, m = new Map());
    const peers = []; for (const o of m.values()) peers.push({ peer: o.id, presence: o.pres[room] || null });
    m.set(c.id, c); c.rooms.add(room); c.pres[room] = null;
    wsSend(c, { t: 'peers', room, peers });
    bcast(room, { t: 'pj', room, peer: c.id }, c);
  } else if (msg.t === 'pres') {
    if (!c.rooms.has(room)) return;
    const s = JSON.stringify(msg.p); if (s && s.length > 8000) return;
    c.pres[room] = msg.p === undefined ? null : msg.p;
    bcast(room, { t: 'pp', room, peer: c.id, p: c.pres[room] }, c);
  } else if (msg.t === 'emit') {
    if (!c.rooms.has(room) || typeof msg.topic !== 'string' || msg.topic.length > 12) return;
    bcast(room, { t: 'msg', room, topic: msg.topic, d: msg.d, peer: c.id }, c);
  } else if (msg.t === 'leave') leaveRoom(c, room);
}
server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  const uid = url.pathname === '/ws' ? readToken(url.searchParams.get('token')) : null;
  const key = req.headers['sec-websocket-key'];
  if (!uid || !key) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + crypto.createHash('sha1').update(key + WS_GUID).digest('base64') + '\r\n\r\n');
  socket.setNoDelay(true);
  let id; do { id = crypto.randomBytes(4).toString('hex'); } while ([...conns].some(x => x.id === id));
  const c = { id, uid, socket, rooms: new Set(), pres: {}, dead: false, buf: Buffer.alloc(0), frag: [], rate: 0, rateT: Date.now() };
  conns.add(c); wsSend(c, { t: 'hello', id });
  const close = () => { if (c.dead) return; c.dead = true; conns.delete(c); for (const r of [...c.rooms]) leaveRoom(c, r); try { socket.destroy(); } catch (e) {} };
  socket.on('data', chunk => {
    c.buf = Buffer.concat([c.buf, chunk]);
    for (;;) {
      const b = c.buf; if (b.length < 2) return;
      const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80; let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > 65536 || !masked) return close();
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4), payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      c.buf = b.subarray(off + 4 + len);
      if (op === 8) return close();
      if (op === 9) { try { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload.subarray(0, 125)])); } catch (e) {} continue; }
      if (op === 1 || op === 0) {
        c.frag.push(payload); if (!fin) { if (c.frag.reduce((a, x) => a + x.length, 0) > 65536) return close(); continue; }
        const text = Buffer.concat(c.frag).toString(); c.frag = [];
        const t = Date.now(); if (t - c.rateT > 1000) { c.rateT = t; c.rate = 0; }
        if (++c.rate > 200) continue; /* flood guard */
        let msg; try { msg = JSON.parse(text); } catch (e) { continue; }
        if (msg && typeof msg === 'object') onMsg(c, msg);
      }
    }
  });
  socket.on('close', close); socket.on('error', close); socket.on('end', close);
});

server.listen(CFG.port, '0.0.0.0', () => {
  console.log('\n  STORMGROUND server running\n');
  console.log('  On this computer:  http://localhost:' + CFG.port);
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log('  Other devices (same Wi-Fi/network):  http://' + i.address + ':' + CFG.port);
  console.log('\n  Email sign-up: ready');
  console.log('  Google sign-in: ' + (CFG.googleClientId ? 'ready' : 'not configured (see README)'));
  console.log('  Apple sign-in:  ' + (CFG.appleClientId ? 'ready' : 'not configured (see README)') + '\n');
  ensureThree().then(ok => console.log(ok ? '  three.js ready (cached for offline use)' : '  three.js could not be downloaded; the browser will load it from the CDN instead'));
});
