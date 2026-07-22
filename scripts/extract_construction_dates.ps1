# extract_construction_dates.ps1 - extracts construction-phase and contingency
# obligations from lease documents into lease_construction_dates (mig 20240123),
# which generate_construction_critical_events() materializes onto the Critical
# Dates widget. Spec: docs/CONSTRUCTION-DATES-SPEC.md.
#
# Obligation types: plan_submittal, plan_approval, permit_contingency,
# delivery_deadline, construction_completion, opening_deadline,
# ti_allowance_request, rcd_outside_date.
#
# Trust chain: AI extracts WITH verbatim quotes (report mode) -> optional Opus
# cross-model confirmation of anything that would ALERT (live or termination-
# bearing rows) -> -Load inserts structured rows -> deterministic generator
# writes ledger events. AI never writes critical_events directly.
#
# Modes:
#   (default)        REPORT: build/refresh construction_dates.jsonl (resumable;
#                    leases already assessed are skipped) + print a summary.
#   -Confirm         Opus cross-model pass over live/termination obligations
#                    (refute-first rubric). Updates the JSONL in place.
#   -Load            insert rows + run both generators. Gating:
#                      historical rows: confidence high or medium
#                      live (open) rows: confidence high AND opus verdict confirm
#                    Low confidence or refuted rows are listed, never loaded.
#   -TenantLike <s>  only leases whose tenant name matches (golden-set runs)
#   -Limit <n>       cap leases processed this run (0 = all)
#   -MaxChars <n>    per-lease text budget sent to the model (default 60000)
#   -Force           allow -Load onto a lease that already has rows
#
# Run cadence: on new-lease ingest or amendment loads. REVIEW the JSONL before
# -Load: a false live date tells a manager to chase an obligation nobody owes.
param([switch]$Load, [switch]$Confirm, [string]$TenantLike = '', [int]$Limit = 0,
      [int]$MaxChars = 60000, [switch]$Force)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']; $AK = $cfg['ANTHROPIC_API_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$HW = @{ apikey = $KEY; Authorization = "Bearer $KEY"; Prefer = 'return=representation'; 'Content-Type' = 'application/json' }
$OUT = "$PSScriptRoot\construction_dates.jsonl"
$utf8 = New-Object System.Text.UTF8Encoding($false)
$TODAY = (Get-Date).ToString('yyyy-MM-dd')

function Nz($v) { if ($v -is [string] -and $v.Trim() -ne '') { return $v.Trim() } return $null }

# Deterministic status: a dated obligation is open iff its date is today or
# later; past dates are historical (they never alert; a human can reopen).
# Undated rows fall back to the model's live/historical classification
# (live+undated = conditional ledger event, no alert until dated).
function Get-DerivedStatus($ob) {
  $d = $null
  try {
    if (Nz($ob.fixed_date)) { $d = [datetime]::ParseExact($ob.fixed_date, 'yyyy-MM-dd', $null) }
    elseif ((Nz($ob.trigger_date)) -and ($null -ne $ob.offset_days)) {
      $d = ([datetime]::ParseExact($ob.trigger_date, 'yyyy-MM-dd', $null)).AddDays([int]$ob.offset_days)
    }
  } catch { $d = $null }
  if ($null -ne $d) {
    if ($d.Date -ge (Get-Date).Date) { return 'open' } else { return 'historical' }
  }
  if ($ob.classification -eq 'live') { return 'open' }
  return 'historical'
}

