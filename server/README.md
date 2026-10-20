# Stormground (self-hosted)

The game + account system + multiplayer server in one folder. No `npm install` needed, only Node.js 18 or newer (https://nodejs.org).

## Play with your other laptop (same Wi-Fi)

1. On laptop A, open a terminal in this folder and run: `node server.js`
2. It prints two addresses. On laptop A open `http://localhost:3000`.
3. On laptop B open the "Other devices" address it printed (like `http://192.168.1.23:3000`).
4. On each laptop choose "Create account" with a different email, finish the short setup, then press **Play** on both. You will land in the same server.
   (If B cannot connect: allow Node through the firewall on laptop A, and make sure both are on the same network.)

The first run downloads three.js once and keeps a copy, so the game works offline afterwards.

## Accounts

* **Email:** works out of the box. Passwords are stored hashed (scrypt). Progress, coins and outfits are saved on the server in `data/`.
* **Google button:** needs a key that only you can create. Until you add it the button is shown greyed out.

### Turn on Google sign-in
1. Go to https://console.cloud.google.com, APIs & Services, Credentials, Create credentials, OAuth client ID, type "Web application".
2. Add your site address under "Authorized JavaScript origins". Google only allows `http://localhost` or an `https://` address. A plain `http://192.168...` address will NOT work for Google, so test it on `http://localhost:3000` and use https for the real site.
3. Copy `config.example.json` to `config.json` and paste the client ID into `googleClientId`. Restart the server.

If someone signs in with Google using an email that already has an email account, they are linked to the same account.

## Putting it online for real
Run `node server.js` on a host with a public address (a VPS, Render, Railway, Fly.io...) behind https (needed for Google). Keep the `data/` folder on a persistent disk and keep `data/secret.key` private. Set `PORT` if your host asks for it. The key can also be given as the environment variable `GOOGLE_CLIENT_ID`.

## Notes
* Email addresses are not verified (no mail is sent) and there is no password reset yet.
* Data lives in `data/users.json` and `data/db.json`. Delete the `data/` folder to start fresh.
* Multiplayer is relayed through this server; the game limits a server to 20 players.

## Extra settings (environment variables or config.json)
`DATA_DIR` (where accounts are stored, use a persistent disk), `CONTACT_EMAIL` (shown in the privacy policy), `ANDROID_PACKAGE` and `PLAY_SERVICE_ACCOUNT_JSON` (verify Google Play purchases), `GOOGLE_CLIENT_ID`. Pages: `/privacy`, `/terms`, `/delete-account`. Full publishing guide: `../docs/LISTING.md`.
