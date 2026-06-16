# Deploy Garden to Render

## Prerequisites

- Code pushed to GitHub (private repo `heribish/garden`)
- [Supabase](supabase-setup.md) database with migrations applied
- [Render](https://render.com) account (free tier works)

## Steps

1. **Push to GitHub** (after `gh auth login`):
   ```powershell
   gh repo create garden --private --source=. --remote=origin --push
   ```
   Or if the repo already exists:
   ```powershell
   git remote add origin https://github.com/heribish/garden.git
   git push -u origin main
   ```

2. **Create Render Web Service**
   - Dashboard → **New +** → **Blueprint**
   - Connect GitHub account and select `heribish/garden`
   - Render reads [`render.yaml`](../render.yaml) automatically

3. **Set required secrets in Render**
   - `DATABASE_URL` — Supabase Postgres URI (use pooler in production)
   - `WEBHOOK_SECRET` — long random string (Render can auto-generate)
   - Optional: `RESEND_API_KEY`, `SMS_WEBHOOK_URL` for notifications

4. **Deploy**
   - Render builds with `npm install` and starts with `npm start`
   - Health check hits `/` (landing page)

5. **Post-deploy**
   - Run `npm run migrate:commerce` once against production DB if not done yet
   - Follow [public-launch-checklist.md](public-launch-checklist.md)

## Environment variables (production)

| Variable | Value |
|----------|-------|
| `NODE_ENV` | `production` |
| `ENABLE_DEV_TOOLS` | `0` |
| `DATABASE_URL` | Supabase connection string |
| `WEBHOOK_SECRET` | Strong random secret |
| `PORT` | `3780` (Render sets automatically) |
