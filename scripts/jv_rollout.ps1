# jv_rollout.ps1 - JV phase of the abstractor-v2 program. For each of the 6
# deal layers: resolve the ENTITY-MATCHED jv documents (hand-curated needles —
# the two layers of a property must never conflate), brief each doc, then
# agreement-abstract (kind=jv, explicit doc_ids) and agreement-verify.
# Log: scripts\jv_rollout.log
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$log = "$PSScriptRoot\jv_rollout.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [jv] $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }
$enc = New-Object System.Text.UTF8Encoding($false)

function PostFn($slug, $obj) {
  $tmp = "$PSScriptRoot\_jv_body.json"
  [System.IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Compress -Depth 5), $enc)
  $out = (& curl.exe -s -w "`n%{http_code}" -X POST "$BASE/functions/v1/$slug" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -A $UA --data-binary "@$tmp" --max-time 290) -join "`n"
  $code = ($out -split "`n")[-1]
  $json = if ($out.Length -gt $code.Length) { $out.Substring(0, $out.Length - $code.Length - 1) } else { '' }
  return @{ code = $code; json = $json }
}

# deal id -> title needles for its layer's entity documents
$DealDocs = @(
  @{ id = '26b89a2d-a9f8-4418-993f-bd52b013f989'; name = 'Gateway L1 (ML-MJW)';            needles = @('ML-MJW', 'Gateway Buyout') },
  @{ id = '7a37dd9c-aeac-499c-a2e6-76277d6b63dc'; name = 'Gateway L2 (M&J PC Investors)';  needles = @('M & J PC Investors') },
  @{ id = '2b9e3e04-c2a6-4dc9-a9b0-e94468bd5b0c'; name = 'Knightdale L1 (BBK)';            needles = @('BBK Knightdale', 'BBK Midway', 'BBK Midtown') },
  @{ id = '64bce3a2-7079-4d20-bfe7-351d7adcd06a'; name = 'Knightdale L2 (M&J K Investors)';needles = @('M & J Knightdale Investors') },
  @{ id = 'd8c4d211-33f4-4f3f-80bd-36a4d9d70c2f'; name = 'Magnolia L1 (Greenville)';       needles = @('Magnolia Park Greenville') },
  @{ id = '9838d96c-3294-4c47-9355-5984cd878ae6'; name = 'Magnolia L2 (M&J Mag Investors)';needles = @('M & J Magnolia Investors') }
)

foreach ($d in $DealDocs) {
  # resolve doc ids: doc_type=jv_agreement whose title matches any needle
  $ids = @()
  foreach ($n in $d.needles) {
    $q = [uri]::EscapeDataString('*' + $n + '*')
    $rows = Invoke-RestMethod -Uri "$BASE/rest/v1/documents?select=id,title&doc_type=eq.jv_agreement&title=ilike.$q" -Headers $H -UserAgent $UA -TimeoutSec 60
    foreach ($r in $rows) { if ($ids -notcontains $r.id) { $ids += $r.id } }
  }
  Log ("{0}: {1} docs matched" -f $d.name, $ids.Count)
  if (-not $ids.Count) { Log '  SKIP - no docs'; continue }
  foreach ($docId in $ids) {
    $done = $false; $guard = 0
    while (-not $done -and $guard -lt 15) {
      $guard++
      $res = PostFn 'doc-brief' @{ document_id = $docId }
      if ($res.code -ne '200') { Log ("  brief FAIL http={0}" -f $res.code); Start-Sleep -Seconds 12; continue }
      try { $done = (($res.json | ConvertFrom-Json).done -ne $false) } catch { $done = $true }
    }
  }
  $ok = $false
  foreach ($attempt in 1..3) {
    $res = PostFn 'agreement-abstract' @{ kind = 'jv'; id = $d.id; doc_ids = $ids }
    if ($res.code -eq '200') { $ok = $true; break }
    Log ("  abstract attempt {0} http={1} :: {2}" -f $attempt, $res.code, ($res.json -replace '\s+',' ').Substring(0,[Math]::Min(120,$res.json.Length)))
    Start-Sleep -Seconds 15
  }
  if (-not $ok) { Log '  abstract GAVE UP'; continue }
  foreach ($attempt in 1..3) {
    $res = PostFn 'agreement-verify' @{ kind = 'jv'; id = $d.id }
    if ($res.code -eq '200') { break }
    Log ("  verify attempt {0} http={1}" -f $attempt, $res.code)
    Start-Sleep -Seconds 15
  }
  $qs = ''; try { $qs = ($res.json | ConvertFrom-Json).qa_status } catch {}
  Log ("  done qa={0}" -f $qs)
}
Log 'jv rollout complete'
