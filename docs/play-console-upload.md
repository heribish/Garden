# Google Play Console upload — Garden

Do this **after** Garden is live on HTTPS and you have run:

```powershell
.\scripts\set-app-url.ps1 https://YOUR-APP.onrender.com
npm run mobile:android
```

## 0. One-time accounts & tools

1. Create a [Google Play Console](https://play.google.com/console) developer account (~US$25).
2. Install [Android Studio](https://developer.android.com/studio).
3. In Play Console → **Create app**
   - App name: `garden`
   - Default language: English (US) or Swahili
   - App/game: **App**
   - Free/paid: **Free**

## 1. App identity (must match Capacitor)

| Field | Value |
|--------|--------|
| Package name | `tz.garden.app` |
| App name | garden |
| Privacy policy | `https://YOUR-APP.onrender.com/privacy` |

## 2. Build a signed Android App Bundle (.aab)

1. Open the project: `npm run mobile:android`
2. Wait for Gradle sync.
3. **Build → Generate Signed App Bundle or APK…**
4. Choose **Android App Bundle**.
5. Create a new keystore (save the passwords offline — losing them blocks updates):
   - Suggested file: `garden-upload-key.jks` (outside git)
   - Alias: `garden`
6. Build variant: **release**
7. Output path is usually under `android/app/release/app-release.aab`

Never commit `.jks` / keystore passwords to git.

## 3. Play Console store listing

**Main store listing**

- Short description (≤80 chars): `Groceries & same-day delivery in Dar es Salaam`
- Full description: order from local vendors, track delivery, pay COD / mobile money when enabled
- App icon: `public/assets/icon-512.png`
- Feature graphic: 1024×500 (create a simple teal banner with “garden”)
- Phone screenshots: at least 2 of `/shop`, checkout, account (use an emulator or device)

**Categorization**

- App category: **Shopping** (or Food & Drink)
- Tags optional

**Store settings**

- Privacy policy URL: `https://YOUR-APP.onrender.com/privacy`
- Contact email: your admin email

## 4. Policy forms

Complete when Play asks:

1. **App content → Privacy policy**
2. **Data safety** — declare account info, approximate location (delivery), and that data is used for app functionality
3. **Content rating** questionnaire
4. **Target audience** — not primarily children
5. **News / COVID / Advertising ID** — answer honestly (Garden does not need Ads ID unless you add ads)

## 5. Upload & test track

1. **Testing → Internal testing → Create new release**
2. Upload `app-release.aab`
3. Add yourself as a tester
4. Install from the internal testing link and verify:
   - Opens your live HTTPS site
   - Sign in / catalog / support work
5. When stable: promote to **Closed** then **Production**

## 6. Common blockers

| Issue | Fix |
|--------|-----|
| App opens blank / local fallback | Re-run `set-app-url.ps1` with HTTPS URL, then `mobile:sync`, rebuild release |
| Package name clash | Keep `tz.garden.app` or change `GARDEN_APP_ID` before first Play upload |
| “Privacy policy required” | Deploy `/privacy` on the live site |
| Free Render sleep | Upgrade Render or use another always-on host so reviewers can open the app |

## 7. After production approval

Users install Garden from Play Store. Updates = bump `versionCode` / `versionName` in `android/app/build.gradle`, rebuild `.aab`, upload a new release.
