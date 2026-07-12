# extract_brokerage_agreements.ps1 - reads every PDF in the four properties'
# OPERATIONS\Brokerage & Leasing Agreements (+ Magnolia Commission Agreements)
# folders straight from V: (native-PDF Claude extraction) and appends results to
# scripts\brokerage_extract.jsonl. Resumable: paths already in the JSONL skip.
#
#   (default)  EXTRACT: one Claude call per file -> JSONL
#   -Load      LOAD: JSONL -> PostgREST upsert into brokerage_agreements
#              (on_conflict=source_key, re-runnable), attaching document_id
#              when the corpus holds the same file, then status overrides.
#
# Requires the brokerage_agreements table (migration 20240038) for -Load.
param([switch]$Load)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']; $AK = $cfg['ANTHROPIC_API_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$OUT = "$PSScriptRoot\brokerage_extract.jsonl"
$TODAY = '2026-07-05'
$utf8 = New-Object System.Text.UTF8Encoding($false)

$KME = 'V:\Knightdale Marketplace 7-15-19\KM-East (fka Shoppes at Midway)\OPERATIONS\Brokerage & Leasing Agreements'
$KMW = 'V:\Knightdale Marketplace 7-15-19\KM-West (fka Midtown Commons)\OPERATIONS\Brokerage & Leasing Agreements'
$GW  = 'V:\Gateway (Formerly Port Chester) 2-8-19\OPERATIONS\Brokerage & Leasing Agreements'
$MAGB = 'V:\Magnolia Park 11-20-14\OPERATIONS\Brokerage & Leasing Agreements'
$MAGC = 'V:\Magnolia Park 11-20-14\OPERATIONS\Commission Agreements'
$PID_GW  = 'd5a4ed03-0b60-4168-9208-83822dd24884'
$PID_KME = '00000000-0000-0000-0000-000000000010'
$PID_KMW = '00000000-0000-0000-0000-000000000011'
$PID_MAG = 'd4f08824-2d88-472d-b7aa-a703310c2aaf'

# Every file in the folders, tagged with the property whose folder it sits in.
# (KM East/West hold byte-identical copies of the shared CBRE / Providence docs;
# each property gets its own row.)
$FILES = @()
foreach ($d in @(@{ p = $PID_KME; dir = $KME }, @{ p = $PID_KMW; dir = $KMW }, @{ p = $PID_GW; dir = $GW }, @{ p = $PID_MAG; dir = $MAGB }, @{ p = $PID_MAG; dir = $MAGC })) {
  foreach ($f in (Get-ChildItem -LiteralPath $d.dir -Recurse -File -Filter *.pdf)) {
    $FILES += @{ p = $d.p; f = $f.FullName }
  }
}

$tool = @{
  name = 'submit_extraction'
  description = 'Submit the structured abstraction of a brokerage / leasing-commission document.'
  input_schema = @{
    type = 'object'
    properties = @{
      broker = @{ type = 'string'; description = 'the brokerage firm this document engages or concerns, as commonly known (e.g. CBRE, CBRE Raleigh, JLL, Ripco Real Estate, The Shopping Center Group (TSCG), Providence Group, Collett & Associates)' }
      agreement_type = @{ type = 'string'; enum = @('exclusive_leasing','cooperating_broker','commission','amendment','extension','termination','indemnity','declaration','letter','other'); description = 'exclusive_leasing = exclusive leasing/listing agreement; cooperating_broker = co-broker agreement for an outside broker; commission = tenant-specific commission agreement; amendment/extension = modifies or extends a prior agreement; termination = terminates one; indemnity = indemnity agreement; declaration = licensing/affiliation declaration; letter = side letter or notice' }
      tenant = @{ type = @('string', 'null'); description = 'tenant this document concerns, if tenant-specific (e.g. Michaels, Skechers, Kirklands); null for property-wide engagements' }
      description = @{ type = 'string'; description = 'one sentence: what this document does, max 220 chars' }
      agreement_date = @{ type = @('string', 'null'); description = 'execution/effective date yyyy-mm-dd' }
      start_date = @{ type = @('string', 'null') }
      end_date = @{ type = @('string', 'null'); description = 'term expiration yyyy-mm-dd, ONLY if stated or exactly derivable; for amendments/extensions the NEW expiration they establish' }
      term_summary = @{ type = @('string', 'null'); description = 'term in words, incl. renewal/holdover mechanics, max 200 chars' }
      commission_summary = @{ type = @('string', 'null'); description = 'commission structure in words: rates or $/SF for new leases vs renewals/extensions, co-broker splits, payment timing, max 300 chars' }
      auto_renews = @{ type = @('boolean', 'null') }
      cancel_notice_days = @{ type = @('integer', 'null'); description = 'days notice either party needs to terminate for convenience, if any' }
      amends = @{ type = @('string', 'null'); description = 'for amendments/extensions/terminations: which agreement it modifies (broker + original date if stated)' }
      notes = @{ type = @('string', 'null'); description = 'what an asset manager should know: protected-prospect tail periods, termination rights, owner entity, unusual provisions, max 400 chars' }
    }
    required = @('broker', 'agreement_type', 'description')
  }
}

