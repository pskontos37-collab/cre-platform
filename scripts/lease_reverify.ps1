# lease_reverify.ps1 - re-verify the 7 remaining triage lease abstracts (Select
# Comfort + Elase already done). More retries (8x/20s) to ride through the
# intermittent Anthropic overload the large lease requests catch.
# Log: scripts\lease_reverify.log
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$log = "$PSScriptRoot\lease_reverify.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }
$enc = New-Object System.Text.UTF8Encoding($false)

$leaseIds = @(
  '7894891e-d0ca-490d-b12b-6ea387ff5d00',  # CONDADO
  '4340706f-4be0-4007-b767-0d5d2ef230a5',  # 100 Chiro
  '2222e8af-40ae-44e2-a439-f2780b381c56',  # Bass Pro
  '101ed7eb-6003-4144-ba9b-03a1799ed8a3',  # Restore
  '40d39f40-60a2-40f1-ae00-d59f5c42b06b',  # CKE / F45
  '9d4465b7-0ec5-4050-afad-9a488e1d8ee8',  # Club Pilates
  '4c6de200-31b4-4666-9992-16d171ed7605')  # GNC
Log ("lease reverify start: {0} rows" -f $leaseIds.Count)

$j = 0
foreach ($id in $leaseIds) {
  $j++
  $row = $null
  try { $row = Invoke-RestMethod -Uri "$BASE/rest/v1/lease_abstracts?select=tenant_name,property_id&id=eq.$id" -Headers $H -UserAgent $UA -TimeoutSec 60 } catch {}
  if (-not $row -or -not $row[0]) { Log ("{0}/{1} LOOKUP FAIL :: {2}" -f $j, $leaseIds.Count, $id); continue }
  $tenant = $row[0].tenant_name; $pid = $row[0].property_id
  $ok = $false; $qs = ''
  foreach ($attempt in 1..8) {
    $body = (@{ property_id = $pid; tenant = $tenant } | ConvertTo-Json -Compress)
    $tmp = "$PSScriptRoot\_lease_body.json"; [System.IO.File]::WriteAllText($tmp, $body, $enc)
    $out = (& curl.exe -s -w "`n%{http_code}" -X POST "$BASE/functions/v1/abstract-verify" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -A $UA --data-binary "@$tmp" --max-time 295) -join "`n"
    $code = ($out -split "`n")[-1]
    if ($code -eq '200') { $ok = $true; try { $qs = (($out.Substring(0, $out.Length - $code.Length - 1)) | ConvertFrom-Json).qa_status } catch {}; break }
    Start-Sleep -Seconds 20
  }
  if ($ok) { Log ("{0}/{1} OK qa={2} :: {3}" -f $j, $leaseIds.Count, $qs, $tenant) } else { Log ("{0}/{1} GAVE UP :: {2}" -f $j, $leaseIds.Count, $tenant) }
}
Log 'lease reverify complete'
