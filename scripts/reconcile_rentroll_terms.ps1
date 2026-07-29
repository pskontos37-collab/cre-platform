# reconcile_rentroll_terms.ps1 - propagate MRI FUTURE-TERM rent-roll rows into leases.expiration_date.
#
# WHY THIS EXISTS (2026-07-28): MRI's CMROLL lists an extended/renewed term as a SECOND row
# for the same suite - the current-term row (is_occupied=true, has rent) plus a future-term
# row (is_occupied=false, rent null) starting the day after the current row ends. The lease
# model was seeded from the CURRENT row only, so every extension MRI already knew about sat
# invisible in leases.expiration_date. That single gap produced:
#   Wild Wings, Mimosa      - found 2026-07-27 via the abstract-vs-lease conflict query
#   Results Physiotherapy   - 2027-09-30 in leases, 2029-09-30 in MRI (2 yrs)
#   CKE Fitness             - 2028-04-30 in leases, 2030-04-30 in MRI (2 yrs)
#   Salt Grass, Elase       - INVISIBLE to that query, because the ABSTRACT repeated the same
#                             stale date. Salt Grass was 7 days from firing a renewal-notice
#                             alarm on an option the tenant had already exercised.
# The abstract-vs-lease test only fires when the abstract disagrees. This one asks MRI directly.
#
# Companion to reconcile_option_notices.ps1: that script reads NOTICE DOCUMENTS, this one
# reads the MRI RENT ROLL. Run both after every RR load - they catch different misses.
#
# Modes:
#   (default)   REPORT: print every suite whose MRI term chain disagrees with leases. No writes.
#   -Load       apply the MRI-AHEAD rows (see SAFETY RULES). Prints a diff first.
#   -PropertyId <uuid>   limit to one property.
#
# SAFETY RULES (each one is a bug this script would otherwise cause):
#  1. WALK THE CHAIN ONLY WHILE THE TENANT MATCHES. Suite K5 at KM East chains
#     Island Nails Spa -> Island Nails Spa -> MY DAY SPA (a different, signed successor).
#     A naive max(lease_end) per suite hands Island Nails a term 5 years too long - which is
#     exactly what leases.expiration_date already holds (2033-10-31). Stop at the tenant change
#     and report the successor separately.
#  2. REQUIRE CONTIGUITY (next.lease_start = prev.lease_end + 1). Signed-not-yet-open leases
#     (Jersey Mike's, Naya, IKEA, KidStrong) sit alongside a 'Vacant' row with no occupied row
#     at all - they are new leases, not extensions, and must not touch an existing lease.
#  3. ONLY MOVE EXPIRATION FORWARD (MRI ahead of leases). When leases is AHEAD of MRI, report
#     only - that is the Rack Room / Kay Jewelers class where we hold a documented term MRI has
#     not caught up to, and MRI must not overwrite it.
#  4. NEVER MARK AN OPTION EXERCISED. A future-term row proves the term is committed, NOT how
#     it got there: CKE Fitness's extension was a negotiated Second Amendment, not an option
#     exercise. Whether an option was consumed is a DOCUMENT question - that is
#     reconcile_option_notices.ps1's job. This script FLAGS now-stale option notice dates for
#     human review and stops there.
#  5. JOIN ON SUITE, NOT NAME. rent_roll_rows.lease_id is unpopulated for both KM properties,
#     and the tenant name can drift between the two rows for the same lease
#     ("Kay Jewelers" -> "Kay Jewelers #S4753").
#  6. A SUB-WEEK GAP IS A ROUNDING ARTIFACT, NOT AN EXTENSION. BEV MAX: the amendment says
#     "April __, 2032 (ten (10) years and six (6) months following the Effective Date)" -
#     day left blank, formula gives 2032-04-28, and MRI rounds it to month-end 2032-04-30.
#     Applying MRI there would overwrite a document-derived date with a rounding error, so
#     deltas under 7 days are quarantined out of -Load and reported for a human.
param([switch]$Load, [string]$PropertyId = 'all')
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$H  = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$HW = @{ apikey = $KEY; Authorization = "Bearer $KEY"; Prefer = 'return=representation'; 'Content-Type' = 'application/json' }
$enc = New-Object System.Text.UTF8Encoding($false)
$TMP = "$env:TEMP\_rrterm_patch.json"

function Patch($path, $obj) {
  [IO.File]::WriteAllText($TMP, ($obj | ConvertTo-Json -Compress), $enc)
  $r = & curl.exe -s -X PATCH "$BASE/rest/v1/$path" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" `
        -H "Content-Type: application/json" -H "Prefer: return=minimal" --data-binary "@$TMP"
  if ($r -match '"code"' -and $r -match '"message"') { throw "PATCH $path failed: $r" }
}

