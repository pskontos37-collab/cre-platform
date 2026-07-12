# extract_lease_rights.ps1 - structures the CO-TENANCY clauses and TERMINATION RIGHTS
# (sales kickouts, fixed termination windows, ongoing terminate-on-notice rights) that
# today live only as prose inside lease_abstracts, into the queryable tables added by
# migration 20240072 (co_tenancy_clauses v2 + co_tenancy_named_tenants + termination_rights).
# Spec: docs/COTENANCY-RISK-RADAR-SPEC.md.
#
# Grounding: one Claude call per abstract, fed the abstract's co_tenancy and
# termination_kickout JSON (already-distilled clause summaries with exact language).
#
# Modes:
#   (default)  EXTRACT: append one line per abstract to lease_rights.jsonl. Resumable.
#   -Load      LOAD: resolve tenant -> active lease at the property, then upsert.
#              Re-runnable and SAFE: replaces only prior NON-human_verified rows for
#              that lease; human-verified rows are never touched.
#   -Limit <n> cap abstracts processed this run (0 = all).
#
# Requires migration 20240072 for -Load.
param([switch]$Load, [int]$Limit = 0)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']; $AK = $cfg['ANTHROPIC_API_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$HW = @{ apikey = $KEY; Authorization = "Bearer $KEY"; Prefer = 'return=representation'; 'Content-Type' = 'application/json' }
$OUT = "$PSScriptRoot\lease_rights.jsonl"
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Nz($v) { if ($v -is [string] -and $v.Trim() -ne '') { return $v.Trim() } return $null }

