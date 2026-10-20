/* Adds the AdMob app id and landscape lock to the generated Android project (safe to run many times). */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), cfg = JSON.parse(fs.readFileSync(path.join(root, 'app.config.json'), 'utf8'));
const f = path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
if (!fs.existsSync(f)) { console.log('android/ not created yet, skipping patch.'); process.exit(0); }
let x = fs.readFileSync(f, 'utf8');
x = x.replace(/<meta-data android:name="com\.google\.android\.gms\.ads\.APPLICATION_ID"[^>]*\/>\s*/g, '');
x = x.replace('</application>', '    <meta-data android:name="com.google.android.gms.ads.APPLICATION_ID" android:value="' + cfg.admobAppId + '"/>\n    </application>');
if (!/screenOrientation=/.test(x)) x = x.replace('<activity', '<activity android:screenOrientation="sensorLandscape"');
fs.writeFileSync(f, x); console.log('AndroidManifest.xml patched.');
