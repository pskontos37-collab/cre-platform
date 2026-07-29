# batch_crosscheck.ps1 - run abstract-ensemble (Stage 2 cross-check) over every
# lease abstract. DETECTION ONLY: auto_apply is always false (writes field_confidence
# + surfaces disagreements in the worklist; never auto-corrects). Concurrent pool.
# Log: scripts\batch_crosscheck.log
param(
  [string]$PropertyId = '',
  [int]$Shard = 0, [int]$Of = 1,
  [int]$Throttle = 6
)
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']; $UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$log = "$PSScriptRoot\batch_crosscheck.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }

# One tenant cross-checked in a background job. auto_apply=false (detection only).
$CCJob = {
  param($propId, $tenant, $BASE, $KEY, $UA, $scriptRoot, $slot)
  $enc = New-Object System.Text.UTF8Encoding($false)
  $tmp = "$scriptRoot\_cc_body_$slot.json"
  [System.IO.File]::WriteAllText($tmp, (@{ property_id = $propId; tenant = $tenant; auto_apply = $false } | ConvertTo-Json -Compress), $enc)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $out = (& curl.exe -s -w "`n%{http_code}" -X POST "$BASE/functions/v1/abstract-ensemble" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -A $UA --data-binary "@$tmp" --max-time 200) -join "`n"
  Remove-Item $tmp -ErrorAction SilentlyContinue
  $sw.Stop()
  $code = ($out -split "`n")[-1]
  $json = if ($out.Length -gt $code.Length) { $out.Substring(0, $out.Length - $code.Length - 1) } else { '' }
  $low = $null; $disc = $null; $err = $null
  if ($code -eq '200') { try { $o = $json | ConvertFrom-Json; $low = [int]$o.summary.low; $disc = [int]$o.summary.disagreements } catch { $err = 'parse' } }
  else { $e = ($json -replace '\s+', ' '); $err = $e.Substring(0, [Math]::Min(140, $e.Length)) }
  [pscustomobject]@{ tenant = $tenant; code = $code; secs = [math]::Round($sw.Elapsed.TotalSeconds); low = $low; disc = $disc; err = $err }
}

function Reap($jobs) {
  foreach ($j in @($jobs | Where-Object { $_.State -ne 'Running' })) {
    $res = Receive-Job $j -ErrorAction SilentlyContinue
    Remove-Job $j -Force -ErrorAction SilentlyContinue
    [void]$jobs.Remove($j)
    $script:done++
    if ($res -and $res.code -eq '200') {
      $script:okCount++; $script:totLow += [int]$res.low; $script:totDisc += [int]$res.disc
      if ([int]$res.disc -gt 0) { [void]$script:flagged.Add([pscustomobject]@{ tenant = $res.tenant; low = $res.low; disc = $res.disc }) }
      Log ("  {0}/{1} {2} {3}s :: low={4} disagreements={5}" -f $script:done, $script:total, $res.tenant, $res.secs, $res.low, $res.disc)
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
$script:totLow = 0; $script:totDisc = 0; $script:flagged = [System.Collections.ArrayList]::new()
Log ("cross-check: {0} abstracts (shard {1}/{2}), throttle {3}" -f $script:total, $Shard, $Of, $Throttle)

$jobs = [System.Collections.ArrayList]::new(); $slot = 0
foreach ($r in $todo) {
  $slot++
  while ((@($jobs | Where-Object { $_.State -eq 'Running' })).Count -ge $Throttle) { Start-Sleep -Milliseconds 300; Reap $jobs }
  $jb = Start-Job -ScriptBlock $CCJob -ArgumentList $r.property_id, $r.tenant_name, $BASE, $KEY, $UA, $PSScriptRoot, $slot
  [void]$jobs.Add($jb)
}
while ($jobs.Count -gt 0) { Start-Sleep -Milliseconds 300; Reap $jobs }

Log ("DONE: {0} ok / {1} failed. Portfolio: {2} low-confidence fields, {3} disagreements across {4} flagged tenants." -f $script:okCount, $script:failCount, $script:totLow, $script:totDisc, $script:flagged.Count)
Log 'Top flagged tenants (by disagreements):'
foreach ($f in ($script:flagged | Sort-Object -Property disc -Descending | Select-Object -First 15)) {
  Log ("  {0}: {1} disagreements, {2} low-confidence fields" -f $f.tenant, $f.disc, $f.low)
}
