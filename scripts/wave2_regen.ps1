# wave2_regen.ps1 - Wave 2 of the matcher-pollution fix. For each tenant in
# _wave2_targets.json, force-regenerates the lease abstract on lease-abstract
# v28 (which now excludes \Construction\ \Accounting\ \Insurance\
# \Correspondence\ subfolders) so the synthesis is rebuilt from the clean doc
# set, then re-runs abstract-verify. Sequential; resumable via -Skip.
# Log: scripts\wave2_regen.log
param([int]$Skip = 0)
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$log = "$PSScriptRoot\wave2_regen.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }
$enc = New-Object System.Text.UTF8Encoding($false)

# NB: PS 5.1 ConvertFrom-Json returns a top-level JSON array as ONE object, so
# assign first (assignment unrolls it) THEN normalize with @() - never @(pipe).
$targets = [System.IO.File]::ReadAllText("$PSScriptRoot\_wave2_targets.json", [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$targets = @($targets)
Log ("wave2 start: {0} targets (skip {1})" -f $targets.Count, $Skip)
$i = 0; $ok = 0; $fail = 0; $verified = 0; $issues = 0; $review = 0
foreach ($t in $targets) {
  $i++
  if ($i -le $Skip) { continue }
  # 1. Regenerate (force) - clears qa_status so verify re-runs cleanly.
  $body = (@{ property_id = $t.property_id; tenant = $t.tenant; force = $true } | ConvertTo-Json -Compress)
  $tmp = "$PSScriptRoot\_wave2_body.json"
  [System.IO.File]::WriteAllText($tmp, $body, $enc)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $out = & curl.exe -s -w "`n%{http_code}" -X POST "$BASE/functions/v1/lease-abstract" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -A $UA --data-binary "@$tmp" --max-time 295
  $code = ($out -split "`n")[-1]
  $json = if ($out.Length -gt $code.Length) { $out.Substring(0, $out.Length - $code.Length - 1) } else { '' }
  if ($code -ne '200') {
    $fail++
    Log ("{0}/{1} REGEN FAIL http={2} {3}s :: {4} :: {5}" -f $i, $targets.Count, $code, [math]::Round($sw.Elapsed.TotalSeconds), $t.tenant, ($json -replace '\s+', ' ').Substring(0, [Math]::Min(180, $json.Length)))
    Start-Sleep -Seconds 8
    continue
  }
  $docs = 0; try { $o = $json | ConvertFrom-Json; $docs = $o.docs_used } catch {}
  # 2. Verify the freshly regenerated abstract.
  $vbody = (@{ property_id = $t.property_id; tenant = $t.tenant } | ConvertTo-Json -Compress)
  [System.IO.File]::WriteAllText($tmp, $vbody, $enc)
  $vout = & curl.exe -s -w "`n%{http_code}" -X POST "$BASE/functions/v1/abstract-verify" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -A $UA --data-binary "@$tmp" --max-time 295
  $sw.Stop()
  $vcode = ($vout -split "`n")[-1]
  $vjson = if ($vout.Length -gt $vcode.Length) { $vout.Substring(0, $vout.Length - $vcode.Length - 1) } else { '' }
  $qs = '?'
  if ($vcode -eq '200') { try { $qs = ($vjson | ConvertFrom-Json).qa_status } catch {}; switch ($qs) { 'verified' { $verified++ } 'issues' { $issues++ } 'review' { $review++ } } }
  $ok++
  Log ("{0}/{1} OK {2}s docs={3} qa={4} :: {5}" -f $i, $targets.Count, [math]::Round($sw.Elapsed.TotalSeconds), $docs, ("$qs").ToUpper(), $t.tenant)
}
Log ("wave2 complete: ok=$ok fail=$fail | qa verified=$verified issues=$issues review=$review")