if (-not $Load) {
  $done = @{}
  if (Test-Path -LiteralPath $OUT) {
    foreach ($line in [IO.File]::ReadAllLines($OUT, $utf8)) {
      if ($line) { $done[(($line | ConvertFrom-Json).file_path)] = $true }
    }
  }
  $n = 0; $ok = 0; $fail = 0
  foreach ($item in $FILES) {
    $n++
    $path = $item.f
    if ($done.ContainsKey($path)) { continue }
    $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($path))
    $prompt = @"
You are abstracting a brokerage / leasing-commission document for a commercial retail
property asset-management team. Today is $TODAY. The attached PDF was filed in the
property's 'Brokerage & Leasing Agreements' records. Read it and extract the terms.
Rules: dates yyyy-mm-dd; end_date only when stated or exactly derivable; if the
engagement continues month-to-month or until terminated after the initial term, note
that in term_summary and set auto_renews. commission_summary should capture the actual
economics (percentage of rent by lease-year bands, or dollars per square foot, new vs
renewal, and the co-broker split if one applies). For amendments, extensions and
terminations, say in `amends` which agreement they modify and put the NEW expiration
(if any) in end_date. Call submit_extraction with your result.
"@
    $req = @{
      model = 'claude-sonnet-5'
      max_tokens = 1200
      tools = @($tool)
      tool_choice = @{ type = 'tool'; name = 'submit_extraction' }
      messages = @(@{ role = 'user'; content = @(
        @{ type = 'document'; source = @{ type = 'base64'; media_type = 'application/pdf'; data = $b64 } },
        @{ type = 'text'; text = $prompt }) })
    } | ConvertTo-Json -Depth 14
    $x = $null
    for ($try = 1; $try -le 3; $try++) {
      try {
        # Use Invoke-WebRequest + explicit UTF-8 decode of the raw bytes.
        # Invoke-RestMethod decodes the response body as ISO-8859-1 in PS 5.1,
        # which turns any non-ASCII the model emits (en-dashes, arrows, curly
        # quotes) into mojibake before we ever see it.
        $wr = Invoke-WebRequest -Method Post -Uri 'https://api.anthropic.com/v1/messages' -Headers @{ 'x-api-key' = $AK; 'anthropic-version' = '2023-06-01' } -ContentType 'application/json' -Body ($utf8.GetBytes($req)) -TimeoutSec 400 -UseBasicParsing
        $r = ($utf8.GetString($wr.RawContentStream.ToArray())) | ConvertFrom-Json
        $tu = $r.content | Where-Object { $_.type -eq 'tool_use' } | Select-Object -First 1
        $x = $tu.input
        break
      } catch {
        $e = if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
        if ($try -lt 3 -and ($e -match '429|529|overloaded')) { Start-Sleep -Seconds (20 * $try); continue }
        Write-Output ("FAIL {0} :: {1}" -f (Split-Path $path -Leaf), $e.Substring(0, [Math]::Min(200, $e.Length)))
        $fail++
        break
      }
    }
    if ($null -eq $x) { continue }
    $rec = [ordered]@{
      property_id = $item.p
      title       = (Split-Path $path -Leaf)
      file_path   = $path
      extraction  = $x
    }
    [IO.File]::AppendAllText($OUT, (($rec | ConvertTo-Json -Depth 10 -Compress) + "`n"), $utf8)
    $ok++
    Write-Output ("OK {0}/{1} {2} -> {3} [{4}] end={5}" -f $n, $FILES.Count, (Split-Path $path -Leaf), $x.broker, $x.agreement_type, $x.end_date)
  }
  Write-Output ("DONE extract  ok {0}  failed {1}" -f $ok, $fail)
  exit 0
}

