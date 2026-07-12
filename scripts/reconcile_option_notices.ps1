# reconcile_option_notices.ps1 - cross-checks option-exercise / extension / non-renewal
# notice DOCUMENTS in the corpus against the STRUCTURED lease data (leases.expiration_date,
# lease_options.is_exercised, critical_dates). Born from the 2026-07-11 Ross miss: the
# exercise notice was ingested but nothing propagated it, so the platform kept warning
# about a notice deadline the tenant had already satisfied.
#
# How it works (spec: docs/COTENANCY-RISK-RADAR-SPEC.md section 4.5):
#   1. Pull candidate notice docs (file_name / AI-title patterns, newer than -SinceMonths).
#   2. Resolve the tenant from the \TENANTS\<folder>\ path segment + tenants table.
#   3. Ask Claude to read the doc's AI summary title and emit a verdict:
#      {action: exercised|non_renewal|landlord_notice|other, new_end_date, confidence}.
#   4. Compare vs the active lease + renewal option; write one JSONL line per doc with
#      discrepancy=true|false. REVIEW THE JSONL before loading.
#   5. -Load applies ONLY reviewed lines where discrepancy=true and action=exercised and
#      confidence=high: updates leases.expiration_date, marks the renewal option exercised
#      (house note convention), completes satisfied option_notice_deadline critical dates,
#      rolls lease_expiration critical dates, links documents.tenant_id.
#      non_renewal rows are NEVER auto-applied - they are reported for a human decision.
#
# Modes:
#   (default)          REPORT: build/refresh option_notice_reconciliation.jsonl (resumable;
#                      docs already in the JSONL are skipped) and print a discrepancy table.
#   -Load              apply high-confidence exercised discrepancies from the JSONL.
#   -SinceMonths <n>   candidate window, default 24.
#   -Limit <n>         cap docs processed this run (0 = all).
#
# Run cadence: after every storage sync / ingest and after every MRI RR load.
param([switch]$Load, [int]$SinceMonths = 24, [int]$Limit = 0)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']; $AK = $cfg['ANTHROPIC_API_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$HW = @{ apikey = $KEY; Authorization = "Bearer $KEY"; Prefer = 'return=representation'; 'Content-Type' = 'application/json' }
$OUT = "$PSScriptRoot\option_notice_reconciliation.jsonl"
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Nz($v) { if ($v -is [string] -and $v.Trim() -ne '') { return $v.Trim() } return $null }

