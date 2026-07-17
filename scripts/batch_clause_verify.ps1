# batch_clause_verify.ps1 - run abstract-clause-verify (clause specialists) over
# every lease abstract. DETECTION ONLY (writes clause_findings + surfaces
# actionable findings in the worklist; never auto-corrects). Concurrent pool.
# Cross-model adjudication on high-severity findings is ON by default in the fn.
# Log: scripts\batch_clause_verify.log
#   .\batch_clause_verify.ps1 -PropertyId <uuid>        # one property
#   .\batch_clause_verify.ps1 -Shard 0 -Of 4            # portfolio, sharded
param(
  [string]$PropertyId = '',
  [int]$Shard = 0, [int]$Of = 1,
  [int]$Throttle = 5
)
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']; $UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$log = "$PSScriptRoot\batch_clause_verify.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }

# One tenant clause-verified in a background job.
$CVJob = {
  param($propId, $tenant, $BASE, $KEY, $UA, $scriptRoot, $slot)
  $enc = New-Object System.Text.UTF8Encoding($false)
  $tmp = "$scriptRoot\_cv_body_$slot.json"
  [System.IO.File]::WriteAllText($tmp, (@{ property_id = $propId; tenant = $tenant } | ConvertTo-Json -Compress), $enc)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $out = (& curl.exe -s -w "`n%{http_code}" -X POST "$BASE/functions/v1/abstract-clause-verify" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -A $UA --data-binary "@$tmp" --max-time 200) -join "`n"
  $sw.Stop()
  $code = ($out -split "`n")[-1]
  $json = if ($out.Length -gt $code.Length) { $out.Substring(0, $out.Length - $code.Length - 1) } else { '' }
  $act = $null; $enr = $null; $rev = $null; $cv = $null; $err = $null
  if ($code -eq '200') { try { $o = $json | ConvertFrom-Json; $act = [int]$o.summary.actionable; $enr = [int]$o.summary.enrich; $rev = [int]$o.summary.revise; $cv = [int]$o.summary.cannot_verify } catch { $err = 'parse' } }
  else { $e = ($json -replace '\s+', ' '); $err = $e.Substring(0, [Math]::Min(140, $e.Length)) }
  [pscustomobject]@{ tenant = $tenant; code = $code; secs = [math]::Round($sw.Elapsed.TotalSeconds); act = $act; enr = $enr; rev = $rev; cv = $cv; err = $err }
}

function Reap($jobs) {
  foreach ($j in @($jobs | Where-Object { $_.State -ne 'Running' })) {
    $res = Receive-Job $j -ErrorAction SilentlyContinue
    Remove-Job $j -Force -ErrorAction SilentlyContinue
    [void]$jobs.Remove($j)
    $script:done++
    if ($res -and $res.code -eq '200') {
      $script:okCount++; $script:totAct += [int]$res.act
      if ([int]$res.act -gt 0) { [void]$script:flagged.Add([pscustomobject]@{ tenant = $res.tenant; act = $res.act; rev = $res.rev; cv = $res.cv; enr = $res.enr }) }
      Log ("  {0}/{1} {2} {3}s :: actionable={4} (revise={5} cannot_verify={6} enrich={7})" -f $script:done, $script:total, $res.tenant, $res.secs, $res.act, $res.rev, $res.cv, $res.enr)
    } else {
      $script:failCount++
      $ft = if ($res -and $res.tenant) { $res.tenant } else { '?' }
      $fc = if ($res -and $res.code) { $res.code } else { '?' }
      $fe = if ($res -and $res.err) { $res.err } else { 'no result' }
      Log ("  {0}/{1} {2} FAIL http={3} :: {4}" -f $script:done, $script:total, $ft, $fc, $fe)
    }
  }
}

$q = "$BASE/rest/v1/lease_abstracts?select=tenant_name,property_id&order=property_id,tenant_name"
if ($PropertyId) { $q += "&property_id=eq.$PropertyId" }
$rows = @(Invoke-RestMethod -Uri $q -Headers $H -UserAgent $UA)
$todo = @(for ($j = 0; $j -lt $rows.Count; $j++) { if (($j % $Of) -eq $Shard) { $rows[$j] } })
$script:total = $todo.Count; $script:done = 0; $script:okCount = 0; $script:failCount = 0
$script:totAct = 0; $script:flagged = [System.Collections.ArrayList]::new()
Log ("clause-verify: {0} abstracts (shard {1}/{2}), throttle {3}" -f $script:total, $Shard, $Of, $Throttle)

$jobs = [System.Collections.ArrayList]::new(); $slot = 0
foreach ($r in $todo) {
  $slot++
  while ((@($jobs | Where-Object { $_.State -eq 'Running' })).Count -ge $Throttle) { Start-Sleep -Milliseconds 300; Reap $jobs }
  $jb = Start-Job -ScriptBlock $CVJob -ArgumentList $r.property_id, $r.tenant_name, $BASE, $KEY, $UA, $PSScriptRoot, $slot
  [void]$jobs.Add($jb)
}
while ($jobs.Count -gt 0) { Start-Sleep -Milliseconds 300; Reap $jobs }

Log ("DONE: {0} ok / {1} failed. Portfolio: {2} actionable clause findings across {3} flagged tenants." -f $script:okCount, $script:failCount, $script:totAct, $script:flagged.Count)
Log 'Top flagged tenants (by actionable findings):'
foreach ($f in ($script:flagged | Sort-Object -Property act -Descending | Select-Object -First 20)) {
  Log ("  {0}: {1} actionable (revise={2} cannot_verify={3} enrich={4})" -f $f.tenant, $f.act, $f.rev, $f.cv, $f.enr)
}
