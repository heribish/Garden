# Thin wrapper - use Node setup to avoid PowerShell encoding/parser issues.
# Prefer:  node scripts/configure-supabase.js

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..
node "$PSScriptRoot\configure-supabase.js"
exit $LASTEXITCODE
