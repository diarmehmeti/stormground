#!/usr/bin/env node
/* Stormground server - zero dependencies (Node 18+).
   Serves the game, creates accounts (email / Google), stores progress,
   and relays multiplayer (rooms, presence, events) over WebSockets. */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os'), https = require('https');

/* ---------- config (config.json or environment variables) ---------- */
let cfgFile = {};
try { cfgFile = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch (e) {}
const CFG = {
  port: +(process.env.PORT || cfgFile.port || 3000),
  googleClientId: process.env.GOOGLE_CLIENT_ID || cfgFile.googleClientId || '',
  contactEmail: process.env.CONTACT_EMAIL || cfgFile.contactEmail || 'your-email@example.com',
  androidPackage: process.env.ANDROID_PACKAGE || cfgFile.androidPackage || '',        /* e.g. com.yourname.stormground */
  playServiceAccount: process.env.PLAY_SERVICE_ACCOUNT_JSON || cfgFile.playServiceAccountFile || '', /* JSON text, or path to the JSON file */
  dataDir: process.env.DATA_DIR || cfgFile.dataDir || ''
};
const PUB = path.join(__dirname, 'public');
const DATA = CFG.dataDir ? path.resolve(CFG.dataDir) : path.join(__dirname, 'data');
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
const users = loadJSON('users.json', { byId: {}, byEmail: {}, byGoogle: {} });
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
function httpErr(status, msg) { const e = new Error(msg); e.status = status; return e; }
function socialUser(kind, sub, email) {
  const idx = users.byGoogle;
  if (idx[sub]) return users.byId[idx[sub]];
  let u = email && users.byEmail[email] ? users.byId[users.byEmail[email]] : null; /* link to an existing account with the same email */
  if (u) { (u[kind] = sub); } else {
    u = newUser({ email, provider: kind, [kind]: sub });
    if (email && !users.byEmail[email]) users.byEmail[email] = u.id;
  }
  idx[sub] = u.id; saveJSON('users.json', users); return u;
}

/* ---------- account deletion ---------- */
function deleteAccount(uid) {
  const u = users.byId[uid]; if (!u) return;
  if (u.email && users.byEmail[u.email] === uid) delete users.byEmail[u.email];
  if (u.google && users.byGoogle[u.google] === uid) delete users.byGoogle[u.google];
  delete users.byId[uid];
  delete docs['data/users/' + uid + '/profile']; delete docs['leaders/' + uid];
  saveJSON('users.json', users); saveJSON('db.json', docs);
  for (const c of [...conns]) if (c.uid === uid) { try { c.socket.destroy(); } catch (e) {} }
}

/* ---------- purchases (Google Play) ---------- */
const COIN_PACKS = { coins_300: 300, coins_800: 800, coins_2200: 2200, coins_5000: 5000, coins_12000: 12000 };
const purchases = loadJSON('purchases.json', {}); /* purchaseToken -> {uid, sku, t} (stops the same receipt being used twice) */
let saCache = null, tokCache = { t: 0, v: '' };
function playAccount() {
  if (saCache !== null) return saCache;
  let raw = CFG.playServiceAccount; saCache = false;
  try { if (raw && !raw.trim().startsWith('{')) raw = fs.readFileSync(raw, 'utf8'); if (raw) saCache = JSON.parse(raw); } catch (e) { console.error('Play service account could not be read:', e.message); }
  return saCache;
}
function httpsJSON(method, url, headers, body) {
  return new Promise((res, rej) => {
    const u = new URL(url), r = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers }, resp => {
      let s = ''; resp.on('data', c => s += c); resp.on('end', () => { let j = {}; try { j = JSON.parse(s); } catch (e) {} res({ status: resp.statusCode, json: j }); });
    });
    r.on('error', rej); if (body) r.write(body); r.end();
  });
}
async function playToken() {
  if (Date.now() < tokCache.t) return tokCache.v;
  const sa = playAccount(), now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' })), claim = b64u(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3000 }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(sa.private_key).toString('base64url');
  const body = 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + head + '.' + claim + '.' + sig;
  const r = await httpsJSON('POST', 'https://oauth2.googleapis.com/token', { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }, body);
  if (!r.json.access_token) throw httpErr(502, 'Could not reach Google Play.');
  tokCache = { t: Date.now() + 2800e3, v: r.json.access_token }; return tokCache.v;
}
async function handlePurchase(uid, b) {
  const sku = String(b.sku || ''), token = String(b.token || '');
  if (!COIN_PACKS[sku]) throw httpErr(400, 'Unknown item.');
  if (token.length < 10 || token.length > 2000) throw httpErr(400, 'Missing purchase token.');
  if (purchases[token]) { if (purchases[token].uid === uid) return { ok: true, coins: 0, duplicate: true }; throw httpErr(409, 'This purchase was already used.'); }
  if (playAccount() && CFG.androidPackage) {
    const t = await playToken();
    const r = await httpsJSON('GET', 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' + encodeURIComponent(CFG.androidPackage) + '/purchases/products/' + encodeURIComponent(sku) + '/tokens/' + encodeURIComponent(token), { Authorization: 'Bearer ' + t });
    if (r.status !== 200 || r.json.purchaseState !== 0) throw httpErr(402, 'Google Play did not confirm this purchase.');
  } else if (process.env.ALLOW_UNVERIFIED_PURCHASES !== '1') {
    throw httpErr(503, 'Purchases are not set up on this server yet.');
  }
  purchases[token] = { uid, sku, t: Date.now() }; saveJSON('purchases.json', purchases);
  return { ok: true, coins: COIN_PACKS[sku] };
}

/* ---------- legal pages (needed for the Play Store listing) ---------- */
const pageShell = (title, body) => '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + ' - Stormground</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:720px;margin:0 auto;padding:24px 18px;color:#14214f;background:#f4f7ff}h1{color:#2a63f0}h2{margin-top:28px}input,button{font:inherit;padding:10px 12px;border-radius:10px;border:2px solid #c7d1ff;margin:4px 0;width:100%;box-sizing:border-box}button{background:#d12b4a;color:#fff;border:0;font-weight:700;cursor:pointer}.ok{color:#1a8f4a;font-weight:700}.er{color:#d12b4a;font-weight:700}</style></head><body><h1>' + title + '</h1>' + body + '</body></html>';
const PAGES = {
  '/privacy': () => pageShell('Privacy Policy', '<p>Last updated: ' + new Date().toISOString().slice(0, 10) + '</p><p>Stormground ("the game") is an online multiplayer game. This page explains what we collect and why.</p><h2>What we collect</h2><ul><li><b>Account details:</b> your email address and a password (stored only as a one-way hash), or the email address from your Google account if you sign in with Google.</li><li><b>Game data:</b> your nickname, the age you entered at sign-up, coins, items you own, level, wins, eliminations and the look of your character.</li><li><b>Gameplay data:</b> while you play online, your nickname, character look, position and actions are shared with the other players in the same match.</li><li><b>Purchases:</b> if you buy coins, Google Play processes the payment. We receive a purchase token to confirm the purchase. We never see your card details.</li><li><b>Ads:</b> the Android app can show rewarded video ads through Google AdMob. AdMob may collect device identifiers and usage data to serve ads. See Google\'s privacy policy at policies.google.com/privacy.</li></ul><h2>What we do not collect</h2><p>We do not ask for your real name, address, phone number, contacts or precise location.</p><h2>How we use it</h2><p>To run your account, save your progress, show the leaderboard, make multiplayer work, process purchases and keep the game fair and safe.</p><h2>Age</h2><p>The game is for players aged 9 and over. Younger players should not use it. Players under 13 (or the age required where they live) should have a parent\'s permission. If you believe a child under 9 has an account, contact us and we will delete it.</p><h2>Sharing</h2><p>We do not sell your data. Your nickname, look and in-match actions are visible to other players. Service providers such as our hosting provider, Google Play and Google AdMob process data on our behalf.</p><h2>Deleting your data</h2><p>You can delete your account and all its data inside the game (menu, "Delete account") or on the page <a href="/delete-account">/delete-account</a>. Deletion removes your account, progress and leaderboard entry.</p><h2>Contact</h2><p>' + CFG.contactEmail + '</p>'),
  '/terms': () => pageShell('Terms of Use', '<p>By playing Stormground you agree to these terms.</p><ul><li>No cheating, hacking, or abusing bugs. No rude, hateful or impersonating names.</li><li>Coins and items are virtual. They have no cash value, cannot be traded or refunded (except where the law or Google Play rules require it), and give no gameplay advantage.</li><li>The game is for players aged 9 and over. Younger players need a parent\'s permission to play or buy anything.</li><li>We may remove accounts that break these rules, and may update the game and these terms. Continuing to play means you accept the changes.</li></ul><p>Contact: ' + CFG.contactEmail + '</p>'),
  '/delete-account': () => pageShell('Delete your account', '<p>This permanently deletes your Stormground account, progress, coins, items and leaderboard entry. It cannot be undone.</p><input id="e" type="email" placeholder="Email" autocomplete="email"><input id="p" type="password" placeholder="Password" autocomplete="current-password"><button id="b">Delete my account</button><p id="m"></p><p>Signed up with Google? Open the game, go to the menu and press "Delete account".</p><script>document.getElementById("b").onclick=async()=>{const m=document.getElementById("m");m.className="";m.textContent="Working...";try{let r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:e.value,password:p.value})});let j=await r.json();if(!r.ok)throw new Error(j.error||"Sign in failed");r=await fetch("/api/delete-account",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+j.token},body:JSON.stringify({password:p.value})});j=await r.json();if(!r.ok)throw new Error(j.error||"Failed");m.className="ok";m.textContent="Your account was deleted."}catch(x){m.className="er";m.textContent=x.message}}</script>')
};

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
function cors(res) { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); }
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
    return send(res, 200, { google: CFG.googleClientId || '', purchases: !!(playAccount() && CFG.androidPackage) || process.env.ALLOW_UNVERIFIED_PURCHASES === '1' });
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
    if (!u || !u.hash) throw httpErr(401, u ? 'This account uses Google sign-in.' : 'Wrong email or password.');
    const a = Buffer.from(hashPw(pw.slice(0, 100), u.salt)), c = Buffer.from(u.hash);
    if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) throw httpErr(401, 'Wrong email or password.');
    return send(res, 200, { token: makeToken(u.id), user: pub(u) });
  }
  if (route === '/api/google') { const g = await verifyGoogle(b.credential); const u = socialUser('google', g.sub, g.verified ? g.email : ''); return send(res, 200, { token: makeToken(u.id), user: pub(u) }); }
  const uid = authUid(req);
  if (!uid) throw httpErr(401, 'Please sign in.');
  if (route === '/api/me') return send(res, 200, pub(users.byId[uid]));
  if (route === '/api/delete-account') {
    const u = users.byId[uid];
    if (u.hash) { /* email accounts must confirm with their password */
      const a = Buffer.from(hashPw(String(b.password || '').slice(0, 100), u.salt)), c = Buffer.from(u.hash);
      if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) throw httpErr(401, 'Wrong password.');
    }
    deleteAccount(uid);
    return send(res, 200, { ok: true });
  }
  if (route === '/api/purchase') return send(res, 200, await handlePurchase(uid, b));
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
    if (pathname.startsWith('/api/')) { cors(res); if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); } await api(req, res, pathname); }
    else if (PAGES[pathname]) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGES[pathname]()); }
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
  console.log('  Play purchases: ' + (playAccount() && CFG.androidPackage ? 'verified with Google Play' : 'not configured (see docs/LISTING.md)'));
  console.log('  Data folder: ' + DATA + '\n');
  ensureThree().then(ok => console.log(ok ? '  three.js ready (cached for offline use)' : '  three.js could not be downloaded; the browser will load it from the CDN instead'));
});
