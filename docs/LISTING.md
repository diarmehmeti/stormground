# Stormground: publishing to Google Play, step by step

Read this top to bottom once, then follow it in order. Things written in `code style` are exact values to type or paste.

What I could not do for you: create your Google / AdMob accounts, pay the fee, or run the Android build (that needs Android Studio on your computer). I tested the server, the account system, the purchase check, and the in-game shop and ad buttons with simulated plugins. I did NOT test it on a real phone or with real Google Play. Test everything on the internal testing track before you go live.

---------------------------------------------------------------------

## 0. What is in this folder

- `server/` - the game server (accounts, saved progress, multiplayer, purchase check, privacy page). Run with `node server.js`.
- `android-app/` - the Android wrapper (Capacitor). It contains the build scripts, the in-app purchase and ads bridge (`mobile.js`) and your icon / splash.
- `docs/` - this guide and the images for your store listing (512x512 icon, 1024x500 feature graphic).

---------------------------------------------------------------------

## 1. Put the server on proper hosting (do this first)

The free Render plan sleeps and wipes accounts. For a real release you need always-on hosting and a disk that survives restarts.

On Render (paid, about $7 per month for the service and a few cents for the disk):
1. Upload the **contents of `server/`** to a GitHub repository (as before).
2. Render: New, Web Service, pick the repo. Build command `npm install`, start command `node server.js`, plan **Starter** (not Free).
3. Open the service, **Disks**, **Add Disk**: name `data`, mount path `/var/data`, size 1 GB.
4. Open **Environment** and add:
   - `DATA_DIR` = `/var/data`
   - `CONTACT_EMAIL` = your real support email (shown in the privacy policy)
   - `GOOGLE_CLIENT_ID` = (optional, only for Google sign-in on the website)
5. After it deploys, open these three addresses and check they load. You will paste the first one into Play Console:
   - `https://YOUR-SERVER.onrender.com/privacy`
   - `https://YOUR-SERVER.onrender.com/terms`
   - `https://YOUR-SERVER.onrender.com/delete-account`

Any other host that runs Node (Fly.io, Railway, a VPS) works the same way. Keep `DATA_DIR` on a persistent disk and back it up now and then (it is just JSON files).

---------------------------------------------------------------------

## 2. Create your accounts

1. **Google Play Console**: play.google.com/console. One-time $25 fee. You must verify your identity (ID document, and for some accounts a phone check). This can take a few days.
2. **AdMob**: admob.google.com, sign in with the same Google account.
3. Keep your Google Cloud account handy (console.cloud.google.com), you need it in step 5.

