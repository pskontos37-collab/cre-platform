# svc_rollout.ps1 - Service-contract phase of the abstractor-v2 program.
# For each LIVE-decision service_agreements row (active/unknown/terminated —
# expired rows skipped deliberately: 517 dead contracts are not worth spend),
# brief its contract document (resumable) then agreement-verify (kind=svc):
# field-by-field check of the tracker's extracted values against the document,
# with auto-renewal/evergreen language as the priority finding.
# Log: scripts\svc_rollout_s<Shard>.log
param([int]$Shard = 0, [int]$Of = 2)
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$log = "$PSScriptRoot\svc_rollout_s$Shard.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [svc-s$Shard] $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }
$enc = New-Object System.Text.UTF8Encoding($false)

function PostFn($slug, $obj) {
  $tmp = "$PSScriptRoot\_svc_body_s$Shard.json"
  [System.IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Compress), $enc)
  $out = (& curl.exe -s -w "`n%{http_code}" -X POST "$BASE/functions/v1/$slug" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -A $UA --data-binary "@$tmp" --max-time 290) -join "`n"
  $code = ($out -split "`n")[-1]
  $json = if ($out.Length -gt $code.Length) { $out.Substring(0, $out.Length - $code.Length - 1) } else { '' }
  return @{ code = $code; json = $json }
}

$rows = Invoke-RestMethod -Uri "$BASE/rest/v1/service_agreements?select=id,vendor,document_id,status&status=in.(active,unknown,terminated)&document_id=not.is.null&order=vendor" -Headers $H -UserAgent $UA -TimeoutSec 60
$all = @($rows)
$todo = @(for ($j = 0; $j -lt $all.Count; $j++) { if (($j % $Of) -eq $Shard) { $all[$j] } })
Log ("svc verify: {0} live rows; shard {1}/{2} handles {3}" -f $all.Count, $Shard, $Of, $todo.Count)

$i = 0
foreach ($r in $todo) {
  $i++
  $done = $false; $guard = 0
  while (-not $done -and $guard -lt 15) {
    $guard++
    $res = PostFn 'doc-brief' @{ document_id = $r.document_id }
    if ($res.code -ne '200') { Log ("  brief FAIL http={0} :: {1}" -f $res.code, $r.vendor); Start-Sleep -Seconds 12; continue }
    try { $done = (($res.json | ConvertFrom-Json).done -ne $false) } catch { $done = $true }
  }
  $ok = $false
  foreach ($attempt in 1..3) {
    $res = PostFn 'agreement-verify' @{ kind = 'svc'; id = $r.id }
    if ($res.code -eq '200') { $ok = $true; break }
    Log ("  verify attempt {0} http={1} :: {2}" -f $attempt, $res.code, ($res.json -replace '\s+',' ').Substring(0,[Math]::Min(120,$res.json.Length)))
    Start-Sleep -Seconds 15
  }
  if (-not $ok) { Log ("{0}/{1} GAVE UP :: {2}" -f $i, $todo.Count, $r.vendor); continue }
  $qs = ''; try { $qs = ($res.json | ConvertFrom-Json).qa_status } catch {}
  Log ("{0}/{1} OK qa={2} :: {3} [{4}]" -f $i, $todo.Count, $qs, $r.vendor, $r.status)
}
Log 'svc rollout complete'
