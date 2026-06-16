# Next steps (one-time setup)

Complete these in order. Everything else is already prepared in this repo.

## 1. GitHub — push your code (~2 min)

A browser window may have opened for GitHub login. If not:

```powershell
gh auth login -h github.com -p https -w
```

Open https://github.com/login/device and enter the code shown in the terminal.

Then run:

```powershell
.\scripts\github-push.ps1
```

This creates the private repo `heribish/garden` and pushes `main`.

**Alternative:** Create the repo manually on GitHub (Private, no README), then:

```powershell
git remote add origin https://github.com/heribish/garden.git
git push -u origin main
```

## 2. Supabase — production database (~5 min)

Follow [docs/supabase-setup.md](supabase-setup.md), then:

```powershell
.\scripts\setup-database.ps1
```

## 3. Render — go live (~10 min)

Follow [docs/deploy-render.md](deploy-render.md). Connect your GitHub repo and set `DATABASE_URL` from Supabase.

## Verify

```powershell
npm test
```

After deploy, open your Render URL and check `/`, `/shop`, and `/account`.
