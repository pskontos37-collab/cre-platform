# extract_service_agreements.ps1 - abstracts vendor service contracts out of the
# corpus into service_agreements (migration 20240037) for the /services panel.
#
# Two modes:
#   (default)  EXTRACT: pulls candidate docs (title heuristics) + their summary
#              chunks, runs Claude (forced-JSON tool) per doc, appends one line
#              per doc to scripts\service_agreements_extract.jsonl. Resumable -
#              docs already in the JSONL are skipped, so re-runs only do new docs.
#   -Load      LOAD: reads the JSONL, keeps rows the model confirmed as real
#              service agreements, computes status from end_date/auto_renews,
#              upserts via PostgREST on_conflict=document_id (re-runnable),
#              then applies manual status overrides (Budd Group terminated).
#
# Requires the service_agreements table (run migration 20240037 first for -Load).
param([switch]$Load, [int]$Limit = 0)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']; $AK = $cfg['ANTHROPIC_API_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$OUT = "$PSScriptRoot\service_agreements_extract.jsonl"
$TODAY = '2026-07-05'
$utf8 = New-Object System.Text.UTF8Encoding($false)

$CATEGORIES = @('landscaping','snow removal','sweeping/portering','janitorial','trash/waste','hvac','roofing','paving/parking lot','painting','signage','lighting/electrical','fire/life safety','security','elevator','pest control','pond/retention','canopy/awning','plumbing','general maintenance','professional services','other')

function IsoOrNull($v) {
  if ($v -is [string] -and $v -match '^\d{4}-\d{2}-\d{2}$') { return $v }
  return $null
}

