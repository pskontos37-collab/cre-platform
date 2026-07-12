# batch_regen_worklist.ps1 - targeted cleanup of the abstracts the QA pass flagged.
# For each named tenant: REGENERATE on the current lease-abstract (v16, anti-
# fabrication) then VERIFY the fresh abstract. Sequential, ~2-4 min per tenant.
# Log: scripts\batch_regen_worklist.log
#
# Worklist (from the 2026-07-06 verify pass):
#   Tier 2 doc-interpretation errors regen SHOULD fix (right source is in-file):
#     Kay Jewelers, Ross Dress for Less, Arby's
#   Tier 1 current=false (regen refreshes verdict on v16 + clears fabrication
#   noise; ROOT cause needs human action - missing doc / stale MRI - noted):
#     Destination XL, J. Crew, V NAIL BAR AND LASH INC, Grow Pediatric Dentistry
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$log = "$PSScriptRoot\batch_regen_worklist.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }

# Exact tenant_name strings as stored in lease_abstracts.
$targets = @(
  'Kay Jewelers', 'Ross Dress for Less', "Arby's",
  'Destination XL', 'J. Crew', 'V NAIL BAR AND LASH INC', 'Grow Pediatric Dentistry'
)

function Post($slug, $prop, $tenant) {
  $body = (@{ property_id = $prop; tenant = $tenant } | ConvertTo-Json -Compress)
  $bytes = [Text.Encoding]::UTF8.GetBytes($body)   # PS 5.1 latin-1 body footgun (accents)
  return Invoke-RestMethod -Method Post -Uri "$BASE/functions/v1/$slug" `
    -Headers $H -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 290
}

$i = 0
foreach ($t in $targets) {
  $i++
  # Resolve property_id from the existing abstract row (URL-encode the name).
  $enc = [uri]::EscapeDataString($t)
  $row = Invoke-RestMethod -Uri "$BASE/rest/v1/lease_abstracts?select=property_id,tenant_name&tenant_name=eq.$enc" -Headers $H -UserAgent $UA -TimeoutSec 60
  if (-not $row) { Log ("{0}/{1} SKIP (no abstract row) :: {2}" -f $i, $targets.Count, $t); continue }
  $prop = $row[0].property_id
  # 1) Regenerate on v16 (clears qa_status), 2) verify the fresh abstract.
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $g = Post 'lease-abstract' $prop $t
    $v = Post 'abstract-verify' $prop $t
    $sw.Stop()
    Log ("{0}/{1} OK {2}s regen_docs={3} -> qa={4} :: {5}" -f $i, $targets.Count, [math]::Round($sw.Elapsed.TotalSeconds), $g.docs_used, $v.qa_status, $t)
  } catch {
    $sw.Stop()
    $msg = $_.Exception.Message
    $resp = $_.Exception.Response
    if ($resp) { try { $sr = New-Object IO.StreamReader($resp.GetResponseStream()); $msg = $sr.ReadToEnd() } catch {} }
    Log ("{0}/{1} FAIL {2}s :: {3} :: {4}" -f $i, $targets.Count, [math]::Round($sw.Elapsed.TotalSeconds), $t, ($msg -replace '\s+', ' ').Substring(0, [Math]::Min(300, $msg.Length)))
    Start-Sleep -Seconds 10
  }
}
Log 'worklist regen+verify complete'
