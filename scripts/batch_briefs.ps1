# batch_briefs.ps1 - Stage 1 of the v2 abstraction pipeline (abstraction-standard.md).
# For each tenant with a lease abstract (or the tenants passed via -Tenants), asks
# lease-abstract for its document PLAN (matched file + brief coverage), then runs
# doc-brief on every unbriefed document until complete. Giant documents brief across
# several resumable calls (done=false -> call again). Idempotent: complete briefs are
# skipped by the edge fn unless the doc text changed.
#
# Run BEFORE batch_abstracts_regen.ps1 so synthesis has full-coverage briefs.
# Sharding: -Shard/-Of split the tenant list for parallel windows (one session owns a run).
# Log: scripts\batch_briefs_s<Shard>.log
param(
  [string]$PropertyId = '',          # limit to one property (default: all abstracts)
  [string[]]$Tenants = @(),          # limit to specific tenant names
  [int]$Shard = 0, [int]$Of = 1
)
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$log = "$PSScriptRoot\batch_briefs_s$Shard.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [s$Shard] $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }
$enc = New-Object System.Text.UTF8Encoding($false)

function PostJson($url, $obj) {
  # POST via curl.exe --data-binary: PS 5.1 Invoke-RestMethod corrupts non-ASCII
  # tenant names and 401s on some writes (reference_supabase_loaders).
  $tmp = "$PSScriptRoot\_brief_body_s$Shard.json"
  [System.IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Compress), $enc)
  # -join: PS captures multi-line native output as an ARRAY; without joining,
  # the Substring/Length math below silently yields '' and the caller sees
  # $null.docs -> a phantom 1-element list (the 2026-07-12 pilot bug).
  $out = (& curl.exe -s -w "`n%{http_code}" -X POST $url -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -A $UA --data-binary "@$tmp" --max-time 285) -join "`n"
  $code = ($out -split "`n")[-1]
  $json = if ($out.Length -gt $code.Length) { $out.Substring(0, $out.Length - $code.Length - 1) } else { '' }
  return @{ code = $code; json = $json }
}

$q = "$BASE/rest/v1/lease_abstracts?select=property_id,tenant_name&order=property_id,tenant_name"
if ($PropertyId) { $q += "&property_id=eq.$PropertyId" }
$rows = Invoke-RestMethod -Uri $q -Headers $H -UserAgent $UA -TimeoutSec 60
$all = @($rows)
if ($Tenants.Count) { $all = @($all | Where-Object { $Tenants -contains $_.tenant_name }) }
$todo = @(for ($j = 0; $j -lt $all.Count; $j++) { if (($j % $Of) -eq $Shard) { $all[$j] } })
Log ("briefs: {0} tenants; this shard {1}/{2} handles {3}" -f $all.Count, $Shard, $Of, $todo.Count)

$i = 0
foreach ($r in $todo) {
  $i++
  $plan = PostJson "$BASE/functions/v1/lease-abstract" @{ property_id = $r.property_id; tenant = $r.tenant_name; plan = $true }
  if ($plan.code -ne '200') {
    Log ("{0}/{1} PLAN FAIL http={2} :: {3} :: {4}" -f $i, $todo.Count, $plan.code, $r.tenant_name, ($plan.json -replace '\s+', ' ').Substring(0, [Math]::Min(180, $plan.json.Length)))
    Start-Sleep -Seconds 10
    continue
  }
  $docs = @()
  try { $docs = @(($plan.json | ConvertFrom-Json).docs) } catch {}
  $need = @($docs | Where-Object { $_.brief_status -ne 'complete' })
  Log ("{0}/{1} {2}: {3} docs in file, {4} need briefs" -f $i, $todo.Count, $r.tenant_name, $docs.Count, $need.Count)
  $d = 0
  foreach ($doc in $need) {
    $d++
    if (-not $doc -or -not $doc.id) { Log ("  doc {0}/{1} SKIP null id (plan parse problem)" -f $d, $need.Count); continue }
    $done = $false; $guard = 0; $sw = [Diagnostics.Stopwatch]::StartNew()
    while (-not $done -and $guard -lt 15) {
      $guard++
      $res = PostJson "$BASE/functions/v1/doc-brief" @{ document_id = $doc.id }
      if ($res.code -ne '200') {
        Log ("  doc {0}/{1} FAIL http={2} :: {3} :: {4}" -f $d, $need.Count, $res.code, $doc.title, ($res.json -replace '\s+', ' ').Substring(0, [Math]::Min(160, $res.json.Length)))
        Start-Sleep -Seconds 10   # transient API errors (429/529) - backoff, then retry same doc
        continue
      }
      try { $o = $res.json | ConvertFrom-Json; $done = ($o.done -ne $false) } catch { $done = $true }
    }
    $sw.Stop()
    Log ("  doc {0}/{1} {2} {3}s :: {4}" -f $d, $need.Count, ($(if ($done) { 'OK' } else { 'GAVE UP' })), [math]::Round($sw.Elapsed.TotalSeconds), $doc.title)
  }
}
Log 'brief batch complete'
