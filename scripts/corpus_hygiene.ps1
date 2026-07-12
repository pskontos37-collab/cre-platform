# corpus_hygiene.ps1 - WEEKLY corpus sweep. Keeps the text/OCR/embedding layers
# complete as new documents flow in (ingest, transactions, email inbox). Chains
# the three existing resumable passes - each skips work already done, so the
# sweep only touches what's new:
#   1. reindex_text.ps1   - verbatim text for new digital PDFs
#   2. ocr_text.ps1       - Claude transcription for new scanned docs
#   3. backfill_text_embeddings.ps1 - Voyage vectors for new content-only chunks
# plus a refresh of the lease critical dates (cheap, idempotent).
#
# Schedule weekly, off-hours (after the nightly doc sync + refresh_abstracts):
#   schtasks /Create /SC WEEKLY /D SUN /ST 02:00 /TN "CRE corpus hygiene" /TR
#     "powershell -NoProfile -File C:\Users\pskontos\Desktop\Software\cre-platform\scripts\corpus_hygiene.ps1"
# ONE session/process owns a run - never start it twice concurrently.
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$amp = [char]38
$log = "$PSScriptRoot\corpus_hygiene.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [hygiene] $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }

# DB-health gate between phases (protect the live app; see project-corpus-text-layer).
function Wait-DbHealthy {
  for ($t = 1; $t -le 40; $t++) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $code = & curl.exe -s -o NUL -w '%{http_code}' -A $UA -H "apikey: $KEY" -H "Authorization: Bearer $KEY" --max-time 15 "$BASE/rest/v1/properties?select=id${amp}limit=1"
    $sw.Stop()
    if ($code -eq '200' -and $sw.Elapsed.TotalSeconds -lt 3) { return }
    Log ("health-gate: http=$code {0:n1}s - wait 30s ($t/40)" -f $sw.Elapsed.TotalSeconds)
    Start-Sleep -Seconds 30
  }
  throw 'DB never became healthy - aborting hygiene sweep'
}

Log '=== HYGIENE SWEEP START ==='
Wait-DbHealthy
Log '--- phase: text reindex (new digital docs) ---'
& "$PSScriptRoot\reindex_text.ps1" -Shard 0 -Of 1 -DelayMs 400

Wait-DbHealthy
Log '--- phase: OCR (new scanned docs) ---'
& "$PSScriptRoot\ocr_text.ps1" -Shard 0 -Of 1 -DelayMs 400

Wait-DbHealthy
Log '--- phase: embedding backfill ---'
& "$PSScriptRoot\backfill_text_embeddings.ps1" -Batch 64 -DelayMs 1200

Wait-DbHealthy
Log '--- phase: lease critical-dates refresh ---'
$code = & curl.exe -s -o NUL -w '%{http_code}' -X POST -A $UA -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{}' "$BASE/rest/v1/rpc/sync_lease_critical_dates"
Log "critical-dates sync http=$code"

Log '=== HYGIENE SWEEP COMPLETE ==='