# Resolve a lease's document set (abstract source docs preferred, else tenant
# docs) and return labeled verbatim text blocks capped at the char budget.
function Get-LeaseEvidence($leaseRow, $tenantName) {
  $docIds = @()
  if ($tenantName) {
    $tq = [uri]::EscapeDataString('*' + (($tenantName -split ',')[0].Trim() -replace ' ', '*') + '*')
    $abs = Invoke-RestMethod -Uri "$BASE/rest/v1/lease_abstracts?select=source_doc_ids&property_id=eq.$($leaseRow.property_id)&tenant_name=ilike.$tq&limit=1" -Headers $H -UserAgent $UA -TimeoutSec 60
    if (@($abs).Count -ge 1 -and $abs[0].source_doc_ids) { $docIds = @($abs[0].source_doc_ids) }
  }
  if (-not $docIds.Count -and $leaseRow.tenant_id) {
    $ds = Invoke-RestMethod -Uri "$BASE/rest/v1/documents?select=id&tenant_id=eq.$($leaseRow.tenant_id)&property_id=eq.$($leaseRow.property_id)&order=file_mtime.asc&limit=10" -Headers $H -UserAgent $UA -TimeoutSec 60
    $docIds = @($ds | ForEach-Object { $_.id })
  }
  $names = @{}
  if ($docIds.Count) {
    $inList = ($docIds | ForEach-Object { '"' + $_ + '"' }) -join ','
    $meta = Invoke-RestMethod -Uri "$BASE/rest/v1/documents?select=id,file_name&id=in.($inList)" -Headers $H -UserAgent $UA -TimeoutSec 60
    foreach ($m in $meta) { $names[$m.id] = $m.file_name }
  }
  $sb = New-Object System.Text.StringBuilder
  foreach ($did in $docIds) {
    if ($sb.Length -ge $MaxChars) { break }
    $fn = $names[$did]; if (-not $fn) { $fn = 'unknown' }
    [void]$sb.AppendLine(('=== DOCUMENT doc_id=' + $did + ' file=' + $fn + ' ==='))
    $chunks = Invoke-RestMethod -Uri "$BASE/rest/v1/document_chunks?select=content,chunk_index&document_id=eq.$did&kind=eq.text&order=chunk_index.asc&limit=200" -Headers $H -UserAgent $UA -TimeoutSec 90
    foreach ($c in $chunks) {
      if ($sb.Length -ge $MaxChars) { break }
      if ($c.content) { [void]$sb.AppendLine($c.content) }
    }
  }
  $txt = $sb.ToString()
  if ($txt.Length -gt $MaxChars) { $txt = $txt.Substring(0, $MaxChars) }
  return @{ doc_ids = $docIds; text = $txt }
}

function Invoke-Claude($model, $sys, $usr, $tool, $maxTok) {
  $payload = @{ model = $model; max_tokens = $maxTok; system = $sys
                tools = @($tool); tool_choice = @{ type = 'tool'; name = $tool.name }
                messages = @(@{ role = 'user'; content = $usr }) } | ConvertTo-Json -Depth 16
  $tmp = "$env:TEMP\ccd_body.json"; [IO.File]::WriteAllText($tmp, $payload, $utf8)
  $resp = $null
  foreach ($try in 1..3) {
    try {
      $resp = Invoke-RestMethod -Uri 'https://api.anthropic.com/v1/messages' -Method Post -Headers @{ 'x-api-key' = $AK; 'anthropic-version' = '2023-06-01'; 'content-type' = 'application/json' } -InFile $tmp -TimeoutSec 300
      break
    } catch { if ($try -eq 3) { throw } Start-Sleep -Seconds (6 * $try) }
  }
  return ($resp.content | Where-Object { $_.type -eq 'tool_use' } | Select-Object -First 1).input
}

function Read-Jsonl() {
  $rows = @()
  if (Test-Path -LiteralPath $OUT) {
    foreach ($line in [IO.File]::ReadAllLines($OUT, $utf8)) { if ($line) { $rows += ($line | ConvertFrom-Json) } }
  }
  return $rows
}
function Write-Jsonl($rows) {
  $sb = New-Object System.Text.StringBuilder
  foreach ($r in $rows) { [void]$sb.AppendLine(($r | ConvertTo-Json -Depth 14 -Compress)) }
  [IO.File]::WriteAllText($OUT, $sb.ToString(), $utf8)
}

