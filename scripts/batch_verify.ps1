# batch_verify.ps1 - runs the abstract-verify QA pass over every lease abstract
# that has not been verified since its last generation. Sequential (one Opus
# call each, ~1-2 min); resumable - rerunning skips abstracts already verified
# (qa_status not null). Regenerating an abstract clears qa_status, so it will be
# re-picked up automatically. Log: scripts\batch_verify.log
#
# Optional -PropertyIds limits the run; default = ALL properties that have
# abstracts. Service-key auth (SUPABASE_SECRET_KEY), same as the ingest loaders.
param(
  [string[]]$PropertyIds = @(),
  [int]$Shard = 0, [int]$Of = 1              # parallel shards: process todo index % Of == Shard
)
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$log = "$PSScriptRoot\batch_verify_s$Shard.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [s$Shard] $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }
$enc = New-Object System.Text.UTF8Encoding($false)

# Pull every unverified abstract that has recorded source documents. PostgREST:
# qa_status is null AND source_doc_ids present. Property filter is optional.
$filter = "qa_status=is.null&source_doc_ids=not.is.null"
if ($PropertyIds.Count -gt 0) {
  $inList = ($PropertyIds -join ',')
  $filter += "&property_id=in.($inList)"
}
$rows = Invoke-RestMethod -Uri "$BASE/rest/v1/lease_abstracts?select=tenant_name,property_id,source_doc_ids&$filter" -Headers $H -UserAgent $UA -TimeoutSec 60
# Guard: skip rows whose source_doc_ids array is empty (verify needs sources).
$avail = @($rows | Where-Object { $_.source_doc_ids -and $_.source_doc_ids.Count -gt 0 })
$todo = @(for ($j = 0; $j -lt $avail.Count; $j++) { if (($j % $Of) -eq $Shard) { $avail[$j] } })
Log "Verifying $($todo.Count) of $($avail.Count) unverified (shard $Shard/$Of)"

$i = 0; $verified = 0; $issues = 0; $review = 0; $fail = 0
foreach ($a in $todo) {
  $i++
  # POST via curl.exe --data-binary (UTF-8 file): PS 5.1 Invoke-RestMethod mangles
  # accented tenant names and can 401 spuriously; curl sends exact bytes + auth.
  $body = (@{ property_id = $a.property_id; tenant = $a.tenant_name } | ConvertTo-Json -Compress)
  $tmp = "$PSScriptRoot\_verify_body_s$Shard.json"
  [System.IO.File]::WriteAllText($tmp, $body, $enc)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $out = & curl.exe -s -w "`n%{http_code}" -X POST "$BASE/functions/v1/abstract-verify" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -A $UA --data-binary "@$tmp" --max-time 295
  $sw.Stop()
  $code = ($out -split "`n")[-1]
  $json = if ($out.Length -gt $code.Length) { $out.Substring(0, $out.Length - $code.Length - 1) } else { '' }
  if ($code -eq '200') {
    $qs = ''; try { $o = $json | ConvertFrom-Json; $qs = $o.qa_status } catch {}
    switch ($qs) { 'verified' { $verified++ } 'issues' { $issues++ } 'review' { $review++ } }
    Log ("{0}/{1} {2} {3}s :: {4}" -f $i, $todo.Count, ("$qs").ToUpper(), [math]::Round($sw.Elapsed.TotalSeconds), $a.tenant_name)
  } else {
    $fail++
    Log ("{0}/{1} FAIL http={2} {3}s :: {4} :: {5}" -f $i, $todo.Count, $code, [math]::Round($sw.Elapsed.TotalSeconds), $a.tenant_name, ($json -replace '\s+', ' ').Substring(0, [Math]::Min(200, $json.Length)))
    Start-Sleep -Seconds 8   # transient API errors (529) - brief backoff
  }
}
Log ("batch complete - verified=$verified issues=$issues review=$review fail=$fail of $($todo.Count)")