# ---------------- EXTRACT mode ----------------
if (-not $Load) {
  $abs = Invoke-RestMethod -Uri "$BASE/rest/v1/lease_abstracts?select=id,property_id,tenant_name,abstract&status=eq.complete&order=tenant_name&limit=300" -Headers $H -UserAgent $UA -TimeoutSec 120
  $cand = @($abs | Where-Object {
    ($_.abstract.co_tenancy -and ($_.abstract.co_tenancy.exists -or $_.abstract.co_tenancy.exact_language_and_remedies)) -or
    ($_.abstract.termination_kickout -and $_.abstract.termination_kickout.exists)
  })
  Write-Output ("abstracts with co-tenancy or termination language: {0} of {1}" -f $cand.Count, @($abs).Count)

  $props = Invoke-RestMethod -Uri "$BASE/rest/v1/properties?select=id,name&limit=200" -Headers $H -UserAgent $UA -TimeoutSec 60
  $pname = @{}; foreach ($p in $props) { $pname[$p.id] = $p.name }

  $done = @{}
  if (Test-Path -LiteralPath $OUT) {
    foreach ($line in [IO.File]::ReadAllLines($OUT, $utf8)) {
      if ($line) { $done[(($line | ConvertFrom-Json).abstract_id)] = $true }
    }
  }
  $todo = @($cand | Where-Object { -not $done.ContainsKey($_.id) })
  if ($Limit -gt 0) { $todo = @($todo | Select-Object -First $Limit) }
  Write-Output ("already extracted: {0}   to do: {1}" -f $done.Count, $todo.Count)

  $tool = @{
    name = 'submit_rights'
    description = 'Submit the structured co-tenancy clause and termination rights for this lease.'
    input_schema = @{
      type = 'object'
      properties = @{
        co_tenancy = @{
          type = @('object', 'null')
          description = 'null if no co-tenancy clause exists'
          properties = @{
            clause_type = @{ type = 'string'; enum = @('anchor_dark', 'occupancy_threshold', 'named_tenant'); description = 'named_tenant if specific anchors are named; occupancy_threshold if only a GLA/occupancy percentage; anchor_dark for generic anchor-closure triggers' }
            named_tenants = @{ type = 'array'; items = @{ type = 'string' }; description = 'anchor names EXACTLY as the clause states them, e.g. ["Target","Whole Foods"]. Empty if none named.' }
            min_named_open = @{ type = @('integer', 'null'); description = 'minimum count of the named list that must be open, e.g. 2 for "at least 2 of". null = ALL named must be open.' }
            occupancy_threshold_pct = @{ type = @('number', 'null'); description = 'occupancy floor as a DECIMAL (0.65 = 65%). null if no percentage test.' }
            occupancy_basis = @{ type = @('string', 'null'); description = 'what the percentage measures, e.g. "total GLA", "ground floor GLA excluding anchors", "200,000 SF of other tenants"' }
            condition_logic = @{ type = 'string'; enum = @('and', 'or'); description = 'how the named-tenant test and occupancy test combine. Use and when only one test exists.' }
            remedy = @{ type = 'string'; enum = @('rent_reduction', 'percentage_rent_only', 'termination_right'); description = 'the PRIMARY/first remedy' }
            remedy_rent_pct = @{ type = @('number', 'null'); description = 'alternate rent as DECIMAL of base rent (0.5 = 50% of base) OR of gross sales when remedy is percentage_rent_only (0.05 = 5% of sales)' }
            cure_period_days = @{ type = @('integer', 'null'); description = 'days the failure must persist before remedies kick in' }
            remedies = @{ type = 'array'; description = 'the FULL remedy ladder in order'; items = @{
              type = 'object'
              properties = @{
                type = @{ type = 'string'; enum = @('alternate_rent', 'go_dark', 'termination', 'other') }
                description = @{ type = 'string' }
                after_days = @{ type = @('integer', 'null'); description = 'days of continuing failure before this remedy is available' }
              }
              required = @('type', 'description')
            } }
            conditions_note = @{ type = @('string', 'null'); description = 'exclusions, replacement-tenant rules, opening vs continuing distinction, other nuances' }
          }
          required = @('clause_type', 'named_tenants', 'condition_logic', 'remedy', 'remedies')
        }
        termination_rights = @{
          type = 'array'
          description = 'every tenant-held EARLY termination right (before natural expiration). Empty array if none.'
          items = @{
            type = 'object'
            properties = @{
              right_type = @{ type = 'string'; enum = @('sales_kickout', 'fixed_window', 'ongoing_notice', 'cotenancy_termination', 'other'); description = 'sales_kickout = terminate if gross sales below a floor; fixed_window = one-time date window; ongoing_notice = may terminate any time on N days notice; cotenancy_termination = termination remedy inside the co-tenancy clause (also list it here)' }
              sales_threshold = @{ type = @('number', 'null'); description = 'gross-sales floor in DOLLARS for the measuring period' }
              measure_period = @{ type = @('string', 'null'); description = 'e.g. "lease year 5", "any trailing 12 months"' }
              recurring = @{ type = @('boolean', 'null'); description = 'true if the sales test REPEATS (any/each lease year, rolling 12 months); false if it is a ONE-TIME test tied to a specific lease year - one-time kickouts lapse once that period passes' }
              window_start = @{ type = @('string', 'null'); description = 'YYYY-MM-DD window opens (fixed_window)' }
              window_end = @{ type = @('string', 'null'); description = 'YYYY-MM-DD window closes (fixed_window)' }
              exercisable_from = @{ type = @('string', 'null'); description = 'YYYY-MM-DD earliest exercise date for ongoing_notice; null if already exercisable' }
              notice_days = @{ type = @('integer', 'null') }
              termination_fee = @{ type = @('string', 'null'); description = 'payment due on termination, e.g. "unamortized TI + commissions" or a dollar amount' }
              details = @{ type = 'string'; description = 'one-sentence plain-language summary' }
            }
            required = @('right_type', 'details')
          }
        }
        verbatim_language = @{ type = @('string', 'null'); description = 'the exact clause language you were given, trimmed' }
      }
      required = @('termination_rights')
    }
  }

  $n = 0; $ok = 0; $fail = 0
  foreach ($ab in $todo) {
    $n++
    $prop = $pname[$ab.property_id]; if (-not $prop) { $prop = 'unknown property' }
    $ct = $null; if ($ab.abstract.co_tenancy) { $ct = $ab.abstract.co_tenancy | ConvertTo-Json -Depth 6 -Compress }
    $tk = $null; if ($ab.abstract.termination_kickout) { $tk = $ab.abstract.termination_kickout | ConvertTo-Json -Depth 6 -Compress }
    $usr = "Property: $prop`nTenant: $($ab.tenant_name)`n`nCO-TENANCY abstract field:`n$ct`n`nTERMINATION/KICKOUT abstract field:`n$tk"
    $sys = 'You structure commercial retail lease clauses for a landlord asset-management system. Use ONLY the given abstract fields. Percentages as decimals (0.65 = 65%). Dollar amounts as plain numbers. If the co-tenancy field shows exists=false or is null, return co_tenancy as null. Include the termination remedy of a co-tenancy clause BOTH in the co-tenancy remedies ladder AND as a cotenancy_termination termination right.'
    $payload = @{ model = 'claude-fable-5'; max_tokens = 2500; system = $sys
                  tools = @($tool); tool_choice = @{ type = 'tool'; name = 'submit_rights' }
                  messages = @(@{ role = 'user'; content = $usr }) } | ConvertTo-Json -Depth 16
    $tmp = "$env:TEMP\rights_body.json"; [IO.File]::WriteAllText($tmp, $payload, $utf8)
    try {
      $resp = $null
      foreach ($try in 1..3) {
        try {
          $resp = Invoke-RestMethod -Uri 'https://api.anthropic.com/v1/messages' -Method Post -Headers @{ 'x-api-key' = $AK; 'anthropic-version' = '2023-06-01'; 'content-type' = 'application/json' } -InFile $tmp -TimeoutSec 240
          break
        } catch { if ($try -eq 3) { throw } Start-Sleep -Seconds (5 * $try) }
      }
      $x = ($resp.content | Where-Object { $_.type -eq 'tool_use' } | Select-Object -First 1).input
      $rec = [ordered]@{ abstract_id = $ab.id; property_id = $ab.property_id; tenant_name = $ab.tenant_name; extraction = $x }
      [IO.File]::AppendAllText($OUT, (($rec | ConvertTo-Json -Depth 14 -Compress) + "`n"), $utf8)
      $ok++
      $ctn = 0; if ($x.co_tenancy) { $ctn = 1 }
      Write-Output ("[{0}/{1}] {2} @ {3}: cotenancy={4} term_rights={5}" -f $n, $todo.Count, $ab.tenant_name, $prop, $ctn, @($x.termination_rights).Count)
    } catch {
      $fail++
      Write-Output ("[{0}/{1}] {2}: FAILED {3}" -f $n, $todo.Count, $ab.tenant_name, $_.Exception.Message)
    }
  }
  Write-Output ("done. ok={0} fail={1} -> {2}" -f $ok, $fail, $OUT)
  Write-Output 'Review the JSONL, then run with -Load (requires migration 20240072).'
  exit 0
}