# ---------------- CONFIRM mode (Opus cross-model on alert-bearing rows) -------
if ($Confirm) {
  $rows = Read-Jsonl
  if (-not $rows.Count) { throw "no $OUT - run report mode first" }
  $ctool = @{
    name = 'submit_confirmation'
    description = 'Adjudicate each extracted obligation against the lease text.'
    input_schema = @{
      type = 'object'
      properties = @{
        verdicts = @{ type = 'array'; items = @{
          type = 'object'
          properties = @{
            index   = @{ type = 'integer'; description = 'index of the obligation being judged' }
            verdict = @{ type = 'string'; enum = @('confirm', 'refute', 'uncertain') }
            reason  = @{ type = @('string', 'null') }
          }
          required = @('index', 'verdict')
        } }
      }
      required = @('verdicts')
    }
  }
  $n = 0
  foreach ($r in $rows) {
    if (-not $r.obligations -or -not @($r.obligations).Count) { continue }
    $targets = @()
    for ($i = 0; $i -lt @($r.obligations).Count; $i++) {
      $ob = $r.obligations[$i]
      # only rows that can ALERT need the cross-model gate; historical rows never
      # alert regardless of grants_termination (class 'historical' wins)
      if ((Get-DerivedStatus $ob) -eq 'open') { $targets += $i }
    }
    if (-not $targets.Count) { continue }
    if ($r.PSObject.Properties['confirm'] -and $r.confirm) { continue }   # already confirmed
    $lease = @{ property_id = $r.property_id; tenant_id = $r.tenant_id }
    $ev = Get-LeaseEvidence ([pscustomobject]$lease) $r.tenant
    if (-not $ev.text.Trim()) { continue }
    $claims = @()
    foreach ($i in $targets) {
      $ob = $r.obligations[$i]
      $claims += ('[' + $i + '] type=' + $ob.obligation_type + ' obligor=' + $ob.obligor +
                  ' fixed_date=' + $ob.fixed_date + ' trigger=' + $ob.trigger_event +
                  ' offset_days=' + $ob.offset_days + ' trigger_date=' + $ob.trigger_date +
                  ' grants_termination=' + $ob.grants_termination + ' quote="' + $ob.quote + '"')
    }
    $sys = 'You are an adversarial verifier for a commercial-lease date extraction. Your default posture is REFUTE. For each claimed obligation, confirm ONLY if the lease text explicitly supports every asserted element (type, obligor, date or formula, termination consequence). Refute fabricated dates, misread obligors, and quotes that do not appear in the text. Uncertain if the text is insufficient. Judge only from the supplied text.'
    $usr = "Today: $TODAY`nTenant: $($r.tenant)`nProperty: $($r.property)`n`nCLAIMS:`n" + ($claims -join "`n") + "`n`n--- LEASE TEXT ---`n" + $ev.text
    $v = Invoke-Claude 'claude-opus-4-8' $sys $usr $ctool 2000
    $r | Add-Member -NotePropertyName confirm -NotePropertyValue $v.verdicts -Force
    $n++
    Write-Output ("confirmed {0} @ {1}: {2} verdict(s)" -f $r.tenant, $r.property, @($v.verdicts).Count)
  }
  Write-Jsonl $rows
  Write-Output ("done. cross-model pass over {0} lease(s) -> {1}" -f $n, $OUT)
  exit 0
}

