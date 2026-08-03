# reverify_citations.ps1 - re-runs abstract-verify over the abstracts that carry an
# OPEN citation_not_confirmed finding in v_property_data_quality.
#
# Why a separate script from batch_verify.ps1: that one selects qa_status IS NULL
# (never-verified abstracts). These have all been verified already - the point is to
# re-verify them against the 2026-08-03 abstract-verify prompt, which tells the model
# its quotes are machine-checked and that an unlocatable quote downgrades the abstract.
# Pilot on 100 Chiro: 1 located / 22 not_located -> 21 located / 1 not_located.
#
# Sequential per shard (one Opus call each, ~90s). Resumable: rerunning re-reads the
# view, so anything already improved past the check drops out of the todo list.
# Run parallel shards with -Shard 0 -Of 4, -Shard 1 -Of 4, ...
# Log: scripts\reverify_citations_s<N>.log
param(
  [int]$Shard = 0, [int]$Of = 1,
  [int]$Limit = 0                     # 0 = no cap
)
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$log = "$PSScriptRoot\reverify_citations_s$Shard.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [s$Shard] $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }
$enc = New-Object System.Text.UTF8Encoding($false)

$uri = "$BASE/rest/v1/v_property_data_quality?select=tenant_name,property_id&check_code=eq.citation_not_confirmed&resolved=is.false&order=tenant_name"
$rows = Invoke-RestMethod -Uri $uri -Headers $H -UserAgent $UA -TimeoutSec 60
$avail = @($rows | Where-Object { $_.tenant_name -and $_.property_id })
$todo = @(for ($j = 0; $j -lt $avail.Count; $j++) { if (($j % $Of) -eq $Shard) { $avail[$j] } })
if ($Limit -gt 0 -and $todo.Count -gt $Limit) { $todo = $todo[0..($Limit - 1)] }
Log "Re-verifying $($todo.Count) of $($avail.Count) citation-flagged abstracts (shard $Shard/$Of)"

$i = 0; $ok = 0; $fail = 0
foreach ($a in $todo) {
  $i++
  # curl.exe --data-binary from a UTF-8 file: PS 5.1 Invoke-RestMethod mangles accented
  # tenant names (Cafe', Cheddar's) and can 401 spuriously.
  $body = (@{ property_id = $a.property_id; tenant = $a.tenant_name } | ConvertTo-Json -Compress)
  $tmp = "$PSScriptRoot\_reverify_cit_s$Shard.json"
  [System.IO.File]::WriteAllText($tmp, $body, $enc)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $out = & curl.exe -s -w "`n%{http_code}" -X POST "$BASE/functions/v1/abstract-verify" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -A $UA --data-binary "@$tmp" --max-time 295
  $sw.Stop()
  $code = ($out -split "`n")[-1]
  $json = if ($out.Length -gt $code.Length) { $out.Substring(0, $out.Length - $code.Length - 1) } else { '' }
  if ($code -eq '200') {
    $ok++
    $qs = ''; $loc = ''; $nl = ''
    try { $o = $json | ConvertFrom-Json; $qs = $o.qa_status; $loc = $o.qa.citation_summary.located; $nl = $o.qa.citation_summary.not_located } catch {}
    Log ("{0}/{1} {2} {3}s cites {4} ok / {5} unlocatable :: {6}" -f $i, $todo.Count, ("$qs").ToUpper(), [math]::Round($sw.Elapsed.TotalSeconds), $loc, $nl, $a.tenant_name)
  } else {
    $fail++
    $snip = ($json -replace '\s+', ' '); if ($snip.Length -gt 180) { $snip = $snip.Substring(0, 180) }
    Log ("{0}/{1} FAIL http={2} {3}s :: {4} :: {5}" -f $i, $todo.Count, $code, [math]::Round($sw.Elapsed.TotalSeconds), $a.tenant_name, $snip)
    # A sub-2s failure is the credit-exhaustion signature, not a transient - stop the
    # shard rather than burn through the whole list producing empty verdicts.
    if ($sw.Elapsed.TotalSeconds -lt 2) { Log 'ABORTING: sub-2s failure looks like a billing/credit block, not a transient.'; break }
    Start-Sleep -Seconds 8
  }
}
Log ("shard complete - ok=$ok fail=$fail of $($todo.Count)")
