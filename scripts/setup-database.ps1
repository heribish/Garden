# Apply database migrations (Supabase or local Postgres)
# Usage: set DATABASE_URL in .env first, then run this script.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

if (-not (Test-Path .env)) {
  Write-Host "Missing .env - copy .env.example to .env and set DATABASE_URL"
  exit 1
}

$envContent = Get-Content .env -Raw
if ($envContent -notmatch '(?m)^DATABASE_URL=(?!#)(\S+)') {
  Write-Host ""
  Write-Host "DATABASE_URL is not set in .env."
  Write-Host ""
  Write-Host "Option A - run the password helper:"
  Write-Host "  .\scripts\set-supabase-password.ps1"
  Write-Host ""
  Write-Host "Option B - edit .env manually:"
  Write-Host "  DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@db.fvtrigllwujrccryfiep.supabase.co:5432/postgres"
  Write-Host "  PGSSL=1"
  Write-Host ""
  Write-Host "Get password: Supabase -> Project Settings -> Database"
  exit 1
}

if ($envContent -match 'REPLACE_ME') {
  Write-Host ""
  Write-Host "DATABASE_URL still has placeholder REPLACE_ME."
  Write-Host "Run: .\scripts\set-supabase-password.ps1"
  Write-Host "Or edit .env and put your real Supabase database password."
  exit 1
}

Write-Host "Running commerce migrations..."
npm run migrate:commerce
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Migrations applied successfully."
