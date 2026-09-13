# garden

Tanzania marketplace — groceries, vendors, and drivers. Same-day delivery in Dar es Salaam with mobile money and cash on delivery.

## Quick start (local)

```bash
npm install
cp .env.example .env
npm run dev
```

- Landing page: http://127.0.0.1:3780/
- Shop: http://127.0.0.1:3780/shop
- Account: http://127.0.0.1:3780/account

## Database (Supabase or local Postgres)

1. Create a [Supabase](https://supabase.com) project and copy the Postgres connection string.
2. Set `DATABASE_URL` in `.env`.
3. Run migrations: `npm run migrate:commerce`

For local Postgres without Supabase: `docker compose up -d` then uncomment `DATABASE_URL` in `.env`.

## Deploy (Render)

1. Push this repo to GitHub.
2. In [Render](https://render.com), create a **Web Service** from the repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. Set environment variables from `.env.example` (use production values).

See [docs/public-launch-checklist.md](docs/public-launch-checklist.md) before inviting real users.

## Mobile apps (Google Play & App Store)

Native shells are set up with Capacitor.

- Overview: [docs/app-stores.md](docs/app-stores.md)
- Play upload steps: [docs/play-console-upload.md](docs/play-console-upload.md)

```powershell
# After Render is live:
.\scripts\set-app-url.ps1 https://YOUR-APP.onrender.com
npm run mobile:android   # Android Studio → signed .aab → Play Console
npm run mobile:ios       # macOS + Xcode → App Store Connect
```

Play Store works from Windows (install Android Studio first). App Store builds require a Mac and an Apple Developer account.

## Tests

```bash
npm test
```