Important rule for new personal developer accounts: before you can publish to everyone ("production"), you must run a **closed test with at least 12 testers for 14 days in a row**. Plan for that. Ask 12 friends or family to give you their Gmail address and install the test version. (Check Google's current wording in the Play Console help, they change this.)

---------------------------------------------------------------------

## 3. Choose your app id and fill in the app config

Open `android-app/app.config.json` and set:
- `appId`: your permanent package name, e.g. `com.mehmet.stormground`. Lowercase, dots, no spaces. **You can never change it after publishing.**
- `server`: your https server address from step 1, e.g. `https://stormground.onrender.com` (no slash at the end).
- AdMob values: leave the test values for now (they show test ads). You change them in step 7.

---------------------------------------------------------------------

## 4. Build the app (on your computer)

Install once:
- Node.js 20 or newer (nodejs.org)
- Android Studio (developer.android.com/studio). Open it once and let it install the Android SDK.

Then in a terminal:
```
cd android-app
npm run setup
npm run icons
npm run open
```
- `npm run setup` installs everything, copies the game into the app and creates the Android project.
- `npm run icons` creates all the icon and splash sizes from `assets/icon.png` and `assets/splash.png`.
- `npm run open` opens the project in Android Studio.

In Android Studio:
1. Wait until the bottom bar finishes syncing (first time takes several minutes).
2. Plug in your phone (USB debugging on) or use an emulator and press the green Run button to try the app. Create an account, play, check the shop.
3. Release file: **Build, Generate Signed App Bundle / APK, Android App Bundle (.aab)**.
   - Click **Create new** keystore. Choose a strong password and **save the keystore file and passwords somewhere safe (cloud + USB). If you lose it you cannot update your app.**
   - Choose **release** and finish. The `.aab` file is what you upload to Google.
4. For every later update: change `versionCode` (add 1) and `versionName` in `android/app/build.gradle`, run `npm run sync` in the terminal, and build a new .aab.

If you change the game or server address later, run `npm run sync` again before building.

---------------------------------------------------------------------

## 5. Create the app in Play Console

1. **Create app**: name `Stormground: Battle Royale`, default language English, **Game**, **Free**, accept the declarations.
2. Open **Test and release, Testing, Internal testing**, create a release, upload your `.aab`, save and roll out. Add yourself as a tester (testers list, your Gmail). This works within minutes and is how you try the real thing on your phone through a link.
3. Let Google manage the signing key when asked (**Play App Signing**, recommended).

---------------------------------------------------------------------

## 6. Create the coin products (in-app purchases)

You can only do this after you uploaded a build that includes billing (step 5, point 2).

Play Console, **Monetize with Play, Products, In-app products, Create product**. Make exactly these five, with these exact ids, and set them to **Active**:

| Product ID | Name | Suggested price |
|---|---|---|
| `coins_300` | 300 Coins | $0.99 |
| `coins_800` | 800 Coins | $1.99 |
| `coins_2200` | 2,200 Coins | $4.99 |
| `coins_5000` | 5,000 Coins | $9.99 |
| `coins_12000` | 12,000 Coins | $19.99 |

Google converts the price to every country. Google keeps 15% of the first $1M you earn per year, then 30%.

To test buying for free: Play Console, **Settings, License testing**, add your Gmail. Purchases by license testers cost nothing.

---------------------------------------------------------------------

## 7. Make purchases verified (so nobody can fake a purchase)

The server asks Google "is this purchase real?" before it allows coins. For that it needs a key:

1. Google Cloud Console: create or pick a project, then **APIs & Services, Library**, search **Google Play Android Developer API**, **Enable**.
2. **IAM & Admin, Service accounts, Create service account** (name `stormground-play`). Open it, **Keys, Add key, Create new key, JSON**. A JSON file downloads. Keep it secret.
3. Play Console: **Users and permissions, Invite new users**. Paste the service account email (looks like `stormground-play@your-project.iam.gserviceaccount.com`). Give it the permissions **View financial data** and **Manage orders and subscriptions** for your app. Invite.
4. On Render, **Environment**, add:
   - `ANDROID_PACKAGE` = your appId from step 3
   - `PLAY_SERVICE_ACCOUNT_JSON` = open the downloaded JSON file in a text editor and paste the **whole text**
5. Redeploy. The server log should say `Play purchases: verified with Google Play`. (Google can take up to a day or two to activate a new service account.)

Until this is set, the server refuses purchases, which is the safe default.

---------------------------------------------------------------------

## 8. Ads (AdMob rewarded videos)

The shop shows "Watch a video: +50 coins" (max 10 per day per device). Rewarded video is the type players do not mind.

1. admob.google.com, **Apps, Add app**, platform Android. If it is not published yet choose "No", you can link it later.
2. Copy the **App ID** (`ca-app-pub-xxxxxxxxxxxxxxxx~yyyyyyyyyy`).
3. In the app, **Ad units, Add ad unit, Rewarded**. Name `coins_video`. Reward amount `50`, item `coins`. Copy the **Ad unit ID** (`ca-app-pub-xxxxxxxxxxxxxxxx/zzzzzzzzzz`).
4. In `android-app/app.config.json` set `admobAppId`, `admobRewardedId` and change `"admobTest"` to `false`. Then run `npm run sync` and build a new .aab.
5. **Never tap your own real ads.** While developing keep `"admobTest": true`.
6. After the app is live, in AdMob link it to your Play Store listing.

---------------------------------------------------------------------

## 9. Fill in the store listing

Play Console, **Grow, Store presence, Main store listing**.

**App name** (max 30): `Stormground: Battle Royale`

**Short description** (max 80):
`Cartoon battle royale! Loot, dodge the storm and be the last one standing.`

**Full description** (max 4000), paste this:
```
Drop onto a floating island with 19 other players, grab weapons, and outlast the shrinking storm. The last player standing wins!

THE FUN
- Fast 3D cartoon battle royale: every match fits in a few minutes
- Loot guns of every rarity: scatter blasters, snipers, plasma rifles, miniguns, crossbows and more
- Health packs, shields, speed boosts, treasure chests and supply drops
- Five colorful maps: tropical, desert, frost, candy and volcano
- Dash through bullets and out-play your rivals
- Jump into a random server in one tap, or create a private server and share the code with friends

MAKE IT YOURS
- Dozens of outfits, hats, faces, backpacks, blasters and trails
- Try everything on before you buy
- Victory emotes to celebrate your win
- Daily gift, daily challenges and a leaderboard

SIMPLE CONTROLS
- Left thumb to move, right thumb to aim and fire
- Big FIRE and DASH buttons, hold TAKE to grab loot

Stormground is free to play. It contains optional in-app purchases for virtual coins and rewarded video ads. Players aged 9 and up.
```

**Graphics:**
- App icon: `docs/play-store-icon-512.png`
- Feature graphic: `docs/play-store-feature-graphic-1024x500.png`
- Phone screenshots: you need at least 2 (8 is best). Run the game on your phone in landscape and take screenshots (menu, customize screen, lobby, a fight, a victory). Landscape screenshots are fine for a landscape game. Do NOT edit the screenshots to add things that are not in the game.

**Category:** Game, Action. **Email:** your support email. **Website:** your server address (optional).

---------------------------------------------------------------------

## 10. App content (the questionnaires)

Play Console, **Policy and programs, App content**. Answers that fit this game:

- **Privacy policy:** `https://YOUR-SERVER.onrender.com/privacy`
- **App access:** "All or some functionality is restricted". Give reviewers a working login: create a test account in the game (for example `review@yourdomain.com` and a password) and enter it there. Without this they reject the app.
- **Ads:** Yes, the app contains ads.
- **Content rating (questionnaire):** category *Game*. Violence: yes, cartoon / fantasy violence against fictional characters, no blood, no realistic violence. Users can interact: yes (other players see your nickname and character, **there is no text or voice chat**). Shares location: no. Digital purchases: yes. Gambling: no. You will get an age rating like PEGI 7 / ESRB Everyone 10+.
- **Target audience:** choose **13 and over** (simplest). Your own sign-up asks for age 9 or older. If you choose an audience that includes children under 13, Google's Families policy applies (stricter ads and data rules). If you want 9-12 year olds, read that policy first and ask me to adapt the ads (child-directed settings) before you submit.
- **Data safety:**
  - Collected data: Email address, User IDs (account id), Purchase history, App activity (game progress), Other in-app content (nickname, character look), and Device or other IDs (advertising id, collected by AdMob).
  - Purpose: App functionality, Account management, Advertising.
  - Data shared with third parties: yes for the advertising id (Google AdMob). Not sold.
  - Encrypted in transit: **Yes** (https).
  - Users can request deletion: **Yes**. Deletion URL: `https://YOUR-SERVER.onrender.com/delete-account`. (The app also has a Delete account link under the menu.)
- **Advertising ID:** Yes, the app uses it (AdMob).
- **Government app, Financial features, Health:** No.
- **News app:** No.

---------------------------------------------------------------------

## 11. Test, then go live

1. **Internal testing** (step 5): install on your phone, create an account, play, buy a coin pack as a license tester, watch a rewarded video (with test ads). Check Leave, Start, shop, customize, and the lobby on your phone.
2. **Closed testing**: Test and release, Testing, Closed testing. Create a release (same .aab), add 12+ testers (Gmail addresses or a Google Group) and send them the opt-in link. Keep it running 14 days.
3. **Apply for production**: Dashboard shows an "Apply for production" step once the closed test requirement is met. Answer the questions honestly (what you tested, what you fixed).
4. **Production release**: create the release, choose countries, submit for review. First review usually takes a few days, sometimes longer.

---------------------------------------------------------------------

## 12. Known limits (be honest with yourself)

- **Google sign-in is hidden inside the Android app.** Google blocks its web sign-in inside app web views. The app uses email sign-up. (Google sign-in still works on the website. Adding the native Google sign-in plugin later is possible, ask me.)
- **Coins and progress are stored from the player's device.** Real purchases are verified by Google and can only be used once, but a tech-savvy player could still edit their own coin count. The next step for serious money is making the server keep the coin balance. Ask me when you are ready.
- Emails are not verified and there is no password reset yet. Players who forget their password lose the account. Add this before a big launch.
- **iPhone / App Store is not included.** That needs a Mac, an Apple developer account ($99/year) and Apple's own purchase system.
- Multiplayer needs the server to stay online. If it is down, players see "Lost connection".
- I could not test the Android build, Google Play Billing or AdMob on a real device. If something fails, send me the exact error text from Android Studio (the Logcat) or the Play Console and I will fix it.

## 13. Common problems

- `npm run setup` says "Edit android-app/app.config.json first": you did not change `appId` / `server` yet.
- "Purchases are not set up on this server yet": step 7 not done or the service account is not active yet.
- Purchase shows "Purchase failed": check the Render logs; make sure the product ids match exactly and are Active, and the app was installed from the testing track (not as a side-loaded file).
- Blank white screen in the app: the server address in `app.config.json` is wrong or the server is asleep. Open the address in a phone browser to check.
