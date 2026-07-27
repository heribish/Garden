# Publish Garden to GitHub + Render (run from project root)
# Prerequisites: git configured, Supabase DATABASE_URL ready for Render env

$ErrorActionPreference = "Stop"
$env:Path = "C:\Program Files\Git\bin;C:\Program Files\GitHub CLI;" + $env:Path

Write-Host "=== Garden publish ===" -ForegroundColor Cyan

Write-Host "`n1. Running tests..."
npm test
if ($LASTEXITCODE -ne 0) { throw "Tests failed — fix before publishing." }

Write-Host "`n2. Checking git status..."
$dirty = git status --porcelain
if ($dirty) {
  Write-Host "Uncommitted changes detected. Stage and commit first, then re-run."
  git status -sb
  exit 1
}

Write-Host "`n3. Pushing to GitHub..."
git push origin main
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "Push failed. If auth is the issue, run: gh auth login -h github.com -p https -w"
  Write-Host "Or push manually: git push -u origin main"
  exit 1
}

Write-Host "`n=== Code is on GitHub ===" -ForegroundColor Green
Write-Host "Repo: https://github.com/heribish/Garden"
Write-Host ""
Write-Host "=== Render (one-time setup) ===" -ForegroundColor Yellow
Write-Host "1. Open https://dashboard.render.com → New → Blueprint"
Write-Host "2. Connect GitHub repo heribish/Garden"
Write-Host "3. Set these secrets when prompted:"
Write-Host "   DATABASE_URL  = Supabase Session pooler URI (port 6543)"
Write-Host "   ALLOWED_ADMIN_EMAILS = heribish@gmail.com"
Write-Host "   PGSSL=1 (already in render.yaml)"
Write-Host "4. Deploy — build runs migrations automatically"
Write-Host "5. After first deploy, create admin locally:"
Write-Host '   $env:DATABASE_URL="<production-uri>"; $env:PGSSL="1"; npm run create:admin -- --email heribish@gmail.com'
Write-Host ""
Write-Host "Live URL will appear in Render dashboard (e.g. https://garden.onrender.com)"
