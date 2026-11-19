# Puts the feedback server on Cloudflare and gives it the owner key from .owner-key.txt (kept out of git).
# Run it from anywhere: powershell -ExecutionPolicy Bypass -File feedback-worker\deploy.ps1
# npm prints warnings on stderr; Windows PowerShell 5 turns those into errors, so native commands run through cmd.
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

function Run([string]$line) {
  $out = (cmd /c "$line 2>&1" | Out-String)
  return @{ out = $out; code = $LASTEXITCODE }
}

$toml = Get-Content wrangler.toml -Raw
if ($toml -match 'KV_ID_PLACEHOLDER') {
  $id = $null
  # wrangler 3 would title the namespace "<worker>-<name>"; wrangler 4 uses the name as given
  $r = Run 'npx --yes wrangler@4 kv namespace create remain-calm-feedback'
  $m = [regex]::Match($r.out, '"?id"?\s*[=:]\s*"([0-9a-f]{32})"')
  if ($m.Success) { $id = $m.Groups[1].Value }
  else {
    # an earlier run may already have made it
    $l = Run 'npx --yes wrangler@4 kv namespace list'
    $j = [regex]::Match($l.out, '\[[\s\S]*\]')
    if ($j.Success) {
      $ns = ($j.Value | ConvertFrom-Json) | Where-Object { $_.title -eq 'remain-calm-feedback' } | Select-Object -First 1
      if ($ns) { $id = $ns.id }
    }
  }
  if (-not $id) { Write-Host $r.out; throw 'Could not create or find the KV namespace remain-calm-feedback. Put its id into wrangler.toml by hand, then run this again.' }
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'wrangler.toml'), $toml.Replace('KV_ID_PLACEHOLDER', $id))
  Write-Host "KV namespace remain-calm-feedback ($id) written into wrangler.toml."
}

$r = Run 'npx --yes wrangler@3 deploy'
Write-Host $r.out
if ($r.code -ne 0) { throw 'wrangler deploy failed (see above).' }

$keyFile = Join-Path $PSScriptRoot '.owner-key.txt'
if (-not (Test-Path $keyFile)) {
  node -e "require('fs').writeFileSync(process.argv[1], require('crypto').randomBytes(24).toString('base64url'))" $keyFile
}
$r = Run "type `"$keyFile`" | npx --yes wrangler@3 secret put OWNER_KEY"
if ($r.code -ne 0) { Write-Host $r.out; throw 'Setting the OWNER_KEY secret failed.' }

Write-Host ''
Write-Host "Done. Your owner key is in $keyFile"
Write-Host 'Open the game with ?owner (or Feedback > Owner) and paste it in. Never commit or share that file.'
