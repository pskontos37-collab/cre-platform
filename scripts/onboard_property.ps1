# onboard_property.ps1 - ONE-COMMAND document onboarding for a new property.
# Chains the full corpus + abstract pipeline that was assembled piecewise for the
# first four properties, with a DB-health gate between phases (the shared prod DB
# browns out under careless bulk writes - see project-corpus-text-layer).
#
#   .\onboard_property.ps1 -PropertyId <uuid> -IngestRoot 'V:\<Property>\TENANTS'
#   .\onboard_property.ps1 -PropertyId <uuid> -StartPhase abstract   # resume later phase
#
# Phases (each resumable on its own; rerunning a phase skips completed work):
#   ingest   - scripts/ingest_local_docs.ps1 (INGEST_ROOT/INGEST_PID env contract)
#   text     - reindex_text.ps1 -PropertyId    (verbatim text layer, digital PDFs)
#   ocr      - ocr_text.ps1 -PropertyId        (Claude transcription of scanned docs)
#   embed    - backfill_text_embeddings.ps1    (Voyage vectors for new text chunks)
#   abstract - batch_abstracts.ps1             (v21 abstractor, every active tenant)
#   verify   - batch_verify.ps1                (adversarial QA on every abstract)
#
# PREREQS the script cannot do for you: the property + leases/units rows must be
# seeded (MRI loaders) BEFORE 'abstract' (tenant roster + cross-check come from
# the lease model), and the property must exist in `properties`.
#
# DUE-DILIGENCE MODE: this same pipeline works on an ACQUISITION TARGET's data
# room. Create a placeholder property row + minimal leases rows (rent roll from
# the offering memo), point -IngestRoot at the VDR folder, run all phases: out
# comes a full abstract book + adversarial QA flags + missing-document list for
# the deal team. Delete or keep the property after close.
# COST guide per ~40-tenant property: text/embed pennies, OCR ~$1-3/scanned-doc-
# heavy tenant file, abstract+verify ~USD 2/tenant. Runs sequentially; leave the
# window open (hours). ONE session should own a run - never start it twice.
param(
  [Parameter(Mandatory = $true)][string]$PropertyId,
  [string]$IngestRoot = '',                 # omit to skip the ingest phase (docs already loaded)
  [ValidateSet('ingest','text','ocr','embed','abstract','verify')][string]$StartPhase = 'ingest',
  [int]$OcrDelayMs = 400
)
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$log = "$PSScriptRoot\onboard_$($PropertyId.Substring(0,8)).log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [onboard] $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }

# DB-health gate: refuse to start the next bulk phase while the shared prod DB is
# slow (protects the live app; lesson learned the hard way on 2026-07-07).
function Wait-DbHealthy {
  for ($t = 1; $t -le 40; $t++) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $code = & curl.exe -s -o NUL -w '%{http_code}' -A $UA -H "apikey: $KEY" -H "Authorization: Bearer $KEY" --max-time 15 "$BASE/rest/v1/properties?select=id${amp}limit=1"
    $sw.Stop()
    if ($code -eq '200' -and $sw.Elapsed.TotalSeconds -lt 3) { return }
    Log ("DB health-gate: http=$code {0:n1}s - waiting 30s (try $t/40)" -f $sw.Elapsed.TotalSeconds)
    Start-Sleep -Seconds 30
  }
  throw 'DB never became healthy - aborting onboard run'
}
$amp = [char]38

# Sanity: property must exist.
$p = Invoke-RestMethod -Uri "$BASE/rest/v1/properties?select=id,name${amp}id=eq.$PropertyId" -Headers @{ apikey = $KEY; Authorization = "Bearer $KEY" } -UserAgent $UA -TimeoutSec 30
if (-not $p) { throw "PropertyId $PropertyId not found in properties - seed it first" }
Log ("=== ONBOARD START: {0} ({1}) from phase '{2}' ===" -f $p[0].name, $PropertyId, $StartPhase)

$phases = @('ingest','text','ocr','embed','abstract','verify')
$startIdx = $phases.IndexOf($StartPhase)

foreach ($ph in $phases[$startIdx..($phases.Count - 1)]) {
  Wait-DbHealthy
  Log "--- PHASE: $ph ---"
  switch ($ph) {
    'ingest' {
      if (-not $IngestRoot) { Log 'no -IngestRoot given - skipping ingest (docs assumed loaded)'; break }
      $env:INGEST_ROOT = $IngestRoot; $env:INGEST_PID = $PropertyId
      & "$PSScriptRoot\ingest_local_docs.ps1"
    }
    'text'     { & "$PSScriptRoot\reindex_text.ps1" -PropertyId $PropertyId -DelayMs 400 }
    'ocr'      { & "$PSScriptRoot\ocr_text.ps1" -PropertyId $PropertyId -DelayMs $OcrDelayMs }
    'embed'    { & "$PSScriptRoot\backfill_text_embeddings.ps1" -Batch 64 -DelayMs 1200 }
    'abstract' { & "$PSScriptRoot\batch_abstracts.ps1" -PropertyIds @($PropertyId) }
    'verify'   { & "$PSScriptRoot\batch_verify.ps1" -PropertyIds @($PropertyId) }
  }
  Log "--- PHASE DONE: $ph ---"
}
Log '=== ONBOARD COMPLETE - triage the QA board on /abstracts (Review & correct + lock as you go) ==='