if (-not $Load) {
  # ---- candidate documents (same heuristics as the corpus survey) ----
  $re1 = [uri]::EscapeDataString('(agreement|contract)')
  $re2 = [uri]::EscapeDataString('landscap|snow|janitorial|sweep|security|elevator|hvac|trash|waste|pest|fire|towing|maintenance|clean|service|roof|paint|paving|pond|sign|canopy|lighting|welding')
  $re3 = [uri]::EscapeDataString('lease|easement|management agreement|purchase|loan|reciprocal|estoppel|invoice|waiver|surrender|license agreement|subordination|consent')
  $docs = Invoke-RestMethod -Uri "$BASE/rest/v1/documents?select=id,property_id,title,file_path&title=imatch.$re1&title=imatch.$re2&title=not.imatch.$re3&property_id=not.is.null&limit=1000" -Headers $H -UserAgent $UA -TimeoutSec 120
  Write-Output ("candidates: {0}" -f $docs.Count)

  $props = Invoke-RestMethod -Uri "$BASE/rest/v1/properties?select=id,name&limit=200" -Headers $H -UserAgent $UA -TimeoutSec 60
  $pname = @{}; foreach ($p in $props) { $pname[$p.id] = $p.name }

  $done = @{}
  if (Test-Path -LiteralPath $OUT) {
    foreach ($line in [IO.File]::ReadAllLines($OUT, $utf8)) {
      if ($line) { $done[(($line | ConvertFrom-Json).document_id)] = $true }
    }
  }
  $todo = @($docs | Where-Object { -not $done.ContainsKey($_.id) })
  if ($Limit -gt 0) { $todo = @($todo | Select-Object -First $Limit) }
  Write-Output ("already extracted: {0}   to do: {1}" -f $done.Count, $todo.Count)

  # ---- summary chunks (chunk_index 0..2), batched ----
  $chunks = @{}
  for ($i = 0; $i -lt $todo.Count; $i += 40) {
    $hi = [Math]::Min($i + 39, $todo.Count - 1)
    $ids = ($todo[$i..$hi] | ForEach-Object { $_.id }) -join ','
    $rows = Invoke-RestMethod -Uri "$BASE/rest/v1/document_chunks?select=document_id,chunk_index,content&document_id=in.($ids)&chunk_index=lte.2&order=document_id,chunk_index&limit=500" -Headers $H -UserAgent $UA -TimeoutSec 120
    foreach ($r in $rows) {
      if (-not $chunks.ContainsKey($r.document_id)) { $chunks[$r.document_id] = '' }
      $chunks[$r.document_id] = $chunks[$r.document_id] + ' ' + $r.content
    }
  }

  $tool = @{
    name = 'submit_extraction'
    description = 'Submit the structured abstraction of a vendor service agreement.'
    input_schema = @{
      type = 'object'
      properties = @{
        is_service_agreement = @{ type = 'boolean'; description = 'true ONLY for an actual vendor service / maintenance / professional-services contract for this property' }
        vendor = @{ type = 'string'; description = 'company PROVIDING the service' }
        service_category = @{ type = 'string'; enum = $CATEGORIES }
        description = @{ type = 'string'; description = 'one sentence: scope of work and frequency, max 200 chars' }
        agreement_date = @{ type = @('string', 'null'); description = 'contract/signature date, yyyy-mm-dd' }
        start_date = @{ type = @('string', 'null'); description = 'service start, yyyy-mm-dd' }
        end_date = @{ type = @('string', 'null'); description = 'expiration, yyyy-mm-dd, ONLY if stated or exactly derivable' }
        term_summary = @{ type = @('string', 'null'); description = 'short phrase, e.g. 1 yr from 2024-04-01, auto-renews annually, 30-day out' }
        auto_renews = @{ type = @('boolean', 'null') }
        cancel_notice_days = @{ type = @('integer', 'null') }
        annual_value = @{ type = @('number', 'null'); description = 'approx USD per year if derivable from stated pricing' }
        pricing_summary = @{ type = @('string', 'null'); description = 'e.g. $2,450/mo or $18,500/season or $12,900 lump sum' }
      }
      required = @('is_service_agreement')
    }
  }

  $n = 0; $ok = 0; $skip = 0; $fail = 0
  foreach ($d in $todo) {
    $n++
    $prop = $pname[$d.property_id]; if (-not $prop) { $prop = 'unknown property' }
    $body = $chunks[$d.id]; if (-not $body) { $body = '(no extract available)' }
    if ($body.Length -gt 4000) { $body = $body.Substring(0, 4000) }
    $prompt = @"
You are abstracting vendor contracts for a commercial retail property management team. Today is $TODAY.

PROPERTY: $prop
DOCUMENT TITLE (AI summary of the document): $($d.title)
DOCUMENT EXTRACT: $body

Decide whether this document is an actual vendor SERVICE / MAINTENANCE / PROFESSIONAL-SERVICES contract
(executed or clearly operative) between the property owner or manager and a service vendor - e.g.
landscaping, snow removal, sweeping, janitorial, trash, HVAC, roofing, paving, painting, signage,
lighting, fire/life safety, security, elevator, pest control, pond maintenance, canopy cleaning,
consulting/professional services. The following are NOT service agreements: leases, easements,
right-of-entry agreements, licenses, lien waivers or affidavits, termination notices, plain email
correspondence, O+M manuals, invoices, insurance exhibits, contact lists, and unsigned proposals.
If an email chain FORWARDS or TRANSMITS an actual contract whose terms are described, treat it as
the contract. Extract only what is present - never invent dates or prices. Dates must be yyyy-mm-dd.
end_date only when stated or exactly derivable (e.g. one-year term commencing 2024-04-01 ends 2025-03-31).
If the contract runs until terminated or renews automatically, leave end_date null and set auto_renews.
Call submit_extraction with your result.
"@
    $req = @{
      model = 'claude-sonnet-5'
      max_tokens = 800
      tools = @($tool)
      tool_choice = @{ type = 'tool'; name = 'submit_extraction' }
      messages = @(@{ role = 'user'; content = $prompt })
    } | ConvertTo-Json -Depth 12
    $x = $null
    for ($try = 1; $try -le 3; $try++) {
      try {
        $r = Invoke-RestMethod -Method Post -Uri 'https://api.anthropic.com/v1/messages' -Headers @{ 'x-api-key' = $AK; 'anthropic-version' = '2023-06-01' } -ContentType 'application/json' -Body ($utf8.GetBytes($req)) -TimeoutSec 180
        $tu = $r.content | Where-Object { $_.type -eq 'tool_use' } | Select-Object -First 1
        $x = $tu.input
        break
      } catch {
        $e = if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
        if ($try -lt 3 -and ($e -match '429|529|overloaded')) { Start-Sleep -Seconds (15 * $try); continue }
        Write-Output ("FAIL {0} :: {1}" -f $d.id, $e.Substring(0, [Math]::Min(160, $e.Length)))
        $fail++
        break
      }
    }
    if ($null -eq $x) { continue }
    $rec = [ordered]@{
      document_id = $d.id
      property_id = $d.property_id
      title       = $d.title
      file_path   = $d.file_path
      extraction  = $x
    }
    [IO.File]::AppendAllText($OUT, (($rec | ConvertTo-Json -Depth 10 -Compress) + "`n"), $utf8)
    if ($x.is_service_agreement) { $ok++ } else { $skip++ }
    if ($n % 20 -eq 0) { Write-Output ("{0}/{1}  agreements {2}  skipped {3}  failed {4}" -f $n, $todo.Count, $ok, $skip, $fail) }
  }
  Write-Output ("DONE extract  {0}/{1}  agreements {2}  skipped {3}  failed {4}" -f $n, $todo.Count, $ok, $skip, $fail)
  exit 0
}

