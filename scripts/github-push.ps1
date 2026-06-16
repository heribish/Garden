# Push Garden to GitHub (run after gh auth login)

$ErrorActionPreference = "Stop"
$env:Path = "C:\Program Files\Git\bin;C:\Program Files\GitHub CLI;" + $env:Path

$repo = "garden"
$owner = "heribish"

Write-Host "Checking GitHub authentication..."
gh auth status
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "Not logged in. Run: gh auth login -h github.com -p https -w"
  Write-Host "Then open https://github.com/login/device and enter the code shown."
  exit 1
}

Write-Host "Creating private repo $owner/$repo (skips if it already exists)..."
gh repo view "$owner/$repo" 2>$null
if ($LASTEXITCODE -ne 0) {
  gh repo create $repo --private --description "Tanzania marketplace — groceries, vendors, and drivers" --confirm
}

$remote = git remote get-url origin 2>$null
if (-not $remote) {
  git remote add origin "https://github.com/$owner/$repo.git"
}

git branch -M main
Write-Host "Pushing to origin main..."
git push -u origin main

Write-Host "Done. Repo: https://github.com/$owner/$repo"
