# batch_abstracts_missing.ps1 - generates all MISSING abstracts for a property
# (active, non-REA, non-placeholder leases without a lease_abstracts row).
# Usage: pass the property UUID as $PropertyId. Log: batch_abstracts_<tag>.log
param(
  [Parameter(Mandatory=$true)][string]$PropertyId,
  [string]$Tag = 'prop'
)
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$log = "$PSScriptRoot\batch_abstracts_$Tag.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }

$leases = Invoke-RestMethod -Uri "$BASE/rest/v1/leases?select=tenants(name,trade_name)&property_id=eq.$PropertyId&status=eq.active&is_rea_member=eq.false" -Headers $H -UserAgent 'cre-loader/1.0' -TimeoutSec 60
$existing = Invoke-RestMethod -Uri "$BASE/rest/v1/lease_abstracts?select=tenant_name&property_id=eq.$PropertyId" -Headers $H -UserAgent 'cre-loader/1.0' -TimeoutSec 60
$have = @($existing | ForEach-Object { $_.tenant_name.ToLower() })
$placeholder = '^(additional space|available|vacant)\b'
$todo = @($leases | ForEach-Object { if ($_.tenants.trade_name) { $_.tenants.trade_name } else { $_.tenants.name } } |
  Where-Object { $_ -and $_.Length -gt 1 -and ($_ -notmatch $placeholder) -and ($have -notcontains $_.ToLower()) } |
  Sort-Object -Unique)
Log ("$Tag batch: {0} active non-REA leases, {1} to generate" -f @($leases).Count, $todo.Count)

# POST via curl + UTF-8-no-BOM file body: Invoke-RestMethod (PS 5.1) mangles
# non-ASCII tenant names ("Café" -> "Caf?") before they reach the edge fn.
$enc = New-Object Text.UTF8Encoding($false)
$reqf = "$env:TEMP\batch_abs_$Tag.json"
$i = 0
foreach ($t in $todo) {
  $i++
  $json = @{ property_id = $PropertyId; tenant = $t; force = $true } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($reqf, $json, $enc)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $resp = & curl.exe -s -X POST "$BASE/functions/v1/lease-abstract" `
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" `
    --data-binary "@$reqf" --max-time 290
  $sw.Stop()
  $j = $null; try { $j = $resp | ConvertFrom-Json } catch {}
  if ($j -and $j.success) {
    Log ("{0}/{1} OK {2}s docs={3} pdfs={4} :: {5}" -f $i, $todo.Count, [math]::Round($sw.Elapsed.TotalSeconds), $j.docs_used, $j.pdf_sources, $t)
  } else {
    Log ("{0}/{1} FAIL {2}s :: {3} :: {4}" -f $i, $todo.Count, [math]::Round($sw.Elapsed.TotalSeconds), $t, ($resp -replace '\s+', ' ').Substring(0, [Math]::Min(250, $resp.Length)))
    Start-Sleep -Seconds 10
  }
}
Log "$Tag batch complete"