# ---------------- LOAD mode ----------------
if ($Load) {
  if (-not (Test-Path -LiteralPath $OUT)) { throw "no $OUT - run report mode first" }
  $rows = Read-Jsonl
  $ins = 0; $skipLive = 0; $skipLow = 0; $skipDone = 0
  foreach ($r in $rows) {
    if ($r.applied) { continue }
    if (-not $r.obligations -or -not @($r.obligations).Count) { continue }
    $existing = Invoke-RestMethod -Uri "$BASE/rest/v1/lease_construction_dates?select=id&lease_id=eq.$($r.lease_id)&limit=1" -Headers $H -UserAgent $UA -TimeoutSec 60
    if (@($existing).Count -gt 0 -and -not $Force) {
      Write-Output ("SKIP (rows exist, use -Force): {0} @ {1}" -f $r.tenant, $r.property); $skipDone++; continue
    }
    $loadedAny = $false
    for ($i = 0; $i -lt @($r.obligations).Count; $i++) {
      $ob = $r.obligations[$i]
      if ($null -eq $ob) { continue }
      $st = Get-DerivedStatus $ob
      # well-formed or skip: type/obligor must satisfy the table checks, quote must
      # exist (evidence mandate), confidence must be an explicit high/medium
      $typesOk = @('plan_submittal','plan_approval','permit_contingency','delivery_deadline','construction_completion','opening_deadline','ti_allowance_request','rcd_outside_date') -contains $ob.obligation_type
      $obligorOk = @('tenant','landlord','either') -contains $ob.obligor
      if (-not $typesOk -or -not $obligorOk -or -not (Nz($ob.quote))) { $skipLow++; continue }
      if (@('high','medium') -notcontains $ob.confidence) { $skipLow++; continue }
      # an Opus REFUTE kills the row outright, historical or live - refuted rows
      # carry a defect (wrong type, unsupported flag, bad quote) we must not store
      if ($r.PSObject.Properties['confirm'] -and $r.confirm) {
        $rv = @($r.confirm | Where-Object { $_.index -eq $i } | Select-Object -First 1)
        if ($rv.Count -and $rv[0].verdict -eq 'refute') {
          Write-Output ("REFUTED (dropped): {0} {1} @ {2}" -f $ob.obligation_type, $r.tenant, $r.property)
          continue
        }
      }
      if ($st -eq 'open') {
        # anything that can ALERT needs high confidence + an Opus confirm verdict
        $ok = $false
        if ($ob.confidence -eq 'high' -and $r.PSObject.Properties['confirm'] -and $r.confirm) {
          $vd = @($r.confirm | Where-Object { $_.index -eq $i } | Select-Object -First 1)
          if ($vd.Count -and $vd[0].verdict -eq 'confirm') { $ok = $true }
        }
        if (-not $ok) {
          Write-Output ("HELD (live, needs -Confirm confirm verdict): [{0}] {1} {2} @ {3}" -f $ob.confidence, $ob.obligation_type, $r.tenant, $r.property)
          $skipLive++; continue
        }
      }
      $docId = Nz($ob.source_doc_id)
      if ($docId -and $r.doc_ids -notcontains $docId) { $docId = $null }
      $body = [ordered]@{
        lease_id = $r.lease_id; property_id = $r.property_id
        obligation_type = $ob.obligation_type; obligor = $ob.obligor
        fixed_date = (Nz($ob.fixed_date)); trigger_event = (Nz($ob.trigger_event))
        offset_days = $ob.offset_days; trigger_date = (Nz($ob.trigger_date))
        window_earliest = (Nz($ob.window_earliest)); window_latest = (Nz($ob.window_latest))
        remedy = (Nz($ob.remedy)); grants_termination = [bool]$ob.grants_termination
        status = $st
        source_document_id = $docId; source_quote = (Nz($ob.quote)); section_ref = (Nz($ob.section_ref))
        extraction_model = 'claude-sonnet-5'; extraction_confidence = $ob.confidence
        extracted_at = (Get-Date).ToUniversalTime().ToString('o')
        notes = (Nz($ob.classification_basis))
      } | ConvertTo-Json -Depth 6
      $res = Invoke-RestMethod -Uri "$BASE/rest/v1/lease_construction_dates" -Method Post -Headers $HW -UserAgent $UA -Body $body -TimeoutSec 60
      if (@($res).Count -ge 1) { $ins++; $loadedAny = $true }
    }
    if ($loadedAny) { $r.applied = $true }
  }
  Write-Jsonl $rows
  Write-Output ("inserted {0} row(s). held-live {1}, low-confidence {2}, lease-already-loaded {3}" -f $ins, $skipLive, $skipLow, $skipDone)
  if ($ins -gt 0) {
    Write-Output 'running generators...'
    $g1 = Invoke-RestMethod -Uri "$BASE/rest/v1/rpc/generate_construction_critical_events" -Method Post -Headers $HW -UserAgent $UA -Body '{}' -TimeoutSec 120
    $g2 = Invoke-RestMethod -Uri "$BASE/rest/v1/rpc/generate_termination_window_events" -Method Post -Headers $HW -UserAgent $UA -Body '{}' -TimeoutSec 120
    Write-Output ("construction events: {0}   termination-window events: {1}" -f $g1, $g2)
  }
  exit 0
}

