# pilot_regen.ps1 - Stage 2+3 of the abstractor-v2 pilot: regenerate + verify the
# pilot cohort (scripts/pilot_tenants.ps1) on the brief-synthesis pipeline.
# Run AFTER batch_briefs.ps1 has swept the cohort. Skips locked abstracts.
# Log: scripts\pilot_regen_s<Shard>.log
param([int]$Shard = 0, [int]$Of = 1)
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
. "$PSScriptRoot\pilot_tenants.ps1"
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$log = "$PSScriptRoot\pilot_regen_s$Shard.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [s$Shard] $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }
$enc = New-Object System.Text.UTF8Encoding($false)

function PostFn($slug, $obj) {
  $tmp = "$PSScriptRoot\_pilot_body_s$Shard.json"
  [System.IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Compress), $enc)
  $out = (& curl.exe -s -w "`n%{http_code}" -X POST "$BASE/functions/v1/$slug" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -A $UA --data-binary "@$tmp" --max-time 290) -join "`n"
  $code = ($out -split "`n")[-1]
  $json = if ($out.Length -gt $code.Length) { $out.Substring(0, $out.Length - $code.Length - 1) } else { '' }
  return @{ code = $code; json = $json }
}

$rows = Invoke-RestMethod -Uri "$BASE/rest/v1/lease_abstracts?select=property_id,tenant_name,locked" -Headers $H -UserAgent $UA -TimeoutSec 60
$all = @($rows | Where-Object { ($PilotTenants -contains $_.tenant_name) -and (-not $_.locked) })
$todo = @(for ($j = 0; $j -lt $all.Count; $j++) { if (($j % $Of) -eq $Shard) { $all[$j] } })
Log ("pilot regen: {0} tenants; this shard {1}/{2} handles {3}" -f $all.Count, $Shard, $Of, $todo.Count)

$i = 0
foreach ($r in $todo) {
  $i++
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $g = $null
  foreach ($attempt in 1..3) {
    $g = PostFn 'lease-abstract' @{ property_id = $r.property_id; tenant = $r.tenant_name; force = $true }
    if ($g.code -eq '200') { break }
    Log ("  regen attempt {0} http={1} :: {2}" -f $attempt, $g.code, ($g.json -replace '\s+', ' ').Substring(0, [Math]::Min(160, $g.json.Length)))
    Start-Sleep -Seconds 15
  }
  if ($g.code -ne '200') { Log ("{0}/{1} REGEN FAIL :: {2}" -f $i, $todo.Count, $r.tenant_name); continue }
  $briefs = 0; $unb = 0; try { $o = $g.json | ConvertFrom-Json; $briefs = $o.briefs_used; $unb = $o.unbriefed_in_file } catch {}
  $v = $null
  foreach ($attempt in 1..3) {
    $v = PostFn 'abstract-verify' @{ property_id = $r.property_id; tenant = $r.tenant_name }
    if ($v.code -eq '200') { break }
    Log ("  verify attempt {0} http={1}" -f $attempt, $v.code)
    Start-Sleep -Seconds 15
  }
  $qs = ''; try { $qs = ($v.json | ConvertFrom-Json).qa_status } catch {}
  $sw.Stop()
  Log ("{0}/{1} OK {2}s briefs={3} unbriefed={4} qa={5} :: {6}" -f $i, $todo.Count, [math]::Round($sw.Elapsed.TotalSeconds), $briefs, $unb, $qs, $r.tenant_name)
}
Log 'pilot regen complete'