# Normalized tenant key: fold case/punctuation and drop MRI store-number suffixes so
# "Kay Jewelers" and "Kay Jewelers #S4753" compare equal, but "My Day Spa" does not.
function TKey($n) {
  if (-not $n) { return '' }
  $s = ([string]$n).ToLower()
  $s = $s -replace '#\s*[a-z]?\d+', ' '        # #474, #S4753, # 37092
  $s = $s -replace '[^a-z0-9 ]', ' '
  $s = ($s -replace '\s+', ' ').Trim()
  return $s
}

# ---------------- pull the latest snapshot per property ----------------
$snapQ = "select=id,property_id,period_year,period_month&order=property_id.asc,period_year.desc,period_month.desc&limit=2000"
if ($PropertyId -ne 'all') { $snapQ += "&property_id=eq.$PropertyId" }
$snaps = Invoke-RestMethod -Uri "$BASE/rest/v1/rent_roll_snapshots?$snapQ" -Headers $H -UserAgent $UA -TimeoutSec 90
$latest = @{}
foreach ($s in $snaps) { if (-not $latest.ContainsKey($s.property_id)) { $latest[$s.property_id] = $s } }

$props = Invoke-RestMethod -Uri "$BASE/rest/v1/properties?select=id,name&limit=200" -Headers $H -UserAgent $UA -TimeoutSec 60
$pname = @{}; foreach ($p in $props) { $pname[$p.id] = $p.name }

$ahead = @(); $behind = @(); $successors = @(); $rounding = @()

foreach ($propId in $latest.Keys) {          # NOT $pid - that is a PS automatic variable (process id)
  $snap = $latest[$propId]
  $label = $pname[$propId]; if (-not $label) { $label = $propId }
  Write-Output ("==== {0}  (snapshot {1}-{2:d2})" -f $label, $snap.period_year, $snap.period_month)

  $rows = Invoke-RestMethod -Uri "$BASE/rest/v1/rent_roll_rows?select=suite,tenant_name,lease_start,lease_end,is_occupied&snapshot_id=eq.$($snap.id)&limit=2000" -Headers $H -UserAgent $UA -TimeoutSec 90
  $units = Invoke-RestMethod -Uri "$BASE/rest/v1/units?select=id,unit_number&property_id=eq.$propId&limit=2000" -Headers $H -UserAgent $UA -TimeoutSec 90
  $unitBySuite = @{}; foreach ($u in $units) { $unitBySuite[[string]$u.unit_number] = $u.id }
  $leases = Invoke-RestMethod -Uri "$BASE/rest/v1/leases?select=id,unit_id,tenant_id,expiration_date,status&property_id=eq.$propId&status=eq.active&limit=2000" -Headers $H -UserAgent $UA -TimeoutSec 90
  $leaseByUnit = @{}; foreach ($lz in $leases) { if ($lz.unit_id) { $leaseByUnit[[string]$lz.unit_id] = $lz } }

  foreach ($grp in ($rows | Group-Object suite)) {
    $suite = $grp.Name
    if (-not $suite) { continue }
    $sr = @($grp.Group | Where-Object { $_.lease_end } | Sort-Object { [datetime]$_.lease_start })
    if ($sr.Count -lt 2) { continue }

    # anchor = the CURRENT-term row (the one we actually billed into leases)
    $cur = @($sr | Where-Object { $_.is_occupied }) | Select-Object -First 1
    if (-not $cur) { continue }              # rule 2: no occupied row = signed-not-open, not an extension

    # rule 1 + 2: walk forward while contiguous AND same tenant
    $endDate = [datetime]$cur.lease_end
    $key = TKey $cur.tenant_name
    $steps = 0
    while ($true) {
      $next = @($sr | Where-Object { $_.lease_start -and ([datetime]$_.lease_start) -eq $endDate.AddDays(1) }) | Select-Object -First 1
      if (-not $next) { break }
      if ((TKey $next.tenant_name) -ne $key) {
        $successors += [pscustomobject]@{ Property = $label; Suite = $suite; Incumbent = $cur.tenant_name
                                          Successor = $next.tenant_name; Starts = $next.lease_start; Ends = $next.lease_end }
        break
      }
      $endDate = [datetime]$next.lease_end
      $steps++
      if ($steps -gt 10) { break }
    }
    if ($steps -eq 0) { continue }

    $mriEnd = $endDate.ToString('yyyy-MM-dd')
    $uid = $unitBySuite[[string]$suite]
    $lease = $null; if ($uid) { $lease = $leaseByUnit[[string]$uid] }
    if (-not $lease) {
      Write-Output ("  suite {0,-6} {1,-32} MRI term -> {2}  (NO ACTIVE LEASE MATCHED on suite)" -f $suite, $cur.tenant_name, $mriEnd)
      continue
    }
    $dbEnd = [string]$lease.expiration_date
    if ($dbEnd -eq $mriEnd) { continue }

    $gap = [Math]::Abs((([datetime]$mriEnd) - ([datetime]$dbEnd)).TotalDays)
    $rec = [pscustomobject]@{ Property = $label; Suite = $suite; Tenant = $cur.tenant_name
                              LeaseId = $lease.id; DbEnd = $dbEnd; MriEnd = $mriEnd; GapDays = [int]$gap }
    if ($gap -lt 7)          { $rounding += $rec }    # rule 6
    elseif ($dbEnd -lt $mriEnd) { $ahead += $rec }
    else                     { $behind += $rec }
  }
}

