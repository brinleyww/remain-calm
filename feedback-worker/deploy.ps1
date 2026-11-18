# Puts the feedback server on Cloudflare and gives it the owner key from .owner-key.txt (kept out of git).
# Run it from anywhere: powershell -ExecutionPolicy Bypass -File feedback-worker\deploy.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$toml = Get-Content wrangler.toml -Raw
if ($toml -match 'KV_ID_PLACEHOLDER') {
  # wrangler 3 would title the namespace "<worker>-<name>"; wrangler 4 uses the name as given
  $out = (npx --yes wrangler@4 kv namespace create remain-calm-feedback 2>&1 | Out-String)
  Write-Host $out
  $m = [regex]::Match($out, '"?id"?\s*[=:]\s*"([0-9a-f]{32})"')
  if (-not $m.Success) { throw 'Could not read the new KV namespace id. Put it into wrangler.toml by hand, then run this again.' }
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'wrangler.toml'), $toml.Replace('KV_ID_PLACEHOLDER', $m.Groups[1].Value))
  Write-Host "KV namespace remain-calm-feedback created ($($m.Groups[1].Value)) and written into wrangler.toml."
}

npx --yes wrangler@3 deploy
if ($LASTEXITCODE -ne 0) { throw 'wrangler deploy failed.' }

$keyFile = Join-Path $PSScriptRoot '.owner-key.txt'
if (-not (Test-Path $keyFile)) {
  node -e "require('fs').writeFileSync(process.argv[1], require('crypto').randomBytes(24).toString('base64url'))" $keyFile
}
Get-Content $keyFile -Raw | npx --yes wrangler@3 secret put OWNER_KEY
if ($LASTEXITCODE -ne 0) { throw 'Setting the OWNER_KEY secret failed.' }

Write-Host ''
Write-Host "Done. Your owner key is in $keyFile"
Write-Host 'Open the game with ?owner (or Feedback > Owner) and paste it in. Never commit or share that file.'
