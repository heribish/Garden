# Set DATABASE_URL in .env using your Supabase database password.
# Run: .\scripts\set-supabase-password.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

$envPath = Join-Path (Get-Location) ".env"
if (-not (Test-Path $envPath)) {
  Write-Host "Missing .env file."
  exit 1
}

Write-Host ""
Write-Host "Supabase Garden database password setup"
Write-Host "----------------------------------------"
Write-Host "Get your password from:"
Write-Host "  Supabase -> Project Settings (gear) -> Database -> Database password"
Write-Host ""
Write-Host "If you forgot it, click 'Reset database password' on that page."
Write-Host ""

$secure = Read-Host "Paste your database password here" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}

if (-not $password) {
  Write-Host "No password entered. Cancelled."
  exit 1
}

# URL-encode characters that break connection strings
$encoded = [uri]::EscapeDataString($password)

$content = Get-Content $envPath -Raw
# Remove duplicate DATABASE_URL / PGSSL lines, keep one clean block
$lines = $content -split "`r?`n"
$out = [System.Collections.Generic.List[string]]::new()
$seenDb = $false
foreach ($line in $lines) {
  if ($line -match '^\s*DATABASE_URL=') {
    if ($seenDb) { continue }
    $seenDb = $true
    $out.Add("DATABASE_URL=postgresql://postgres.fvtrigllwujrccryfiep:$encoded@aws-1-us-east-2.pooler.supabase.com:5432/postgres")
    continue
  }
  if ($line -match '^\s*PGSSL=') {
    if ($out -contains 'PGSSL=1') { continue }
    $out.Add('PGSSL=1')
    continue
  }
  if ($line -match 'REPLACE_ME|# Replace REPLACE_ME|# If password has special') { continue }
  $out.Add($line)
}
if (-not $seenDb) {
  $out.Add("DATABASE_URL=postgresql://postgres.fvtrigllwujrccryfiep:$encoded@aws-1-us-east-2.pooler.supabase.com:5432/postgres")
  $out.Add('PGSSL=1')
}
$content = ($out -join "`n").TrimEnd() + "`n"
Set-Content -Path $envPath -Value $content -NoNewline

Write-Host ""
Write-Host "Updated .env with your password (URL-encoded if needed)."
Write-Host "Running migrations..."
Write-Host ""

& "$PSScriptRoot\setup-database.ps1"
