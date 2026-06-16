# Apply database migrations (Supabase or local Postgres)
# Usage: set DATABASE_URL in .env first, then run this script.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

if (-not (Test-Path .env)) {
  Write-Host "Missing .env — copy .env.example to .env and set DATABASE_URL"
  exit 1
}

$envContent = Get-Content .env -Raw
if ($envContent -notmatch '(?m)^DATABASE_URL=(?!#)(\S+)') {
  Write-Host @"

DATABASE_URL is not set in .env.

1. Create a Supabase project: https://supabase.com
2. Copy the Postgres URI from Project Settings -> Database
3. Add to .env:
   DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@db.xxx.supabase.co:5432/postgres

See docs/supabase-setup.md for full steps.

"@
  exit 1
}

Write-Host "Running commerce migrations..."
npm run migrate:commerce
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Migrations applied successfully."