# ---------------- LOAD mode ----------------
if (-not (Test-Path -LiteralPath $OUT)) { throw "no $OUT - run extract mode first" }
$lines = [IO.File]::ReadAllLines($OUT, $utf8) | Where-Object { $_ }
Write-Output ("loading {0} extraction records" -f @($lines).Count)

$nl = 0; $ct = 0; $tr = 0; $skip = 0
foreach ($ln in $lines) {
  $r = $ln | ConvertFrom-Json
  $x = $r.extraction
  if (-not $x) { $skip++; continue }

  # resolve tenant -> active lease at this property. Take the portion before any comma
  # ("HomeGoods, Inc." -> "HomeGoods") and collapse whitespace, else the comma-stripped
  # double space breaks the ilike wildcard match.
  $probe = ((($r.tenant_name -split ',')[0]) -replace '[(),%_]', ' ') -replace '\s+', ' '
  $probe = $probe.Trim()
  # wildcard between tokens: stored names have inconsistent whitespace ("HOMEGOODS  LLC 507")
  $q = [uri]::EscapeDataString('*' + ($probe -replace ' ', '*') + '*')
  $tenants = Invoke-RestMethod -Uri "$BASE/rest/v1/tenants?select=id,name&or=(name.ilike.$q,trade_name.ilike.$q)&limit=5" -Headers $H -UserAgent $UA -TimeoutSec 60
  $lease = $null
  foreach ($t in @($tenants)) {
    $ls = Invoke-RestMethod -Uri "$BASE/rest/v1/leases?select=id,property_id,commencement_date&tenant_id=eq.$($t.id)&property_id=eq.$($r.property_id)&status=eq.active&limit=1" -Headers $H -UserAgent $UA -TimeoutSec 60
    if (@($ls).Count -ge 1) { $lease = @($ls)[0]; break }
  }
  if (-not $lease) { Write-Output ("  SKIP (no active lease resolved): {0}" -f $r.tenant_name); $skip++; continue }
  $nl++

  # ---- co-tenancy clause ----
  if ($x.co_tenancy) {
    $c = $x.co_tenancy
    # replace prior non-verified clause rows for this lease (cascade removes junction rows)
    Invoke-RestMethod -Uri "$BASE/rest/v1/co_tenancy_clauses?lease_id=eq.$($lease.id)&human_verified=eq.false" -Method Delete -Headers $HW -UserAgent $UA -TimeoutSec 60 | Out-Null
    $body = [ordered]@{
      lease_id = $lease.id
      clause_type = $c.clause_type
      occupancy_threshold_pct = $c.occupancy_threshold_pct
      remedy = $c.remedy
      remedy_rent_pct = $c.remedy_rent_pct
      cure_period_days = $c.cure_period_days
      min_named_open = $c.min_named_open
      occupancy_basis = (Nz $c.occupancy_basis)
      condition_logic = $c.condition_logic
      conditions = $(if ($c.conditions_note) { @{ note = $c.conditions_note } } else { $null })
      remedies = $c.remedies
      verbatim_language = (Nz $x.verbatim_language)
      source_abstract_id = $r.abstract_id
      extraction = $c
    } | ConvertTo-Json -Depth 14
    $ins = Invoke-RestMethod -Uri "$BASE/rest/v1/co_tenancy_clauses" -Method Post -Headers $HW -UserAgent $UA -Body $body -TimeoutSec 60
    $clauseId = @($ins)[0].id
    $ct++

    # named anchors -> junction (tenant match at same property; REA flag from lease)
    foreach ($nm in @($c.named_tenants)) {
      if (-not (Nz $nm)) { continue }
      $tid = $null; $rea = $false
      $aq = [uri]::EscapeDataString('*' + (($nm -replace '[(),%_]', ' ').Trim()) + '*')
      $hits = Invoke-RestMethod -Uri "$BASE/rest/v1/tenants?select=id,name&or=(name.ilike.$aq,trade_name.ilike.$aq)&limit=5" -Headers $H -UserAgent $UA -TimeoutSec 60
      foreach ($t in @($hits)) {
        $al = Invoke-RestMethod -Uri "$BASE/rest/v1/leases?select=id,is_rea_member,leased_sf&tenant_id=eq.$($t.id)&property_id=eq.$($lease.property_id)&status=eq.active&limit=1" -Headers $H -UserAgent $UA -TimeoutSec 60
        if (@($al).Count -ge 1) {
          $tid = $t.id
          $arow = @($al)[0]
          if ($arow.is_rea_member -or ([double]$arow.leased_sf) -eq 0) { $rea = $true }
          break
        }
      }
      $jb = @{ clause_id = $clauseId; tenant_id = $tid; tenant_label = $nm; is_rea_member = $rea } | ConvertTo-Json -Compress
      Invoke-RestMethod -Uri "$BASE/rest/v1/co_tenancy_named_tenants" -Method Post -Headers $HW -UserAgent $UA -Body $jb -TimeoutSec 60 | Out-Null
    }
  }

  # ---- termination rights ----
  Invoke-RestMethod -Uri "$BASE/rest/v1/termination_rights?lease_id=eq.$($lease.id)&human_verified=eq.false" -Method Delete -Headers $HW -UserAgent $UA -TimeoutSec 60 | Out-Null
  foreach ($rt in @($x.termination_rights)) {
    # One-time vs recurring sales kickouts: a "lease year N" test lapses once that year
    # (plus a reporting/notice grace) has passed. Model verdict wins; fall back to a
    # measure_period heuristic; date the window from lease commencement when possible.
    $recurring = $false
    $wStart = (Nz $rt.window_start); $wEnd = (Nz $rt.window_end)
    if ($rt.right_type -eq 'sales_kickout') {
      if ($null -ne $rt.recurring) { $recurring = [bool]$rt.recurring }
      elseif ((Nz $rt.measure_period) -and $rt.measure_period -match '(?i)\b(any|each|every|rolling|trailing)\b') { $recurring = $true }
      if ((-not $recurring) -and (-not $wEnd) -and (Nz $rt.measure_period) -and $lease.commencement_date -and
          $rt.measure_period -match '(?i)lease year\s+(\d+)') {
        $yr = [int]$Matches[1]
        $comm = [datetime]::Parse($lease.commencement_date)
        $wStart = $comm.AddYears($yr - 1).ToString('yyyy-MM-dd')
        # measuring year end + 9 months grace for sales reporting + notice window
        $wEnd = $comm.AddYears($yr).AddMonths(9).ToString('yyyy-MM-dd')
      }
    }
    $tb = [ordered]@{
      lease_id = $lease.id
      property_id = $lease.property_id
      right_type = $rt.right_type
      sales_threshold = $rt.sales_threshold
      measure_period = (Nz $rt.measure_period)
      recurring = $recurring
      window_start = $wStart
      window_end = $wEnd
      exercisable_from = (Nz $rt.exercisable_from)
      notice_days = $rt.notice_days
      termination_fee = (Nz $rt.termination_fee)
      details = $rt.details
      source_abstract_id = $r.abstract_id
      extraction = $rt
    } | ConvertTo-Json -Depth 10
    Invoke-RestMethod -Uri "$BASE/rest/v1/termination_rights" -Method Post -Headers $HW -UserAgent $UA -Body $tb -TimeoutSec 60 | Out-Null
    $tr++
  }
}
Write-Output ("done. leases resolved={0} clauses={1} termination_rights={2} skipped={3}" -f $nl, $ct, $tr, $skip)
