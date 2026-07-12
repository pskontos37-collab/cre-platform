# deploy_vercel.ps1 - production deploy via the Vercel REST API (no local Node).
# Files are referenced by SHA1 in POST /v13/deployments; Vercel replies
# `missing_files` for blobs it doesn't have, which we upload to /v2/files and
# retry. (The old base64-inline payload hit the API's 10MB request cap.)
# Env vars (VITE_*) live on the Vercel project, so .env is never uploaded.
# vercel.json overrides the build to `vite build` (tsc skipped - no Node here).
param(
  [string]$Target = 'production'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) {
  $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim()
}
$tok     = $cfg['VERCEL_TOKEN']
$team    = 'team_8u90qS4wCl8RhHbboldHZyzT'
$project = 'prj_dGADWiLryETbJ5inT8pUZOHg7jYJ'

$rootFiles = @('index.html','package.json','vercel.json','vite.config.ts',
               'tsconfig.json','tsconfig.app.json','tsconfig.node.json',
               'tailwind.config.js','postcss.config.js')

$sha1 = [Security.Cryptography.SHA1]::Create()
$files = New-Object System.Collections.Generic.List[object]
$blobs = @{}   # sha -> raw bytes, for the upload step
function Add-File([string]$abs, [string]$rel) {
  $bytes = [IO.File]::ReadAllBytes($abs)
  $sha = (($sha1.ComputeHash($bytes)) | ForEach-Object { $_.ToString('x2') }) -join ''
  $files.Add(@{ file = $rel; sha = $sha; size = $bytes.Length })
  $blobs[$sha] = $bytes
}
foreach ($f in $rootFiles) { if (Test-Path "$repo\$f") { Add-File "$repo\$f" $f } }
foreach ($dir in @('src','public')) {
  if (Test-Path "$repo\$dir") {
    Get-ChildItem "$repo\$dir" -Recurse -File | ForEach-Object {
      $rel = $_.FullName.Substring($repo.Length + 1) -replace '\\','/'
      Add-File $_.FullName $rel
    }
  }
}
Write-Output "Deploying $($files.Count) files to Vercel ($Target)..."

# A preview deployment is created by OMITTING `target` (the API only accepts
# 'production' / 'staging' there). Only send target for those.
$payload = @{ name = 'cre-platform'; project = $project; files = $files }
if ($Target -eq 'production' -or $Target -eq 'staging') { $payload['target'] = $Target }
$body = $payload | ConvertTo-Json -Depth 6 -Compress
$bodyBytes = [Text.Encoding]::UTF8.GetBytes($body)

function New-Deployment {
  try {
    return Invoke-RestMethod -Method Post -Uri "https://api.vercel.com/v13/deployments?teamId=$team&forceNew=1" `
      -Headers @{ Authorization = "Bearer $tok" } -ContentType 'application/json' `
      -Body $bodyBytes -TimeoutSec 300
  } catch {
    $raw = $_.ErrorDetails.Message
    if (-not $raw) {
      $resp = $_.Exception.Response
      if ($null -eq $resp) { throw }
      $s = $resp.GetResponseStream(); $s.Position = 0
      $raw = (New-Object IO.StreamReader($s)).ReadToEnd()
    }
    $err = $raw | ConvertFrom-Json
    if ($err.error.code -ne 'missing_files') { throw "Vercel: $($err.error.code) - $($err.error.message)" }
    return @{ missing = @($err.error.missing) }
  }
}

$dep = New-Deployment
if ($dep.missing) {
  Write-Output "Uploading $($dep.missing.Count) new blobs..."
  foreach ($sha in $dep.missing) {
    Invoke-RestMethod -Method Post -Uri "https://api.vercel.com/v2/files?teamId=$team" `
      -Headers @{ Authorization = "Bearer $tok"; 'x-vercel-digest' = $sha } `
      -ContentType 'application/octet-stream' -Body $blobs[$sha] -TimeoutSec 120 | Out-Null
  }
  $dep = New-Deployment
  if ($dep.missing) { throw "Vercel still reports $($dep.missing.Count) missing files after upload" }
}
Write-Output "Deployment $($dep.id) created (state $($dep.readyState)). Polling..."

for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 5
  $st = Invoke-RestMethod -Uri "https://api.vercel.com/v13/deployments/$($dep.id)?teamId=$team" `
    -Headers @{ Authorization = "Bearer $tok" } -TimeoutSec 60
  if ($st.readyState -in @('READY','ERROR','CANCELED')) { break }
}
Write-Output "Final state: $($st.readyState)  url: https://$($st.url)  aliases: $($st.alias -join ', ')"
if ($st.readyState -ne 'READY') { exit 1 }
