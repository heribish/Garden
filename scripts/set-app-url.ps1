# Set Garden production URL for Capacitor / store builds
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$AppUrl
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root ".env"

$url = $AppUrl.Trim().TrimEnd("/")
if ($url -notmatch '^https://') {
  throw "App URL must be https://... (got: $AppUrl)"
}

if (-not (Test-Path $envFile)) {
  Copy-Item (Join-Path $root ".env.example") $envFile
}

$raw = Get-Content $envFile -Raw
function Set-EnvKey([string]$text, [string]$key, [string]$value) {
  $line = "$key=$value"
  if ($text -match "(?m)^#?\s*$key=.*$") {
    return [regex]::Replace($text, "(?m)^#?\s*$key=.*$", $line)
  }
  return $text.TrimEnd() + "`r`n$line`r`n"
}

$raw = Set-EnvKey $raw "PUBLIC_APP_URL" $url
$raw = Set-EnvKey $raw "GARDEN_APP_URL" $url
Set-Content -Path $envFile -Value $raw -NoNewline
Write-Host "Updated .env:"
Write-Host "  PUBLIC_APP_URL=$url"
Write-Host "  GARDEN_APP_URL=$url"

Push-Location $root
try {
  npm run mobile:sync
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "Next:"
Write-Host "  1. Confirm site: $url/shop"
Write-Host "  2. Confirm legal: $url/privacy  and  $url/terms"
Write-Host "  3. npm run mobile:android"
Write-Host "  4. Follow docs/play-console-upload.md"
