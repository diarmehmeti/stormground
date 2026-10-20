/* Copies the web game into www/ for the Android app and writes the config files. */
const fs = require('fs'), path = require('path'), https = require('https');
const root = path.join(__dirname, '..'), pub = path.join(root, '..', 'server', 'public'), www = path.join(root, 'www');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'app.config.json'), 'utf8'));
if (/YOUR-SERVER/.test(cfg.server) || /yourname/.test(cfg.appId)) { console.error('\nEdit android-app/app.config.json first: set "server" to your real https server address and "appId" to your own id.\n'); process.exit(1); }
fs.rmSync(www, { recursive: true, force: true }); fs.mkdirSync(www, { recursive: true });
let html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const tag = '<script src="/three.min.js"></script>\n<script src="/standalone.js"></script>';
if (!html.includes(tag)) { console.error('Could not find the script tags in server/public/index.html'); process.exit(1); }
html = html.replace(tag, '<script src="three.min.js"></script>\n<script src="config.js"></script>\n<script src="standalone.js"></script>\n<script src="mobile.js"></script>');
fs.writeFileSync(path.join(www, 'index.html'), html);
fs.copyFileSync(path.join(pub, 'standalone.js'), path.join(www, 'standalone.js'));
fs.copyFileSync(path.join(root, 'mobile.js'), path.join(www, 'mobile.js'));
fs.writeFileSync(path.join(www, 'config.js'), 'window.SG_SERVER=' + JSON.stringify(cfg.server.replace(/\/$/, '')) + ';\nwindow.SG_APP=' + JSON.stringify({ admobRewardedId: cfg.admobRewardedId, admobTest: !!cfg.admobTest }) + ';\n');
fs.writeFileSync(path.join(root, 'capacitor.config.json'), JSON.stringify({ appId: cfg.appId, appName: cfg.appName, webDir: 'www', android: { allowMixedContent: false } }, null, 2));
const cached = path.join(root, 'three.min.js');
function done() { fs.copyFileSync(cached, path.join(www, 'three.min.js')); console.log('www/ ready.'); }
if (fs.existsSync(cached) && fs.statSync(cached).size > 100000) done();
else https.get('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js', r => {
  if (r.statusCode !== 200) { console.error('Could not download three.js (status ' + r.statusCode + '). Download https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js and save it as android-app/three.min.js, then run again.'); process.exit(1); }
  const ch = []; r.on('data', c => ch.push(c)); r.on('end', () => { fs.writeFileSync(cached, Buffer.concat(ch)); done(); });
}).on('error', e => { console.error('Download failed: ' + e.message); process.exit(1); });