# ---------------- LOAD mode ----------------
# Merges the corpus JSONL with svc_files_extract.jsonl (authoritative V: folder
# reads). Same physical file extracted by both pipelines collapses to one row via
# source_key = canonical path; file rows are processed LAST so full-PDF terms win.
function CanonKey($fp, $docId) {
  if ($fp) {
    $k = $fp -replace '^file:', ''
    $k = $k -replace '\\\\192\.168\.220\.121\\virtual_file_room', 'V:'
    return $k.Trim().ToLower()
  }
  return "doc:$docId"
}
if (-not (Test-Path -LiteralPath $OUT)) { throw "no extract file at $OUT - run extract mode first" }
$FILEOUT = "$PSScriptRoot\svc_files_extract.jsonl"
$lines = @([IO.File]::ReadAllLines($OUT, $utf8))
if (Test-Path -LiteralPath $FILEOUT) { $lines += [IO.File]::ReadAllLines($FILEOUT, $utf8) }

# basename -> corpus document id, so V:-sourced rows still get a doc-search link
$docmap = @{}
$svcEsc = [uri]::EscapeDataString('*Service Agreements*')
$cdocs = Invoke-RestMethod -Uri "$BASE/rest/v1/documents?select=id,file_path&file_path=ilike.$svcEsc&limit=1000" -Headers $H -UserAgent $UA -TimeoutSec 120
foreach ($cd in $cdocs) { $docmap[([IO.Path]::GetFileName($cd.file_path)).ToLower()] = $cd.id }

$byKey = [ordered]@{}
foreach ($line in $lines) {
  if (-not $line) { continue }
  $rec = $line | ConvertFrom-Json
  $x = $rec.extraction
  if (-not $x.is_service_agreement) { continue }
  if (-not $x.vendor -or -not $x.service_category) { continue }
  $endD = IsoOrNull $x.end_date
  $status = 'unknown'
  if ($endD) { if ($endD -lt $TODAY) { $status = 'expired' } else { $status = 'active' } }
  elseif ($x.auto_renews -eq $true) { $status = 'active' }
  $desc = $x.description; if ($desc -and $desc.Length -gt 300) { $desc = $desc.Substring(0, 300) }
  $docId = $rec.document_id
  if (-not $docId -and $rec.file_path) {
    $bn = ([IO.Path]::GetFileName($rec.file_path)).ToLower()
    if ($docmap.ContainsKey($bn)) { $docId = $docmap[$bn] }
  }
  $noteVal = $null
  if ($x.PSObject.Properties['notes'] -and $x.notes) { $noteVal = $x.notes }
  $key = CanonKey $rec.file_path $rec.document_id
  $byKey[$key] = [pscustomobject]@{
    property_id        = $rec.property_id
    document_id        = $docId
    source_key         = $key
    file_path          = $rec.file_path
    vendor             = $x.vendor
    service_category   = $x.service_category
    description        = $desc
    agreement_date     = IsoOrNull $x.agreement_date
    start_date         = IsoOrNull $x.start_date
    end_date           = $endD
    term_summary       = $x.term_summary
    auto_renews        = $x.auto_renews
    cancel_notice_days = $x.cancel_notice_days
    annual_value       = $x.annual_value
    pricing_summary    = $x.pricing_summary
    status             = $status
    notes              = $noteVal
    source             = 'ai'
  }
}
$rows = @($byKey.Values)
Write-Output ("rows to upsert: {0}" -f $rows.Count)
$inserted = 0
for ($i = 0; $i -lt $rows.Count; $i += 50) {
  $hi = [Math]::Min($i + 49, $rows.Count - 1)
  $batch = @($rows[$i..$hi])
  $payload = ConvertTo-Json $batch -Depth 6
  if ($batch.Count -eq 1) { $payload = "[$payload]" }
  $tmpf = "$env:TEMP\svc_agr_batch.json"
  [IO.File]::WriteAllText($tmpf, $payload, $utf8)
  $resp = Invoke-RestMethod -Method Post -Uri "$BASE/rest/v1/service_agreements?on_conflict=source_key" -Headers ($H + @{ Prefer = 'resolution=merge-duplicates,return=representation' }) -UserAgent $UA -ContentType 'application/json' -InFile $tmpf -TimeoutSec 120
  $inserted += @($resp).Count
}
Write-Output ("upserted: {0}" -f $inserted)

