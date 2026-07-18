# agreement_rollout.ps1 - REA/PMA phase of the abstractor-v2 program.
# For each rea_agreements / management_agreements row: (1) doc-brief every
# source document (resumable), (2) agreement-abstract, (3) agreement-verify.
# -Kind rea|pma selects the table. Log: scripts\agreement_rollout_<kind>.log
param([ValidateSet('rea','pma')][string]$Kind = 'rea')
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$log = "$PSScriptRoot\agreement_rollout_$Kind.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [$Kind] $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }
$enc = New-Object System.Text.UTF8Encoding($false)

function PostFn($slug, $obj) {
  $tmp = "$PSScriptRoot\_agr_body_$Kind.json"
  [System.IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Compress -Depth 5), $enc)
  $out = (& curl.exe -s -w "`n%{http_code}" -X POST "$BASE/functions/v1/$slug" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -A $UA --data-binary "@$tmp" --max-time 420) -join "`n"
  $code = ($out -split "`n")[-1]
  $json = if ($out.Length -gt $code.Length) { $out.Substring(0, $out.Length - $code.Length - 1) } else { '' }
  return @{ code = $code; json = $json }
}

# agreement-abstract returns a keep-alive STREAMING response: HTTP is ALWAYS 200
# and a synthesis failure is reported in the body's "error" field (leading
# keep-alive whitespace before the JSON is ignored by ConvertFrom-Json). So a
# 200 alone no longer means success. Non-streaming fns (doc-brief,
# agreement-verify) still signal failure via status code; this helper handles
# both: success = HTTP 200 AND no non-empty "error" property in the body.
function FnOk($r) {
  if ($r.code -ne '200') { return $false }
  $p = $null
  try { $p = $r.json | ConvertFrom-Json } catch { return $true }
  if ($p -and ($p.PSObject.Properties.Name -contains 'error') -and $p.error) { return $false }
  return $true
}

$table = if ($Kind -eq 'rea') { 'rea_agreements' } else { 'management_agreements' }
$filter = if ($Kind -eq 'pma') { '&is_current=eq.true' } else { '' }
$rows = Invoke-RestMethod -Uri "$BASE/rest/v1/$table`?select=id$filter" -Headers $H -UserAgent $UA -TimeoutSec 60
Log ("{0}: {1} agreements" -f $table, @($rows).Count)

$i = 0
foreach ($r in $rows) {
  $i++
  # Stage 1: plan -> brief unbriefed source docs (resumable segment loop)
  $plan = PostFn 'agreement-abstract' @{ kind = $Kind; id = $r.id; plan = $true }
  if (-not (FnOk $plan)) { Log ("{0}/{1} PLAN FAIL http={2} :: {3}" -f $i, @($rows).Count, $plan.code, ($plan.json -replace '\s+',' ').Substring(0,[Math]::Min(140,$plan.json.Length))); continue }
  $docs = @(); try { $docs = @(($plan.json | ConvertFrom-Json).docs) } catch {}
  $need = @($docs | Where-Object { $_ -and $_.id -and $_.brief_status -ne 'complete' })
  Log ("{0}/{1} id={2}: {3} docs, {4} need briefs" -f $i, @($rows).Count, $r.id, $docs.Count, $need.Count)
  foreach ($doc in $need) {
    $done = $false; $guard = 0
    while (-not $done -and $guard -lt 15) {
      $guard++
      $res = PostFn 'doc-brief' @{ document_id = $doc.id }
      if ($res.code -ne '200') { Log ("  brief FAIL http={0} :: {1}" -f $res.code, $doc.title); Start-Sleep -Seconds 12; continue }
      try { $done = (($res.json | ConvertFrom-Json).done -ne $false) } catch { $done = $true }
    }
  }
  # Stage 2 + 3: abstract, then verify (retry transient errors)
  foreach ($fn in @('agreement-abstract','agreement-verify')) {
    $ok = $false
    foreach ($attempt in 1..3) {
      $res = PostFn $fn @{ kind = $Kind; id = $r.id }
      if (FnOk $res) { $ok = $true; break }
      Log ("  {0} attempt {1} http={2} :: {3}" -f $fn, $attempt, $res.code, ($res.json -replace '\s+',' ').Substring(0,[Math]::Min(120,$res.json.Length)))
      Start-Sleep -Seconds 15
    }
    if (-not $ok) { Log ("  {0} GAVE UP" -f $fn); break }
    if ($fn -eq 'agreement-verify') {
      $qs = ''; try { $qs = ($res.json | ConvertFrom-Json).qa_status } catch {}
      Log ("  done qa={0}" -f $qs)
    }
  }
}
Log 'agreement rollout complete'