# ---------------- REPORT mode ----------------
if (-not $Load) {
  $cutoff = (Get-Date).AddMonths(-$SinceMonths).ToString('yyyy-MM-dd')

  # Candidate notice docs. PostgREST or= with ilike; patterns kept broad, Claude sorts them out.
  $pats = @('*LSE Ext*', '*LSE Renewal*', '*Renewal Option*', '*Exercise*Option*', '*Extension Option*',
            '*Non-Renewal*', '*LSE Extension*', '*Extend LSE*', '*Notice of Renewal*', '*Termination*NTC*', '*NTC*Termination*',
            'AMD-*', 'MEMO-LSE*', 'LSE-*')  # amendments + new leases also move terms (KM East 7/2026 lesson)
  $ors = @()
  foreach ($p in $pats) { $ors += ('file_name.ilike.' + ($p -replace '\(', '' -replace '\)', '' -replace ',', '')) }
  $orQ = [uri]::EscapeDataString('(' + ($ors -join ',') + ')')
  $docs = Invoke-RestMethod -Uri "$BASE/rest/v1/documents?select=id,file_name,file_path,title,file_mtime,property_id,tenant_id&or=$orQ&file_mtime=gte.$cutoff&order=file_mtime.desc&limit=500" -Headers $H -UserAgent $UA -TimeoutSec 120
  Write-Output ("candidate notice docs since {0}: {1}" -f $cutoff, @($docs).Count)

  $props = Invoke-RestMethod -Uri "$BASE/rest/v1/properties?select=id,name&limit=200" -Headers $H -UserAgent $UA -TimeoutSec 60
  $pname = @{}; foreach ($p in $props) { $pname[$p.id] = $p.name }

  $done = @{}
  if (Test-Path -LiteralPath $OUT) {
    foreach ($line in [IO.File]::ReadAllLines($OUT, $utf8)) {
      if ($line) { $done[(($line | ConvertFrom-Json).doc_id)] = $true }
    }
  }
  $todo = @($docs | Where-Object { -not $done.ContainsKey($_.id) })
  if ($Limit -gt 0) { $todo = @($todo | Select-Object -First $Limit) }
  Write-Output ("already assessed: {0}   to do: {1}" -f $done.Count, $todo.Count)

  $tool = @{
    name = 'submit_verdict'
    description = 'Classify this lease-related notice document from its summary.'
    input_schema = @{
      type = 'object'
      properties = @{
        action = @{ type = 'string'; enum = @('exercised', 'amended_extension', 'new_lease', 'non_renewal', 'early_termination', 'landlord_notice', 'other')
                    description = 'exercised = TENANT exercised a renewal/extension option. amended_extension = a lease AMENDMENT extends/changes the term. new_lease = a brand-new lease or memorandum of lease for a tenant. non_renewal = tenant declining to renew / closing at term end. early_termination = tenant terminating BEFORE natural expiration (kickout, termination right). landlord_notice = notice FROM landlord. other = not a term-changing event (original lease from years past, correspondence, etc).' }
        tenant_name = @{ type = @('string', 'null'); description = 'tenant legal/trade name as stated in the summary' }
        new_end_date = @{ type = @('string', 'null'); description = 'YYYY-MM-DD new lease term end resulting from this notice, if stated' }
        effective_date = @{ type = @('string', 'null'); description = 'YYYY-MM-DD termination/vacate effective date for non_renewal or early_termination, if stated' }
        confidence = @{ type = 'string'; enum = @('high', 'medium', 'low'); description = 'high only if the action AND dates are explicit in the summary' }
        note = @{ type = @('string', 'null') }
      }
      required = @('action', 'confidence')
    }
  }

  $n = 0; $disc = 0
  foreach ($d in $todo) {
    $n++
    $folder = $null
    if ($d.file_path -match 'TENANTS\\([^\\]+)\\') { $folder = $Matches[1] }
    $prop = $pname[$d.property_id]; if (-not $prop) { $prop = 'unknown' }

    # Claude verdict from the AI summary title (titles are ingest-time AI summaries and
    # nearly always carry the action + dates; PDF re-read is a manual follow-up for low confidence)
    $sys = 'You classify commercial lease notice documents for a landlord. Use ONLY the given summary. Dates must be YYYY-MM-DD.'
    $usr = "Property: $prop`nTenant folder: $folder`nFile: $($d.file_name)`nSummary: $($d.title)"
    $payload = @{ model = 'claude-fable-5'; max_tokens = 700; system = $sys
                  tools = @($tool); tool_choice = @{ type = 'tool'; name = 'submit_verdict' }
                  messages = @(@{ role = 'user'; content = $usr }) } | ConvertTo-Json -Depth 12
    $tmp = "$env:TEMP\recon_body.json"; [IO.File]::WriteAllText($tmp, $payload, $utf8)
    $resp = $null
    foreach ($try in 1..3) {
      try {
        $resp = Invoke-RestMethod -Uri 'https://api.anthropic.com/v1/messages' -Method Post -Headers @{ 'x-api-key' = $AK; 'anthropic-version' = '2023-06-01'; 'content-type' = 'application/json' } -InFile $tmp -TimeoutSec 180
        break
      } catch { if ($try -eq 3) { throw } Start-Sleep -Seconds (5 * $try) }
    }
    $v = ($resp.content | Where-Object { $_.type -eq 'tool_use' } | Select-Object -First 1).input

    # Resolve tenant -> active lease -> renewal option
    $tenant = $null
    $names = @()
    if ($folder) { $names += ($folder -split ' \(')[0] }
    if ($v.tenant_name) { $names += $v.tenant_name }
    foreach ($nm in $names) {
      if ($tenant) { break }
      # portion before any comma, whitespace collapsed - comma-bearing legal names
      # ("Ross Dress For Less, Inc.") otherwise produce a dead double-space wildcard
      $probe = (((($nm -split ',')[0]) -replace '[(),%_]', ' ') -replace '\s+', ' ').Trim()
      if (-not $probe) { continue }
      # wildcard between tokens: stored names have inconsistent whitespace
      $q = [uri]::EscapeDataString('*' + ($probe -replace ' ', '*') + '*')
      $hits = Invoke-RestMethod -Uri "$BASE/rest/v1/tenants?select=id,name&or=(name.ilike.$q,trade_name.ilike.$q)&limit=5" -Headers $H -UserAgent $UA -TimeoutSec 60
      if (@($hits).Count -ge 1) { $tenant = @($hits)[0] }
    }
    $lease = $null; $opt = $null
    if ($tenant) {
      $lq = "$BASE/rest/v1/leases?select=id,expiration_date,status&tenant_id=eq.$($tenant.id)&status=eq.active"
      if ($d.property_id) { $lq += "&property_id=eq.$($d.property_id)" }
      $ls = Invoke-RestMethod -Uri $lq -Headers $H -UserAgent $UA -TimeoutSec 60
      if (@($ls).Count -ge 1) { $lease = @($ls)[0] }
      if ($lease) {
        $os = Invoke-RestMethod -Uri "$BASE/rest/v1/lease_options?select=id,is_exercised,notice_deadline,notes&lease_id=eq.$($lease.id)&option_type=eq.renewal" -Headers $H -UserAgent $UA -TimeoutSec 60
        if (@($os).Count -ge 1) { $opt = @($os)[0] }
      }
    }

    # Discrepancy logic
    $discrepancy = $false; $reason = $null
    if ($v.action -in @('exercised', 'amended_extension') -and $lease) {
      if ($v.new_end_date -and ("" + $lease.expiration_date) -lt $v.new_end_date) { $discrepancy = $true; $reason = 'expiration behind notice' }
      elseif ($v.action -eq 'exercised' -and $opt -and (-not $opt.is_exercised) -and (-not $v.new_end_date)) { $discrepancy = $true; $reason = 'option not marked exercised' }
    }
    if ($v.action -eq 'new_lease' -and -not $lease) {
      $discrepancy = $true; $reason = 'NEW LEASE in corpus with no rent-roll row - create tenant/lease manually'
    }
    if (($v.action -eq 'non_renewal' -or $v.action -eq 'early_termination') -and $lease) {
      $discrepancy = $true; $reason = 'tenant leaving - human review (lease still active)'
    }
    if ($v.action -in @('exercised', 'amended_extension', 'non_renewal', 'early_termination') -and -not $lease) {
      $reason = 'no active lease matched - verify manually'
    }

    $rec = [ordered]@{
      doc_id = $d.id; file_name = $d.file_name; property = $prop; file_mtime = $d.file_mtime
      tenant_folder = $folder; matched_tenant_id = $(if ($tenant) { $tenant.id } else { $null })
      matched_tenant = $(if ($tenant) { $tenant.name } else { $null })
      lease_id = $(if ($lease) { $lease.id } else { $null })
      db_expiration = $(if ($lease) { $lease.expiration_date } else { $null })
      option_id = $(if ($opt) { $opt.id } else { $null })
      db_is_exercised = $(if ($opt) { $opt.is_exercised } else { $null })
      verdict = $v; discrepancy = $discrepancy; reason = $reason; applied = $false
    }
    [IO.File]::AppendAllText($OUT, (($rec | ConvertTo-Json -Depth 10 -Compress) + "`n"), $utf8)
    if ($discrepancy) { $disc++; Write-Output ("DISCREPANCY [{0}] {1} @ {2}: {3}" -f $v.action, $rec.matched_tenant, $prop, $reason) }
    if ($n % 10 -eq 0) { Write-Output ("...{0}/{1}" -f $n, $todo.Count) }
  }
  Write-Output ("done. assessed {0} docs, {1} discrepancies -> {2}" -f $n, $disc, $OUT)
  Write-Output 'Review the JSONL, then run with -Load to apply high-confidence exercised fixes.'
  exit 0
}

