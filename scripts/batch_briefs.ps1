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
  [int]$Shard = 0, [int]$Of = 1,
  [int]$Throttle = 8                  # concurrent doc-brief calls per tenant (docs are independent)
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

# One document briefed to completion inside a background job. Giant instruments
# resume across several calls (done=false -> repost) IN ORDER within the doc;
# parallelism is only ever ACROSS docs (no segment races). Idempotent: the edge
# fn skips docs whose brief is already complete and whose text is unchanged.
$BriefJob = {
  param($docId, $docTitle, $BASE, $KEY, $UA, $scriptRoot)
  $enc = New-Object System.Text.UTF8Encoding($false)
  $tmp = "$scriptRoot\_brief_body_job_$docId.json"
  [System.IO.File]::WriteAllText($tmp, (@{ document_id = $docId } | ConvertTo-Json -Compress), $enc)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $done = $false; $guard = 0
  while (-not $done -and $guard -lt 15) {
    $guard++
    $out = (& curl.exe -s -w "`n%{http_code}" -X POST "$BASE/functions/v1/doc-brief" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -A $UA --data-binary "@$tmp" --max-time 285) -join "`n"
    $code = ($out -split "`n")[-1]
    $json = if ($out.Length -gt $code.Length) { $out.Substring(0, $out.Length - $code.Length - 1) } else { '' }
    if ($code -ne '200') { Start-Sleep -Seconds 10; continue }   # transient 429/529 -> backoff, retry same doc
    try { $o = $json | ConvertFrom-Json; $done = ($o.done -ne $false) } catch { $done = $true }
  }
  Remove-Item $tmp -ErrorAction SilentlyContinue
  $sw.Stop()
  [pscustomobject]@{ title = $docTitle; ok = $done; secs = [math]::Round($sw.Elapsed.TotalSeconds) }
}

# Collect finished jobs: log each, receive+remove it, drop it from the live list.
# Iterates a snapshot so removing from $jobs mid-loop is safe.
function Reap($jobs, $need) {
  foreach ($j in @($jobs | Where-Object { $_.State -ne 'Running' })) {
    $res = Receive-Job $j -ErrorAction SilentlyContinue
    Remove-Job $j -Force -ErrorAction SilentlyContinue
    [void]$jobs.Remove($j)
    $script:reaped++
    if ($res -and $null -ne $res.ok) {
      Log ("  doc {0}/{1} {2} {3}s :: {4}" -f $script:reaped, $need.Count, ($(if ($res.ok) { 'OK' } else { 'GAVE UP' })), $res.secs, $res.title)
    } else {
      Log ("  doc {0}/{1} NO RESULT (job error)" -f $script:reaped, $need.Count)
    }
  }
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
  Log ("{0}/{1} {2}: {3} docs in file, {4} need briefs (throttle {5})" -f $i, $todo.Count, $r.tenant_name, $docs.Count, $need.Count, $Throttle)
  # Bounded-concurrency pool ACROSS this tenant's docs: up to $Throttle brief at
  # once instead of one-at-a-time. Wall-clock collapses from sum-of-docs to
  # ~ceil(docs/throttle) x slowest-doc. Reap frees slots + drops finished jobs.
  $script:reaped = 0
  $jobs = [System.Collections.ArrayList]::new()
  foreach ($doc in $need) {
    if (-not $doc -or -not $doc.id) { $script:reaped++; Log ("  doc {0}/{1} SKIP null id (plan parse problem)" -f $script:reaped, $need.Count); continue }
    while ((@($jobs | Where-Object { $_.State -eq 'Running' })).Count -ge $Throttle) {
      Start-Sleep -Milliseconds 400
      Reap $jobs $need
    }
    $jb = Start-Job -ScriptBlock $BriefJob -ArgumentList $doc.id, $doc.title, $BASE, $KEY, $UA, $PSScriptRoot
    [void]$jobs.Add($jb)
  }
  while ($jobs.Count -gt 0) { Start-Sleep -Milliseconds 400; Reap $jobs $need }   # drain remaining
}
Log 'brief batch complete'