# ---------------- -Load: JSONL -> brokerage_agreements ----------------
$rows = @()
foreach ($line in [IO.File]::ReadAllLines($OUT, $utf8)) {
  if (-not $line) { continue }
  $rec = $line | ConvertFrom-Json
  $x = $rec.extraction
  $srcKey = $rec.file_path.ToLower()

  # link the corpus copy when one exists (documents.file_path is the UNC form)
  $docId = $null
  try {
    $leaf = Split-Path $rec.file_path -Leaf
    $pat = [uri]::EscapeDataString('*' + ($leaf -replace '\.pdf$', '' -replace '[(),%_]', '*') + '*')
    $d = Invoke-RestMethod -Uri "$BASE/rest/v1/documents?select=id,file_path&file_path=ilike.$pat&limit=5" -Headers $H -UserAgent $UA -TimeoutSec 60
    foreach ($cand in @($d)) {
      $norm = ($cand.file_path -replace '^file:\\\\192\.168\.220\.121\\virtual_file_room\\', 'V:\').ToLower()
      if ($norm -eq $srcKey) { $docId = $cand.id; break }
    }
    if (-not $docId -and @($d).Count -eq 1) { $docId = @($d)[0].id }
  } catch {}

  $endDate = $x.end_date
  $status = 'unknown'
  if ($x.agreement_type -eq 'termination') { $status = 'terminated' }
  elseif ($endDate) { if ($endDate -lt $TODAY) { $status = 'expired' } else { $status = 'active' } }
  elseif ($x.auto_renews) { $status = 'active' }

  $rows += [ordered]@{
    property_id        = $rec.property_id
    document_id        = $docId
    source_key         = $srcKey
    file_path          = $rec.file_path
    broker             = $x.broker
    agreement_type     = $x.agreement_type
    tenant             = $x.tenant
    description        = $x.description
    agreement_date     = $x.agreement_date
    start_date         = $x.start_date
    end_date           = $endDate
    term_summary       = $x.term_summary
    commission_summary = $x.commission_summary
    auto_renews        = $x.auto_renews
    cancel_notice_days = $x.cancel_notice_days
    amends             = $x.amends
    status             = $status
    notes              = $x.notes
    source             = 'ai'
  }
}
Write-Output ("rows to upsert: {0}" -f $rows.Count)

$inserted = 0
for ($i = 0; $i -lt $rows.Count; $i += 50) {
  $hi = [Math]::Min($i + 49, $rows.Count - 1)
  $batch = @($rows[$i..$hi])
  $payload = ConvertTo-Json $batch -Depth 6
  if ($batch.Count -eq 1) { $payload = "[$payload]" }
  $tmpf = "$env:TEMP\brk_agr_batch.json"
  [IO.File]::WriteAllText($tmpf, $payload, $utf8)
  $resp = Invoke-RestMethod -Method Post -Uri "$BASE/rest/v1/brokerage_agreements?on_conflict=source_key" -Headers ($H + @{ Prefer = 'resolution=merge-duplicates,return=representation' }) -UserAgent $UA -ContentType 'application/json' -InFile $tmpf -TimeoutSec 120
  $inserted += @($resp).Count
}
Write-Output ("upserted: {0}" -f $inserted)

# ---- manual status overrides: currently-engaged leasing brokers ----
# (user-confirmed 2026-07-05). The latest filed documents for these engagements
# have lapsed on paper, but ownership confirms the brokers are the CURRENT
# leasing agents (continuing on holdover). Mark them active so /brokerage shows
# them correctly. Re-PATCHed on every -Load so the override survives re-extraction.
function Set-BrokerActive([string]$query, [string]$label, [string]$body = '{"status":"active"}') {
  $r = Invoke-RestMethod -Method Patch -Uri "$BASE/rest/v1/brokerage_agreements?$query" -Headers ($H + @{ Prefer = 'return=representation' }) -UserAgent $UA -ContentType 'application/json' -Body $body -TimeoutSec 60
  Write-Output ("  active override [{0}]: {1} row(s)" -f $label, @($r).Count)
}
$qRipco = [uri]::EscapeDataString('*RIPCO*')
Set-BrokerActive "broker=ilike.$qRipco" 'RIPCO / Gateway'
$qProv = [uri]::EscapeDataString('*Providence*')
Set-BrokerActive "broker=ilike.$qProv&agreement_type=eq.cooperating_broker" 'Providence Group / Knightdale'
$qTscg = [uri]::EscapeDataString('*Shopping Center*')
Set-BrokerActive "broker=ilike.$qTscg&property_id=eq.$PID_MAG&agreement_type=eq.exclusive_leasing" 'TSCG / Magnolia'
# JLL (Gateway office/medical-dental leasing) now continues month-to-month past
# its 3/31/2024 term — auto_renews=true drives the "month-to-month" card label.
$qJll = [uri]::EscapeDataString('*JLL*')
Set-BrokerActive "broker=ilike.$qJll" 'JLL / Gateway (month-to-month)' '{"status":"active","auto_renews":true}'

$sum = Invoke-RestMethod -Uri "$BASE/rest/v1/brokerage_agreements?select=status,agreement_type&limit=500" -Headers $H -UserAgent $UA -TimeoutSec 60
$sum | Group-Object status | ForEach-Object { Write-Output ("  status {0}: {1}" -f $_.Name, $_.Count) }
$sum | Group-Object agreement_type | ForEach-Object { Write-Output ("  type {0}: {1}" -f $_.Name, $_.Count) }
Write-Output 'DONE load'
