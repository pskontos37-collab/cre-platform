# extract_landlord_reminder_provisions.ps1 - detects leases whose OPTION provisions
# oblige the LANDLORD to remind the tenant that an exercise window is opening before
# the tenant's silence can count as a waiver ("landlord notice-back" / obligation to
# notify). Populates lease_options.requires_landlord_reminder so the Critical Dates
# widget badges "Prepare tenant notice" on those option-notice deadlines.
#
# This is the AI-extraction complement to the per-type status dropdowns (migration
# 20240086). The reminder flag lives on lease_options (durable source of record);
# sync_lease_critical_dates() mirrors it onto the option_notice_deadline rows.
#
# How it works:
#   1. Pull active leases that hold an un-exercised renewal/extension option.
#   2. Resolve the lease document set (lease_abstracts.source_doc_ids, else documents
#      linked by tenant/property) and pull its verbatim text layer (document_chunks
#      kind='text'), capped so token spend stays bounded.
#   3. Ask Claude whether the lease requires the LANDLORD to give the tenant advance
#      notice before the option window, quoting the provision. One JSONL line per lease.
#   4. -Load applies high-confidence positives to lease_options, then runs
#      sync_lease_critical_dates() so the widget picks up the badge.
#
# Modes:
#   (default)          REPORT: build/refresh landlord_reminder_provisions.jsonl
#                      (resumable; leases already assessed are skipped) + print a table.
#   -Load              apply high-confidence requires_reminder=true rows.
#   -Limit <n>         cap leases processed this run (0 = all).
#   -MaxChars <n>      per-lease text budget sent to Claude (default 45000).
#
# Run cadence: after major lease-abstract refreshes or a new-lease load. REVIEW the
# JSONL before -Load - a false positive tells a manager to send a notice they don't owe.
param([switch]$Load, [int]$Limit = 0, [int]$MaxChars = 45000)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']; $AK = $cfg['ANTHROPIC_API_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$HW = @{ apikey = $KEY; Authorization = "Bearer $KEY"; Prefer = 'return=representation'; 'Content-Type' = 'application/json' }
$OUT = "$PSScriptRoot\landlord_reminder_provisions.jsonl"
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Nz($v) { if ($v -is [string] -and $v.Trim() -ne '') { return $v.Trim() } return $null }