# ---------------- LOAD mode ----------------
if (-not (Test-Path -LiteralPath $OUT)) { throw "no $OUT - run report mode first" }
$lines = [IO.File]::ReadAllLines($OUT, $utf8) | Where-Object { $_ }
$rows = @(); foreach ($ln in $lines) { $rows += ($ln | ConvertFrom-Json) }
$fix = @($rows | Where-Object { $_.discrepancy -and (-not $_.applied) -and $_.verdict.action -in @('exercised', 'amended_extension') -and $_.verdict.confidence -eq 'high' -and $_.lease_id -and $_.verdict.new_end_date })
Write-Output ("applying {0} high-confidence exercised fixes" -f $fix.Count)
$today = (Get-Date).ToString('yyyy-MM-dd')

foreach ($f in $fix) {
  $end = $f.verdict.new_end_date
  Write-Output ("  {0} @ {1}: expiration {2} -> {3}" -f $f.matched_tenant, $f.property, $f.db_expiration, $end)

  # 1) lease expiration
  $b = @{ expiration_date = $end; updated_at = (Get-Date -Format o) } | ConvertTo-Json -Compress
  Invoke-RestMethod -Uri "$BASE/rest/v1/leases?id=eq.$($f.lease_id)" -Method Patch -Headers $HW -UserAgent $UA -Body $b -TimeoutSec 60 | Out-Null

  # 2) renewal option -> exercised (house convention). ONLY for option exercises -
  # an amendment extension doesn't consume a renewal option.
  if ($f.option_id -and $f.verdict.action -eq 'exercised') {
    $cur = Invoke-RestMethod -Uri "$BASE/rest/v1/lease_options?select=notes&id=eq.$($f.option_id)" -Headers $H -UserAgent $UA -TimeoutSec 60
    $oldNotes = ''; if (@($cur).Count -ge 1 -and $cur[0].notes) { $oldNotes = $cur[0].notes }
    $newNotes = $oldNotes + (' | EXERCISED - renewed; new term end {0} (notice doc {1}; reconciler {2})' -f $end, $f.file_name, $today)
    $b = @{ is_exercised = $true; notice_deadline = $null; notes = $newNotes } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri "$BASE/rest/v1/lease_options?id=eq.$($f.option_id)" -Method Patch -Headers $HW -UserAgent $UA -Body $b -TimeoutSec 60 | Out-Null
  }

  # 3) critical dates: complete satisfied renewal-notice deadlines; roll expirations
  $b = @{ is_completed = $true } | ConvertTo-Json -Compress
  Invoke-RestMethod -Uri "$BASE/rest/v1/critical_dates?lease_id=eq.$($f.lease_id)&date_type=eq.option_notice_deadline&is_completed=eq.false&description=ilike.*renewal*" -Method Patch -Headers $HW -UserAgent $UA -Body $b -TimeoutSec 60 | Out-Null
  $b = @{ due_date = $end } | ConvertTo-Json -Compress
  Invoke-RestMethod -Uri "$BASE/rest/v1/critical_dates?lease_id=eq.$($f.lease_id)&date_type=eq.lease_expiration" -Method Patch -Headers $HW -UserAgent $UA -Body $b -TimeoutSec 60 | Out-Null

  # 4) link the notice doc to its tenant
  if ($f.matched_tenant_id) {
    $b = @{ tenant_id = $f.matched_tenant_id } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri "$BASE/rest/v1/documents?id=eq.$($f.doc_id)" -Method Patch -Headers $HW -UserAgent $UA -Body $b -TimeoutSec 60 | Out-Null
  }
  $f.applied = $true
}

# rewrite JSONL with applied flags so -Load is idempotent
$sb = New-Object System.Text.StringBuilder
foreach ($r in $rows) { [void]$sb.AppendLine(($r | ConvertTo-Json -Depth 10 -Compress)) }
[IO.File]::WriteAllText($OUT, $sb.ToString(), $utf8)

$skipped = @($rows | Where-Object { $_.discrepancy -and (-not $_.applied) })
Write-Output ("done. NOT auto-applied (need human review): {0}" -f $skipped.Count)
foreach ($s in $skipped) { Write-Output ("  [{0}/{1}] {2} @ {3}: {4}" -f $s.verdict.action, $s.verdict.confidence, $s.matched_tenant, $s.property, $s.reason) }
