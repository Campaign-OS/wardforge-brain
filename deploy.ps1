$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

Write-Host "-> Committing & pushing to GitHub" -ForegroundColor Cyan
Set-Location $root
git add -A
git commit -m "deploy" --allow-empty | Out-Null
git push

Write-Host "-> Deploying worker" -ForegroundColor Cyan
Set-Location "$root\worker"
npx wrangler deploy

Write-Host "-> Building & deploying frontend" -ForegroundColor Cyan
Set-Location "$root\frontend"
npm run build
npx wrangler pages deploy dist --project-name=wardforge-brain-ui --branch=main

Set-Location $root
Write-Host "Done" -ForegroundColor Green
