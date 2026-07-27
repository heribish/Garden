# Supabase setup for Garden

## 1. Create project

1. Go to https://supabase.com and sign in.
2. **New project** → name it `garden` (or similar).
3. Choose a strong database password and save it securely.
4. Region: **Europe (Frankfurt)** is the closest option for Tanzania today.

## 2. Get connection string

1. **Project Settings → Database**
2. Under **Connection string**, choose **URI**
3. Copy the string and replace `[YOUR-PASSWORD]` with your database password.

Example:

```env
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@db.xxxxxxxxxxxx.supabase.co:5432/postgres
```

For production hosting with many connections, use the **Session pooler** URI (port `6543`) instead.

## 3. Rotate password (required if the old password was ever exposed)

1. Supabase → **Project Settings → Database**
2. Click **Reset database password**
3. Save the new password somewhere secure (password manager)
4. Never reuse a password that appeared in chat, screenshots, or git history

## 4. Configure locally (recommended)

From the project root in PowerShell:

```powershell
.\scripts\configure-supabase.ps1
```

Paste the full URI (with the new password). The script will:

- write `DATABASE_URL` + `PGSSL=1` into `.env`
- test the connection
- run `npm run migrate:commerce`
- create/promote admin `heribish@gmail.com`

Or edit `.env` manually:

```env
DATABASE_URL=postgresql://postgres:...@db....supabase.co:5432/postgres
PGSSL=1
```

Then:

```bash
npm run migrate:commerce
npm run create:admin -- --email heribish@gmail.com --password "your-strong-password" --name "Heribish"
```

## 5. Verify

```bash
npm run dev
```

Sign in as `heribish@gmail.com`, open `/admin`, and confirm tables exist under **Supabase → Table Editor**.

## Production notes

- Set `PGSSL=1` on your host if SSL is required.
- Never commit `.env` — only `.env.example`.
- Enable Supabase **automated backups** before real users.
- Use Row Level Security when you move sensitive reads to Supabase client SDK.