# ---------------- REPORT mode ----------------
$sel = 'id,property_id,status,commencement_date,expiration_date,tenant_id,tenant:tenants(name,trade_name)'
$q = [uri]::EscapeDataString($sel)
$leases = Invoke-RestMethod -Uri "$BASE/rest/v1/leases?select=$q&status=eq.active&limit=1000" -Headers $H -UserAgent $UA -TimeoutSec 120
Write-Output ("active leases: {0}" -f @($leases).Count)

$props = Invoke-RestMethod -Uri "$BASE/rest/v1/properties?select=id,name&limit=200" -Headers $H -UserAgent $UA -TimeoutSec 60
$pname = @{}; foreach ($p in $props) { $pname[$p.id] = $p.name }

$done = @{}
foreach ($r in (Read-Jsonl)) { $done[$r.lease_id] = $true }

$todo = @()
foreach ($ls in $leases) {
  if ($done.ContainsKey($ls.id)) { continue }
  $tn = $null; if ($ls.tenant) { $tn = Nz($ls.tenant.trade_name); if (-not $tn) { $tn = Nz($ls.tenant.name) } }
  if ($TenantLike -and ($tn -notlike ('*' + $TenantLike + '*'))) { continue }
  $todo += ,@($ls, $tn)
}
if ($Limit -gt 0) { $todo = @($todo | Select-Object -First $Limit) }
Write-Output ("already assessed: {0}   to do: {1}" -f $done.Count, @($todo).Count)

$obSchema = @{
  type = 'object'
  properties = @{
    obligation_type = @{ type = 'string'; enum = @('plan_submittal', 'plan_approval', 'permit_contingency', 'delivery_deadline', 'construction_completion', 'opening_deadline', 'ti_allowance_request', 'rcd_outside_date') }
    obligor = @{ type = 'string'; enum = @('tenant', 'landlord', 'either'); description = 'who owes the performance' }
    fixed_date = @{ type = @('string', 'null'); description = 'YYYY-MM-DD, ONLY if a calendar date is explicitly stated or derivable from a dated certificate in the documents. Never invent.' }
    trigger_event = @{ type = @('string', 'null'); description = 'what starts the clock, e.g. "delivery of possession", "lease execution", "permit issuance"' }
    offset_days = @{ type = @('integer', 'null'); description = 'days after trigger_event (convert months to days at 30/month only if the lease states months)' }
    trigger_date = @{ type = @('string', 'null'); description = 'YYYY-MM-DD, ONLY if the trigger is dated by the documents (e.g. a delivery certificate)' }
    window_earliest = @{ type = @('string', 'null') }
    window_latest = @{ type = @('string', 'null') }
    remedy = @{ type = @('string', 'null'); description = 'consequence of a miss: termination, abatement, allowance forfeiture, self-help, etc.' }
    grants_termination = @{ type = 'boolean'; description = 'true if missing this date gives EITHER party a termination right' }
    classification = @{ type = 'string'; enum = @('live', 'historical'); description = 'live ONLY if the obligation could still require action after today (tenant not yet open / date not yet passed / contingency unresolved). Long-completed construction = historical.' }
    classification_basis = @{ type = @('string', 'null'); description = 'one line: why live or historical' }
    source_doc_id = @{ type = @('string', 'null'); description = 'the doc_id header of the DOCUMENT block the quote came from' }
    section_ref = @{ type = @('string', 'null') }
    quote = @{ type = 'string'; description = 'short VERBATIM quote of the provision (max ~40 words)' }
    confidence = @{ type = 'string'; enum = @('high', 'medium', 'low'); description = 'high only if the provision text is explicit in the supplied documents' }
  }
  required = @('obligation_type', 'obligor', 'grants_termination', 'classification', 'quote', 'confidence')
}
$tool = @{
  name = 'submit_construction_dates'
  description = 'Report every construction-phase / contingency dated obligation found in the lease documents.'
  input_schema = @{
    type = 'object'
    properties = @{
      obligations = @{ type = 'array'; items = $obSchema; description = 'empty array if the documents contain none' }
      tenant_open_and_operating = @{ type = 'string'; enum = @('yes', 'no', 'unknown'); description = 'is there evidence the tenant has already opened for business (estoppels, notices, rent history, old dates)?' }
      note = @{ type = @('string', 'null') }
    }
    required = @('obligations', 'tenant_open_and_operating')
  }
}