Write-Output ''
Write-Output '---- MRI AHEAD of leases (stale expiration; -Load fixes these) ----'
if ($ahead.Count -eq 0) { Write-Output '  none' } else { $ahead | Format-Table Property, Suite, Tenant, DbEnd, MriEnd -AutoSize | Out-String | Write-Output }

Write-Output '---- leases AHEAD of MRI (report only - we may hold a documented term MRI lacks) ----'
if ($behind.Count -eq 0) { Write-Output '  none' } else { $behind | Format-Table Property, Suite, Tenant, DbEnd, MriEnd -AutoSize | Out-String | Write-Output }

Write-Output '---- SUB-WEEK GAP: rounding-suspect, NEVER auto-applied (see safety rule 6) ----'
if ($rounding.Count -eq 0) { Write-Output '  none' } else { $rounding | Format-Table Property, Suite, Tenant, DbEnd, MriEnd, GapDays -AutoSize | Out-String | Write-Output }

Write-Output '---- SUCCESSOR TENANT signed on the same suite (chain stops here; review manually) ----'
if ($successors.Count -eq 0) { Write-Output '  none' } else { $successors | Format-Table Property, Suite, Incumbent, Successor, Starts, Ends -AutoSize | Out-String | Write-Output }

if (-not $Load) {
  Write-Output ''
  Write-Output ("REPORT ONLY. {0} lease(s) would be rolled forward. Re-run with -Load to apply." -f $ahead.Count)
  exit 0
}

# ---------------- LOAD ----------------
$today = (Get-Date).ToString('yyyy-MM-dd')
foreach ($a in $ahead) {
  Write-Output ("  {0} @ {1} suite {2}: expiration {3} -> {4}" -f $a.Tenant, $a.Property, $a.Suite, $a.DbEnd, $a.MriEnd)

  Patch "leases?id=eq.$($a.LeaseId)" @{ expiration_date = $a.MriEnd; updated_at = (Get-Date -Format o) }
  Patch "critical_dates?lease_id=eq.$($a.LeaseId)&date_type=eq.lease_expiration" @{ due_date = $a.MriEnd }
  Patch "critical_events?lease_id=eq.$($a.LeaseId)&event_type=eq.lease_expiration" @{ computed_date = $a.MriEnd; mri_value = $a.MriEnd; updated_at = (Get-Date -Format o) }

  # Rule 4: do NOT mark options exercised and do NOT silently retire their notice dates.
  # An option notice deadline computed off the OLD term is now wrong, but only a document
  # says whether the option was exercised, superseded by an amendment, or still live.
  $stale = Invoke-RestMethod -Uri "$BASE/rest/v1/critical_dates?select=id,due_date,description&lease_id=eq.$($a.LeaseId)&date_type=eq.option_notice_deadline&status=eq.open" -Headers $H -UserAgent $UA -TimeoutSec 60
  foreach ($sd in $stale) {
    if (([string]$sd.due_date) -lt $a.MriEnd) {
      Patch "critical_dates?id=eq.$($sd.id)" @{ resolution_note = ("[{0} rentroll-terms] Term rolled {1} -> {2} from an MRI future-term row. This notice date was computed off the OLD term and is almost certainly wrong. Confirm against the exercise notice / amendment before acting." -f $today, $a.DbEnd, $a.MriEnd) }
      Write-Output ("      FLAGGED stale option notice {0} ({1})" -f $sd.due_date, $sd.description)
    }
  }
}
Write-Output ("done. rolled {0} lease(s). Option notices were FLAGGED, never auto-completed - run reconcile_option_notices.ps1 for the document side." -f $ahead.Count)