# ---- manual status overrides (survive re-extraction because rows re-PATCH) ----
# The Budd Group landscaping at KM East was terminated by BBK Midway Plantation
# (formal termination notice in the corpus).
$bg = [uri]::EscapeDataString('*Budd Group*')
$patch = '{"status":"terminated","notes":"Terminated by BBK Midway Plantation LLC - formal termination notice in corpus (see Documents)."}'
$r2 = Invoke-RestMethod -Method Patch -Uri "$BASE/rest/v1/service_agreements?vendor=ilike.$bg&property_id=eq.00000000-0000-0000-0000-000000000010" -Headers ($H + @{ Prefer = 'return=representation' }) -UserAgent $UA -ContentType 'application/json' -Body $patch -TimeoutSec 60
Write-Output ("Budd Group rows marked terminated: {0}" -f @($r2).Count)

# The extraction derives status/end_date only from the AI summary chunks, which miss
# terms buried in the full contract / T&C. These PATCHes encode the corrected effective
# terms (from reading the full PDFs) so they survive every re-run of -Load.
$GW = 'd5a4ed03-0b60-4168-9208-83822dd24884'; $MAG = 'd4f08824-2d88-472d-b7aa-a703310c2aaf'

# These target the ONE current contract by source_key (the exact V: file). Broad
# vendor+property filters over-match now that prior-year contracts are ingested as their
# own rows - a prior year's row must keep its own extracted term, not the current one's.
# Rocket Pest (Magnolia), current 1-1-25 contract: T&C auto-renews annually -> end 2026-12-31.
$rk = [uri]::EscapeDataString('*agr-rocket pest control-monthly services (1-1-25)*')
$rRk = Invoke-RestMethod -Method Patch -Uri "$BASE/rest/v1/service_agreements?source_key=ilike.$rk&property_id=eq.$MAG" -Headers ($H + @{ Prefer = 'return=representation' }) -UserAgent $UA -ContentType 'application/json' -Body '{"end_date":"2026-12-31","status":"active"}' -TimeoutSec 60
Write-Output ("Rocket Pest end_date corrected: {0}" -f @($rRk).Count)

# Suburban Carting (Gateway), current 7-30-24 contract: Exhibit-A 24-month binding period -> ends 2026-07-31.
$sb = [uri]::EscapeDataString('*agr-suburban carting-trash removal (7-30-24)*')
$rSb = Invoke-RestMethod -Method Patch -Uri "$BASE/rest/v1/service_agreements?source_key=ilike.$sb&property_id=eq.$GW" -Headers ($H + @{ Prefer = 'return=representation' }) -UserAgent $UA -ContentType 'application/json' -Body '{"end_date":"2026-07-31","status":"active"}' -TimeoutSec 60
Write-Output ("Suburban Carting end_date corrected: {0}" -f @($rSb).Count)

# CMS + AM Mechanical (Magnolia HVAC): 2014 evergreen agreements that show 'active' only
# via the auto-renew flag with no stated end date - flag them as stale.
$hnote = '{"notes":"Stale evergreen: 2014 HVAC service agreement with auto-renewal and no stated end date; shows active only via the auto-renew flag. Likely superseded - verify current HVAC PM coverage before relying on it."}'
$rHv = Invoke-RestMethod -Method Patch -Uri "$BASE/rest/v1/service_agreements?property_id=eq.$MAG&service_category=eq.hvac&end_date=is.null&auto_renews=eq.true&vendor=ilike.*Mechanical*" -Headers ($H + @{ Prefer = 'return=representation' }) -UserAgent $UA -ContentType 'application/json' -Body $hnote -TimeoutSec 60
Write-Output ("MAG HVAC evergreen notes restored: {0}" -f @($rHv).Count)

# NOTE: the former Greenery pressure-washing document_id override was REMOVED - every
# pressure-washing contract is now ingested as its own corpus doc and each row carries its
# own correct document_id from the JSONL, so the broad override only mis-linked them.

$sum = Invoke-RestMethod -Uri "$BASE/rest/v1/service_agreements?select=status,property_id&limit=2000" -Headers $H -UserAgent $UA -TimeoutSec 60
$sum | Group-Object status | ForEach-Object { Write-Output ("  {0}: {1}" -f $_.Name, $_.Count) }
Write-Output 'DONE load'