$sys = 'You are a commercial real estate lease analyst working for the LANDLORD. Extract construction-phase and contingency DATED obligations from the supplied lease documents: plan submittal deadlines, landlord plan-approval windows, permit contingencies and outside dates, delivery-of-possession deadlines, construction completion deadlines, tenant opening deadlines, TI-allowance requisition deadlines, and rent-commencement outside dates. Rules: quote provisions VERBATIM; never invent or infer calendar dates that are not stated or certificate-derivable; prefer trigger+offset formulas when the lease states them; report the general permitted-use or maintenance clauses NOWHERE (only the 8 listed types); if the documents contain none, return an empty array. Be brief in every text field.'

$n = 0; $withHits = 0; $liveCount = 0; $gaps = @()
foreach ($pair in $todo) {
  $ls = $pair[0]; $tn = $pair[1]
  $n++
  $prop = $pname[$ls.property_id]; if (-not $prop) { $prop = 'unknown' }
  $ev = Get-LeaseEvidence $ls $tn
  $v = $null; $reason = $null
  if (-not $ev.text.Trim()) {
    $reason = 'no text layer - OCR/manual review needed'
    $v = [ordered]@{ obligations = @(); tenant_open_and_operating = 'unknown'; note = $reason }
    $gaps += ("{0} @ {1}" -f $tn, $prop)
  }
  else {
    $usr = "Today: $TODAY`nProperty: $prop`nTenant: $tn`nLease commencement (MRI): $($ls.commencement_date)`nLease expiration (MRI): $($ls.expiration_date)`n`n--- LEASE DOCUMENTS ---`n" + $ev.text
    $v = Invoke-Claude 'claude-sonnet-5' $sys $usr $tool 4000
  }
  $rec = [ordered]@{
    lease_id = $ls.id; property_id = $ls.property_id; tenant_id = $ls.tenant_id
    property = $prop; tenant = $tn
    commencement = $ls.commencement_date; expiration = $ls.expiration_date
    doc_ids = $ev.doc_ids; text_chars = $ev.text.Length
    obligations = $v.obligations; tenant_open = $v.tenant_open_and_operating
    note = (Nz($v.note)); reason = $reason; applied = $false
  }
  [IO.File]::AppendAllText($OUT, (($rec | ConvertTo-Json -Depth 14 -Compress) + "`n"), $utf8)
  $obs = @($v.obligations)
  if ($obs.Count) {
    $withHits++
    foreach ($ob in $obs) {
      $st = Get-DerivedStatus $ob
      if ($st -eq 'open') {
        $liveCount++
        Write-Output ("LIVE [{0}] {1} {2} @ {3}: fixed={4} trigger={5}+{6}d term={7}" -f $ob.confidence, $ob.obligation_type, $tn, $prop, $ob.fixed_date, $ob.trigger_event, $ob.offset_days, $ob.grants_termination)
      }
    }
  }
  if ($n % 10 -eq 0) { Write-Output ("...{0}/{1}" -f $n, @($todo).Count) }
}
Write-Output ("done. assessed {0} lease(s): {1} with obligations, {2} LIVE obligation(s)" -f $n, $withHits, $liveCount)
if ($gaps.Count) {
  Write-Output ("DOC GAPS (no text layer): {0}" -f $gaps.Count)
  foreach ($g in $gaps) { Write-Output ("  {0}" -f $g) }
}
Write-Output 'Next: review the JSONL, run -Confirm (Opus pass on live/termination rows), then -Load.'