# ---------------- REPORT mode ----------------
if (-not $Load) {
  # Active leases with an un-exercised renewal/extension option. Embed the lease,
  # tenant and property so we can resolve docs and label output.
  $sel = 'id,option_type,is_exercised,notice_days_required,requires_landlord_reminder,lease:leases!inner(id,property_id,status,expiration_date,tenant_id,tenant:tenants(name,trade_name))'
  $q = [uri]::EscapeDataString($sel)
  # option_type enum = {renewal,expansion,contraction,termination,rofo,rofr};
  # "extension" options are modeled as renewal. Reminder-notice provisions are a
  # renewal-option concept, so we scan renewals.
  $opts = Invoke-RestMethod -Uri "$BASE/rest/v1/lease_options?select=$q&option_type=eq.renewal&is_exercised=eq.false&lease.status=eq.active&limit=1000" -Headers $H -UserAgent $UA -TimeoutSec 120
  # one entry per LEASE (a lease can carry several options - the provision is lease-level)
  $byLease = @{}
  foreach ($o in $opts) { if ($o.lease -and -not $byLease.ContainsKey($o.lease.id)) { $byLease[$o.lease.id] = $o } }
  $leases = @($byLease.Values)
  Write-Output ("active leases with un-exercised options: {0}" -f $leases.Count)

  $props = Invoke-RestMethod -Uri "$BASE/rest/v1/properties?select=id,name&limit=200" -Headers $H -UserAgent $UA -TimeoutSec 60
  $pname = @{}; foreach ($p in $props) { $pname[$p.id] = $p.name }

  $done = @{}
  if (Test-Path -LiteralPath $OUT) {
    foreach ($line in [IO.File]::ReadAllLines($OUT, $utf8)) {
      if ($line) { $done[(($line | ConvertFrom-Json).lease_id)] = $true }
    }
  }
  $todo = @($leases | Where-Object { -not $done.ContainsKey($_.lease.id) })
  if ($Limit -gt 0) { $todo = @($todo | Select-Object -First $Limit) }
  Write-Output ("already assessed: {0}   to do: {1}" -f $done.Count, $todo.Count)

  $tool = @{
    name = 'submit_reminder_verdict'
    description = 'Report whether this lease obliges the LANDLORD to notify/remind the tenant before an option-exercise window.'
    input_schema = @{
      type = 'object'
      properties = @{
        requires_reminder = @{ type = 'boolean'; description = 'true ONLY if the lease requires the LANDLORD to give the tenant advance/reminder notice before the option-exercise deadline (a landlord notice-back / obligation-to-notify provision), such that the tenant''s failure to exercise is excused until the landlord gives that notice. A plain tenant-must-give-N-days-notice term is NOT this - that is the tenant''s duty, not the landlord''s.' }
        provision_quote = @{ type = @('string', 'null'); description = 'short verbatim quote of the landlord-notice provision, if present' }
        landlord_notice_window = @{ type = @('string', 'null'); description = 'when/how far ahead the landlord must notify, if stated (e.g. "30-60 days before the exercise deadline")' }
        tenant_notice_days = @{ type = @('string', 'null'); description = 'tenant''s own required exercise-notice window, if stated' }
        section = @{ type = @('string', 'null'); description = 'lease section reference for the provision, if cited' }
        confidence = @{ type = 'string'; enum = @('high', 'medium', 'low'); description = 'high only if the provision text is explicit in the supplied lease text' }
        note = @{ type = @('string', 'null') }
      }
      required = @('requires_reminder', 'confidence')
    }
  }

  $n = 0; $flagged = 0
  foreach ($e in $todo) {
    $n++
    $lease = $e.lease
    $tname = $null; if ($lease.tenant) { $tname = Nz($lease.tenant.trade_name); if (-not $tname) { $tname = Nz($lease.tenant.name) } }
    $prop = $pname[$lease.property_id]; if (-not $prop) { $prop = 'unknown' }

    # Resolve the lease document set: prefer the abstractor's source docs, else
    # documents linked to this tenant, else documents on the property with lease-ish names.
    $docIds = @()
    if ($tname) {
      $tq = [uri]::EscapeDataString('*' + (($tname -split ',')[0].Trim() -replace ' ', '*') + '*')
      $abs = Invoke-RestMethod -Uri "$BASE/rest/v1/lease_abstracts?select=source_doc_ids&property_id=eq.$($lease.property_id)&tenant_name=ilike.$tq&limit=1" -Headers $H -UserAgent $UA -TimeoutSec 60
      if (@($abs).Count -ge 1 -and $abs[0].source_doc_ids) { $docIds = @($abs[0].source_doc_ids) }
    }
    if (-not $docIds.Count -and $lease.tenant_id) {
      $ds = Invoke-RestMethod -Uri "$BASE/rest/v1/documents?select=id,file_name,file_mtime&tenant_id=eq.$($lease.tenant_id)&property_id=eq.$($lease.property_id)&order=file_mtime.asc&limit=8" -Headers $H -UserAgent $UA -TimeoutSec 60
      $docIds = @($ds | ForEach-Object { $_.id })
    }

    # Pull verbatim text layer for the resolved docs (kind=text), oldest chunks first,
    # capped at MaxChars so token spend stays bounded.
    $text = ''
    foreach ($did in $docIds) {
      if ($text.Length -ge $MaxChars) { break }
      $chunks = Invoke-RestMethod -Uri "$BASE/rest/v1/document_chunks?select=content,chunk_index&document_id=eq.$did&kind=eq.text&order=chunk_index.asc&limit=200" -Headers $H -UserAgent $UA -TimeoutSec 90
      foreach ($c in $chunks) {
        if ($text.Length -ge $MaxChars) { break }
        if ($c.content) { $text += ($c.content + "`n") }
      }
    }
    if ($text.Length -gt $MaxChars) { $text = $text.Substring(0, $MaxChars) }

    $v = $null; $reason = $null
    if (-not $text.Trim()) {
      $reason = 'no text layer - OCR/manual review needed'
      $v = [ordered]@{ requires_reminder = $false; confidence = 'low'; note = $reason }
    }
    else {
      $sys = 'You are a commercial real estate lease analyst working for the LANDLORD. Read the supplied lease text and determine whether it obliges the LANDLORD to notify/remind the tenant before an option-exercise deadline. Quote provisions verbatim. Answer only from the supplied text.'
      $usr = "Property: $prop`nTenant: $tname`nOption type present: $($e.option_type)`n`n--- LEASE TEXT ---`n$text"
      $payload = @{ model = 'claude-sonnet-5'; max_tokens = 900; system = $sys
                    tools = @($tool); tool_choice = @{ type = 'tool'; name = 'submit_reminder_verdict' }
                    messages = @(@{ role = 'user'; content = $usr }) } | ConvertTo-Json -Depth 12
      $tmp = "$env:TEMP\lrp_body.json"; [IO.File]::WriteAllText($tmp, $payload, $utf8)
      $resp = $null
      foreach ($try in 1..3) {
        try {
          $resp = Invoke-RestMethod -Uri 'https://api.anthropic.com/v1/messages' -Method Post -Headers @{ 'x-api-key' = $AK; 'anthropic-version' = '2023-06-01'; 'content-type' = 'application/json' } -InFile $tmp -TimeoutSec 240
          break
        } catch { if ($try -eq 3) { throw } Start-Sleep -Seconds (5 * $try) }
      }
      $v = ($resp.content | Where-Object { $_.type -eq 'tool_use' } | Select-Object -First 1).input
    }

    $rec = [ordered]@{
      lease_id = $lease.id; property = $prop; tenant = $tname
      option_type = $e.option_type; expiration = $lease.expiration_date
      doc_ids = $docIds; text_chars = $text.Length
      already_flagged = [bool]$e.requires_landlord_reminder
      verdict = $v; applied = $false
    }
    [IO.File]::AppendAllText($OUT, (($rec | ConvertTo-Json -Depth 10 -Compress) + "`n"), $utf8)
    if ($v.requires_reminder) { $flagged++; Write-Output ("REMINDER [{0}] {1} @ {2}: {3}" -f $v.confidence, $tname, $prop, (Nz($v.landlord_notice_window))) }
    if ($n % 10 -eq 0) { Write-Output ("...{0}/{1}" -f $n, $todo.Count) }
  }
  Write-Output ("done. assessed {0} leases, {1} with a landlord-reminder provision -> {2}" -f $n, $flagged, $OUT)
  Write-Output 'Review the JSONL, then run with -Load to apply high-confidence positives.'
  exit 0
}

