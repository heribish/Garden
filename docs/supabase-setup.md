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

## 3. Configure locally

Add to `.env`:

```env
DATABASE_URL=postgresql://postgres:...@db....supabase.co:5432/postgres
```

## 4. Run migrations

```bash
npm run migrate:commerce
```

You should see migration files applied from `db/migrations/`.

## 5. Verify

```bash
npm run dev
```

Sign up at `/shop`, place a test order, and check **Supabase → Table Editor** for new rows.

## Production notes

- Set `PGSSL=1` on your host if SSL is required.
- Never commit `.env` — only `.env.example`.
- Enable Supabase **automated backups** before real users.
- Use Row Level Security when you move sensitive reads to Supabase client SDK.
