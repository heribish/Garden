# Publish Garden to Google Play & Apple App Store

Garden is a web marketplace. Store apps are **native shells** (Capacitor) that open your live HTTPS site inside Android / iOS. That is the standard path for a product like this.

## What is possible

| Store | Possible? | Notes |
|--------|-----------|--------|
| **Google Play** | Yes | Build an Android App Bundle (`.aab`) on Windows with Android Studio. |
| **Apple App Store** | Yes, with a Mac | Needs an Apple Developer account, a Mac with Xcode, and Apple review. Pure web wrappers sometimes get extra scrutiny (Guideline 4.2) — keep privacy/terms links, real product value, and a production URL. |

You cannot upload localhost apps. Stores require a **public HTTPS** backend (for example Render).

## Accounts you must create (one-time)

1. **Google Play Console** — https://play.google.com/console (~US$25 one-time)
2. **Apple Developer Program** — https://developer.apple.com/programs/ (US$99 / year)
3. Deploy Garden to HTTPS and set in `.env`:
   ```env
   PUBLIC_APP_URL=https://YOUR-APP.onrender.com
   GARDEN_APP_URL=https://YOUR-APP.onrender.com
   ```
4. Privacy & terms URLs (already in this repo once deployed):
   - `https://YOUR-APP.onrender.com/privacy`
   - `https://YOUR-APP.onrender.com/terms`

## Project commands

```bash
# Write capacitor.config.json from GARDEN_APP_URL / PUBLIC_APP_URL
npm run mobile:config

# Sync web shell into native projects
npm run mobile:sync

# Open Android Studio (Windows OK)
npm run mobile:android

# Open Xcode (macOS only)
npm run mobile:ios
```

First time only (already done if `android/` / `ios/` exist):

```bash
npm run mobile:config
npx cap add android
npx cap add ios
npm run mobile:sync
```

## Google Play (Android)

Full click-by-click guide: [play-console-upload.md](play-console-upload.md).

Wire your live URL, then open Android Studio:

```powershell
.\scripts\set-app-url.ps1 https://YOUR-APP.onrender.com
npm run mobile:android
```


## Apple App Store (iOS)

1. On a Mac: install Xcode + CocoaPods.
2. Set the same `GARDEN_APP_URL`.
3. Run `npm run mobile:sync` then `npm run mobile:ios`.
4. In Xcode: set Team (your Apple Developer team), unique Bundle ID `tz.garden.app`, version/build.
5. Archive → Distribute App → App Store Connect.
6. In App Store Connect: create the app, add screenshots (iPhone), privacy policy URL, age rating.
7. Submit for review.

## Listing copy (starter)

- **Name:** garden  
- **Subtitle:** Groceries & delivery in Dar  
- **Short description:** Order groceries from local vendors with same-day delivery in Dar es Salaam.  
- **Category:** Shopping / Food & Drink  

## Reality check

- I can prepare the Android/iOS projects and docs in this repo.
- **Only you** can create developer accounts, pay fees, upload builds, and click “Submit for review”.
- Until HTTPS production is live, use the Desktop **Garden** shortcut / PWA install for local use.

## Support pages in this repo

- Privacy: `/privacy`
- Terms: `/terms`