# ---------------- LOAD mode ----------------
if (-not (Test-Path -LiteralPath $OUT)) { throw "no $OUT - run report mode first" }
$lines = [IO.File]::ReadAllLines($OUT, $utf8) | Where-Object { $_ }
$rows = @(); foreach ($ln in $lines) { $rows += ($ln | ConvertFrom-Json) }
$fix = @($rows | Where-Object { $_.verdict.requires_reminder -and $_.verdict.confidence -eq 'high' -and (-not $_.applied) -and $_.lease_id })
Write-Output ("applying {0} high-confidence landlord-reminder flags" -f $fix.Count)

foreach ($f in $fix) {
  $note = (Nz($f.verdict.provision_quote))
  $win = (Nz($f.verdict.landlord_notice_window)); if ($win) { $note = ('[' + $win + '] ' + $note) }
  Write-Output ("  {0} @ {1}: {2}" -f $f.tenant, $f.property, $win)
  # flag every un-exercised renewal/extension option on the lease
  $b = @{ requires_landlord_reminder = $true; landlord_reminder_note = $note } | ConvertTo-Json -Compress
  Invoke-RestMethod -Uri "$BASE/rest/v1/lease_options?lease_id=eq.$($f.lease_id)&option_type=eq.renewal&is_exercised=eq.false" -Method Patch -Headers $HW -UserAgent $UA -Body $b -TimeoutSec 60 | Out-Null
  $f.applied = $true
}

# propagate flags onto the option_notice_deadline critical_dates rows
if ($fix.Count -gt 0) {
  Write-Output 'refreshing critical_dates (sync_lease_critical_dates)...'
  Invoke-RestMethod -Uri "$BASE/rest/v1/rpc/sync_lease_critical_dates" -Method Post -Headers $HW -UserAgent $UA -Body '{}' -TimeoutSec 120 | Out-Null
}

# rewrite JSONL with applied flags so -Load is idempotent
$sb = New-Object System.Text.StringBuilder
foreach ($r in $rows) { [void]$sb.AppendLine(($r | ConvertTo-Json -Depth 10 -Compress)) }
[IO.File]::WriteAllText($OUT, $sb.ToString(), $utf8)

$review = @($rows | Where-Object { $_.verdict.requires_reminder -and $_.verdict.confidence -ne 'high' -and (-not $_.applied) })
Write-Output ("done. NOT auto-applied (needs human review): {0}" -f $review.Count)
foreach ($s in $review) { Write-Output ("  [{0}] {1} @ {2}" -f $s.verdict.confidence, $s.tenant, $s.property) }
