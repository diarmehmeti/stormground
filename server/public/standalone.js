/* Stormground standalone connector.
   Provides the same window.claude.use('user' | 'db' | 'room') interface the game expects,
   backed by this server: accounts (email / Google), saved progress, and multiplayer rooms. */
(function () {
  'use strict';
  if (window.claude) return;
  var TOK = 'stormground.token';
  var store = {
    get: function (k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  var BASE = String(window.SG_SERVER || '').replace(/\/$/, '');
  var NATIVE = !!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform());
  var token = store.get(TOK), me = null, cfg = { google: '' };

  function api(p, body) {
    var h = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    return fetch(BASE + p, { method: p === '/api/config' ? 'GET' : 'POST', headers: h, body: p === '/api/config' ? undefined : JSON.stringify(body || {}) }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || 'Something went wrong.'); e.status = r.status; throw e; }
        return j;
      });
    });
  }

  /* ---------- sign-in screen ---------- */
  var css = '#sgAuth{position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;padding:12px;overflow:auto;background:radial-gradient(ellipse at 50% 30%,#8fe8ff 0%,#46b0ff 38%,#2a63f0 78%,#1d3fc8 100%);font-family:Nunito,system-ui,sans-serif}' +
    '#sgAuth .card{width:min(380px,100%);background:#fff;border-radius:22px;border:4px solid #1b2a7a;box-shadow:0 8px 0 rgba(10,20,90,.4);padding:16px 18px;color:#14214f;display:flex;flex-direction:column;gap:9px}' +
    '#sgAuth h1{margin:0;text-align:center;font:400 30px "Lilita One",Nunito,sans-serif;letter-spacing:.03em;color:#2a63f0;text-shadow:0 2px 0 #ffd23f}' +
    '#sgAuth .sub{text-align:center;font-size:13px;color:#5a6798;margin-top:-4px}' +
    '#sgAuth .tabs{display:flex;gap:6px}#sgAuth .tabs button{flex:1;border:0;border-radius:12px;padding:8px;font:800 14px Nunito,sans-serif;background:#e8edff;color:#2a3a8a;cursor:pointer}#sgAuth .tabs button.on{background:#2a63f0;color:#fff}' +
    '#sgAuth input{background:#fff;color:#14214f;font:700 16px Nunito,sans-serif;padding:10px 12px;border-radius:12px;border:2px solid #c7d1ff;outline:none;width:100%;box-sizing:border-box}#sgAuth input:focus{border-color:#2a63f0}' +
    '#sgAuth .go{border:0;border-radius:14px;padding:11px;font:400 20px "Lilita One",Nunito,sans-serif;color:#4a2b00;background:#ffd23f;box-shadow:0 4px 0 #d49a00;cursor:pointer}#sgAuth .go:disabled{opacity:.6}' +
    '#sgAuth .err{min-height:18px;color:#d12b4a;font-weight:800;font-size:13px;text-align:center}' +
    '#sgAuth .or{display:flex;align-items:center;gap:8px;color:#8a95c4;font-size:12px;font-weight:800}#sgAuth .or:before,#sgAuth .or:after{content:"";flex:1;height:2px;background:#e3e8ff}' +
    '#sgAuth .soc{display:flex;flex-direction:column;gap:8px;align-items:center}' +
    '#sgAuth .sbtn{width:100%;max-width:300px;border:2px solid #14214f;border-radius:999px;padding:9px 14px;font:800 15px Nunito,sans-serif;display:flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;background:#000;color:#fff}' +
    '#sgAuth .sbtn.g{background:#fff;color:#14214f}#sgAuth .sbtn[disabled]{opacity:.45;cursor:not-allowed}' +
    '#sgAuth small{text-align:center;color:#8a95c4;font-size:11px}' +
    '@media (max-height:520px){#sgAuth .card{padding:10px 14px;gap:6px}#sgAuth h1{font-size:24px}#sgAuth .sub{display:none}}';
  var GLOGO = '<svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.4-.4-3.9z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.9z"/></svg>';

  function showAuth() {
    return api('/api/config').then(function (c) { cfg = c; }, function () {}).then(function () {
      return new Promise(function (resolve) {
        var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
        var el = document.createElement('div'); el.id = 'sgAuth';
        el.innerHTML = '<div class="card"><h1>STORMGROUND</h1><div class="sub">Sign in to save your progress and play online.</div>' +
          '<div class="tabs"><button data-m="in" class="on">Sign in</button><button data-m="up">Create account</button></div>' +
          '<input id="sgE" type="email" autocomplete="email" placeholder="Email" maxlength="120">' +
          '<input id="sgP" type="password" autocomplete="current-password" placeholder="Password (8+ characters)" maxlength="100">' +
          '<div class="err" id="sgErr"></div><button class="go" id="sgGo">Sign in</button>' +
          '<div class="or">or</div><div class="soc"><div id="sgG"></div></div>' +
          '<small>Your email is only used to sign in.</small></div>';
        document.body.appendChild(el);
        var mode = 'in', $ = function (id) { return el.querySelector('#' + id); }, busy = false;
        function err(m) { $('sgErr').textContent = m || ''; }
        function done(j) { token = j.token; store.set(TOK, token); me = j.user; el.remove(); resolve(me); }
        function call(path, body) {
          if (busy) return; busy = true; err(''); $('sgGo').disabled = true;
          api(path, body).then(done, function (e) { err(e.message); }).then(function () { busy = false; $('sgGo').disabled = false; });
        }
        el.querySelectorAll('.tabs button').forEach(function (b) {
          b.onclick = function () {
            mode = b.dataset.m; el.querySelectorAll('.tabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
            $('sgGo').textContent = mode === 'in' ? 'Sign in' : 'Create account'; $('sgP').autocomplete = mode === 'in' ? 'current-password' : 'new-password'; err('');
          };
        });
        function submit() {
          var email = $('sgE').value.trim(), pw = $('sgP').value;
          if (!email || !pw) return err('Enter your email and password.');
          if (mode === 'up' && pw.length < 8) return err('Password must be at least 8 characters.');
          call(mode === 'in' ? '/api/login' : '/api/signup', { email: email, password: pw });
        }
        $('sgGo').onclick = submit;
        el.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });

        /* Google */
        var gbox = $('sgG');
        if (NATIVE) { gbox.style.display = 'none'; el.querySelector('.or').style.display = 'none'; }
        else if (cfg.google) {
          var s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
          s.onload = function () {
            try {
              google.accounts.id.initialize({ client_id: cfg.google, callback: function (r) { call('/api/google', { credential: r.credential }); } });
              google.accounts.id.renderButton(gbox, { theme: 'filled_blue', size: 'large', text: 'continue_with', shape: 'pill', width: 280 });
            } catch (e) { err('Google sign-in could not start.'); }
          };
          s.onerror = function () { err('Could not load Google sign-in.'); };
          document.head.appendChild(s);
        } else {
          gbox.innerHTML = '<button class="sbtn g" disabled title="Not set up on this server (see README)">' + GLOGO + ' Continue with Google</button>';
        }
      });
    });
  }

  var authP = null;
  function ensureAuth() {
    if (authP) return authP;
    authP = (token ? api('/api/me').then(function (u) { me = u; return u; }, function (e) {
      if (e.status === 401) { token = ''; store.del(TOK); return showAuth(); }
      throw e;
    }) : showAuth()).then(function (u) { addSignOut(); return u; });
    return authP;
  }
  function addSignOut() {
    var go = function () {
      var n = document.getElementById('netnote'); if (!n || document.getElementById('sgOut')) return !!n;
      var a = document.createElement('a'); a.id = 'sgOut'; a.href = '#'; a.textContent = 'Sign out' + (me && me.email ? ' (' + me.email + ')' : '');
      a.style.cssText = 'font-size:12px;color:#fff;font-weight:800;text-shadow:0 1px 2px rgba(0,0,0,.5);display:block;margin-top:2px;pointer-events:auto';
      a.onclick = function (e) { e.preventDefault(); store.del(TOK); location.reload(); };
      var d = document.createElement('a'); d.id = 'sgDel'; d.href = '#'; d.textContent = 'Delete account'; d.style.cssText = a.style.cssText + ';opacity:.8';
      d.onclick = function (e) {
        e.preventDefault();
        if (!confirm('Delete your account and all progress? This cannot be undone.')) return;
        var pw = '';
        if (me && me.provider === 'email') { pw = prompt('Enter your password to confirm:'); if (pw === null) return; }
        api('/api/delete-account', { password: pw }).then(function () { store.del(TOK); try { localStorage.clear(); } catch (x) {} alert('Your account was deleted.'); location.reload(); }, function (err) { alert(err.message); });
      };
      n.insertAdjacentElement('afterend', a); a.insertAdjacentElement('afterend', d); return true;
    };
    if (!go()) { var t = setInterval(function () { if (go()) clearInterval(t); }, 300); setTimeout(function () { clearInterval(t); }, 8000); }
  }

  /* ---------- database ---------- */
  function snap(id, data) { return { id: id, exists: data != null, data: function () { return data; } }; }
  function query(name, q) {
    return {
      where: function (f, o, v) { return query(name, Object.assign({}, q, { where: [f, o, v] })); },
      orderBy: function (f, d) { return query(name, Object.assign({}, q, { orderBy: [f, d || 'asc'] })); },
      limit: function (n) { return query(name, Object.assign({}, q, { limit: n })); },
      get: function () {
        return api('/api/db', Object.assign({ op: 'query', collection: name }, q)).then(function (j) {
          var d = j.docs.map(function (x) { return snap(x.id, x.data); });
          return { docs: d, empty: !d.length, size: d.length };
        });
      }
    };
  }
  var dbApi = {
    doc: function (p) {
      return {
        get: function () { return api('/api/db', { op: 'get', path: p }).then(function (j) { return snap(p.split('/').pop(), j.data); }); },
        set: function (d) { return api('/api/db', { op: 'set', path: p, data: d }); }
      };
    },
    collection: function (n) { return query(n, {}); }
  };

  /* ---------- realtime rooms ---------- */
  var ws = null, wsP = null, myPeer = '', handlers = {}, alive = false;
  function connect() {
    if (wsP) return wsP;
    wsP = new Promise(function (resolve, reject) {
      var s = new WebSocket((BASE ? BASE.replace(/^http/, 'ws') : (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host) + '/ws?token=' + encodeURIComponent(token));
      var opened = false;
      s.onmessage = function (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.t === 'hello') { myPeer = m.id; opened = true; alive = true; ws = s; resolve(); return; }
        var h = handlers[m.room]; if (h) h(m);
      };
      s.onclose = s.onerror = function () {
        if (!opened) { wsP = null; reject(new Error('offline')); return; }
        if (alive) { alive = false; Object.keys(handlers).forEach(function (k) { var r = rooms[k]; if (r) r._fail(); }); }
      };
    });
    return wsP;
  }
  function wsSend(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  var rooms = {};

  function Room(name) {
    var self = this;
    var peers = {}, myPres = null, topicCbs = {}, peerCbs = [], errCbs = [], pend = false;
    self.name = name;
    function list() {
      var out = [{ peer: myPeer, kind: 'viewer', sameTab: true, presence: myPres }];
      Object.keys(peers).forEach(function (id) { out.push({ peer: id, kind: 'viewer', sameTab: false, presence: peers[id] }); });
      return out;
    }
    function notify() {
      if (pend) return; pend = true;
      setTimeout(function () { pend = false; peerCbs.slice().forEach(function (f) { try { f(list()); } catch (e) {} }); }, 0);
    }
    handlers[name] = function (m) {
      if (m.t === 'peers') { peers = {}; m.peers.forEach(function (p) { peers[p.peer] = p.presence; }); notify(); }
      else if (m.t === 'pj') { peers[m.peer] = null; notify(); }
      else if (m.t === 'pl') { delete peers[m.peer]; notify(); }
      else if (m.t === 'pp') { peers[m.peer] = m.p; notify(); }
      else if (m.t === 'msg') { (topicCbs[m.topic] || []).slice().forEach(function (f) { try { f({ topic: m.topic, data: m.d, peer: m.peer, sameTab: false }); } catch (e) {} }); }
    };
    self._fail = function () { errCbs.slice().forEach(function (f) { try { f(new Error('disconnected')); } catch (e) {} }); };
    self.peers = list;
    self.presence = function (p) { myPres = p; wsSend({ t: 'pres', room: name, p: p }); notify(); return Promise.resolve(); };
    self.emit = function (topic, data) { wsSend({ t: 'emit', room: name, topic: topic, d: data }); return Promise.resolve(); };
    self.on = function (topic, cb, onErr) {
      (topicCbs[topic] = topicCbs[topic] || []).push(cb); if (onErr) errCbs.push(onErr);
      return function () { topicCbs[topic] = (topicCbs[topic] || []).filter(function (f) { return f !== cb; }); errCbs = errCbs.filter(function (f) { return f !== onErr; }); };
    };
    self.onPeers = function (cb, onErr) {
      peerCbs.push(cb); if (onErr) errCbs.push(onErr); setTimeout(function () { try { cb(list()); } catch (e) {} }, 0);
      return function () { peerCbs = peerCbs.filter(function (f) { return f !== cb; }); errCbs = errCbs.filter(function (f) { return f !== onErr; }); };
    };
    self.leave = function () { wsSend({ t: 'leave', room: name }); delete handlers[name]; delete rooms[name]; return Promise.resolve(); };
    self.join = function (n) { return joinRoom(n); };
    wsSend({ t: 'join', room: name });
  }
  function joinRoom(name) {
    return connect().then(function () { if (rooms[name]) rooms[name].leave(); var r = new Room(name); rooms[name] = r; return r; });
  }
  var lobbyP = null;

  window.claude = {
    use: function (name) {
      return ensureAuth().then(function () {
        if (name === 'user') return { id: function () { return Promise.resolve(me.id); }, email: me.email };
        if (name === 'db') return dbApi;
        if (name === 'room') return lobbyP || (lobbyP = joinRoom('lobby'));
        throw new Error('Unknown capability: ' + name);
      });
    }
  };
})();
