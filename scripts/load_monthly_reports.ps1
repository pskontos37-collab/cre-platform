# load_monthly_reports.ps1  (ASCII only - PS 5.1)
# Publishes each property's FINAL monthly reporting PACKAGE (the consolidated PDF)
# to the /monthly-reports library (monthly_reports table). One row per
# (property, year, month). Files are uploaded to the documents bucket under
#   p/<property_id>/monthly-reports/<year>-<mm>.pdf
# so the existing property-scoped storage read policy (20240042) governs access.
#
# WHY filename-driven discovery: the monthly-reporting folder layout differs per
# property AND per year (Knightdale: <MM>-<YYYY>\Consolidated\; Gateway 2025:
# <MM>-<YYYY>\, Gateway 2026: <MM>.<YY>\FINAL\; Magnolia: <N>. <MonthName>\). The
# ONE stable anchor is the final-report filename, which is clean and dated on
# every property. So we recurse each property's base folder, match the
# property-specific final-report filename, and parse (month, year) from the name.
#
# MODES (default = Inventory, READ-ONLY, touches nothing in prod):
#   -Inventory   scan K:, resolve property_ids, write a catalog CSV to review
#   -Load        upload PDFs to storage + upsert monthly_reports rows
# Re-run -Load monthly to publish the new package in place (upsert on file_path).
#
# Requires migration 20240107_monthly_reports. Storage calls use the classic
# service_role JWT (SUPABASE_SERVICE_JWT) - sb_secret_ keys are rejected by
# storage endpoints.
#
# EXTENDING to a newly onboarded property: add a block to $configs below with the
# property's `name` (must match public.properties.name), its monthly-reporting
# `base` folder, a `fileRegex` that matches only the final package filename, and
# optional `mustContainInPath`. Run -Inventory first to eyeball the matches.

param(
  [switch]$Inventory,
  [switch]$Load,
  [int]$SinceYear = 2025,
  [string[]]$Properties = @()   # allow-list of property `name` values; empty = all in $configs
)
if (-not $Load) { $Inventory = $true }   # safe default: read-only inventory
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Per-property discovery config. name MUST match public.properties.name.
# ---------------------------------------------------------------------------
$configs = @(
  @{
    name              = 'Knightdale Marketplace (Consolidated)'
    base              = 'K:\Working Files - Knightdale Marketplace\Monthly Reporting'
    fileRegex         = 'Monthly Report\.pdf$'   # "...Midtown Midway June 2026 Monthly Report.pdf"
    mustContainInName = 'Consolidated'           # exclude the per-store Midtown/Midway packages
    mustContainInPath = 'Consolidated'           # only the Consolidated subfolder
  },
  @{
    name              = 'Gateway Port Chester'
    base              = 'K:\Working Files - Gateway Port Chester\Accounting\Monthly Reporting'
    # Gateway's dash/spacing is wildly inconsistent ("Report-", "Report - ",
    # "Report -Feb", "Report November", "Gateway Port Chester Monthly Report-").
    # Match on "Monthly Report" broadly; Parse-Period (needs a month+year) drops
    # decoys like "Gateway Monthly Report Cover - Ops.pdf".
    fileRegex         = 'Monthly Report'
    mustContainInName = $null
    mustContainInPath = $null
  },
  @{
    name              = 'Magnolia Park Shopping Center'
    base              = 'K:\Working Files - Magnolia\Monthly Reports'
    fileRegex         = 'Monthly Report\.pdf$'   # "102801_MagnoliaPark_July2026Monthly Report.pdf"
    mustContainInName = 'MagnoliaPark'
    mustContainInPath = $null
  }
)

# Path segments that hold drafts / working copies / prior deliverables - excluded.
$skipPathSegs = @('Supplemental', 'Back Up', 'Backup', 'Back-Up', 'Archive', 'Archives', 'Old', 'Draft', 'Drafts')

# Filenames that contain "Monthly Report" but are NOT the package itself (cover
# sheets, TOCs, section dividers). These can otherwise be mis-dated from the path
# and slip into dedup, so exclude them by name up front.
$skipNameRegex = '(?i)\bcover\b|table of contents|\btoc\b|section [ivx]+\b'

$months = @{
  'january'=1;'february'=2;'march'=3;'april'=4;'may'=5;'june'=6;
  'july'=7;'august'=8;'september'=9;'october'=10;'november'=11;'december'=12
}
$monthName = @('','January','February','March','April','May','June','July','August','September','October','November','December')

$monthNameRe = 'January|February|March|April|May|June|July|August|September|October|November|December'

function Parse-Period([string]$fileName, [string]$fullPath) {
  # 1) Prefer the filename: "<Month>[ ]<YYYY>" (Magnolia omits the space).
  if ($fileName -match "(?i)($monthNameRe)\s*((?:19|20)\d{2})") {
    return @{ month = $months[$matches[1].ToLower()]; year = [int]$matches[2] }
  }
  # 2) Numeric month folders: <MM>-<YYYY> (Knightdale/Gateway 2025) or <MM>.<YY> (Gateway 2026).
  if ($fullPath -match '\\(0?[1-9]|1[0-2])[-.](\d{4})\\') { return @{ month = [int]$matches[1]; year = [int]$matches[2] } }
  if ($fullPath -match '\\(0?[1-9]|1[0-2])\.(\d{2})\\')   { return @{ month = [int]$matches[1]; year = 2000 + [int]$matches[2] } }
  # 3) Named month folder "<N>. <MonthName>" (Magnolia) + a <YYYY> folder in the
  #    path. Rescues filename typos like "...Apri2025..." (April misspelled).
  #    Capture the month FIRST, then re-match for the year (which overwrites $matches).
  if ($fullPath -match "(?i)\\\d{1,2}\.\s*($monthNameRe)") {
    $mo = $months[$matches[1].ToLower()]
    if ($fullPath -match '\\((?:19|20)\d{2})\\') { return @{ month = $mo; year = [int]$matches[1] } }
  }
  return $null
}

function Slugify([string]$s) {
  ($s -replace '[^a-zA-Z0-9]+', '-').Trim('-').ToLower()
}

# ---------------------------------------------------------------------------
# env + property_id resolution
# ---------------------------------------------------------------------------
$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile  = Join-Path $repoRoot '.env'
$envMap = @{}
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*([^#=]+)=(.*)$') { $envMap[$matches[1].Trim()] = $matches[2].Trim() }
}
$baseUrl = $envMap['VITE_SUPABASE_URL']
$svcJwt  = $envMap['SUPABASE_SERVICE_JWT']
if (-not $baseUrl -or -not $svcJwt) { throw 'Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_JWT in .env' }
$H  = @{ apikey = $svcJwt; Authorization = "Bearer $svcJwt" }
$UA = 'load-monthly-reports/1.0'

$props = Invoke-RestMethod -Uri "$baseUrl/rest/v1/properties?select=id,name&limit=500" -Headers $H -UserAgent $UA -TimeoutSec 60
$pmap = @{}; foreach ($p in $props) { $pmap[$p.name] = $p.id }

$outDir = Join-Path $PSScriptRoot '.monthly_reports_out'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

# ---------------------------------------------------------------------------
# 1) DISCOVER
# ---------------------------------------------------------------------------
$catalog = @()
foreach ($cfg in $configs) {
  if ($Properties.Count -and ($Properties -notcontains $cfg.name)) { continue }
  if (-not $pmap.ContainsKey($cfg.name)) { Write-Warning ("No properties row named '{0}' - skipping." -f $cfg.name); continue }
  if (-not (Test-Path $cfg.base))       { Write-Warning ("Base folder not found: {0}" -f $cfg.base); continue }

  $files = Get-ChildItem -Path $cfg.base -Recurse -File -Filter '*.pdf' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match $cfg.fileRegex }
  if ($cfg.mustContainInName) { $files = $files | Where-Object { $_.Name -match [regex]::Escape($cfg.mustContainInName) } }
  if ($cfg.mustContainInPath) { $files = $files | Where-Object { $_.FullName -match [regex]::Escape($cfg.mustContainInPath) } }

  foreach ($f in $files) {
    if ($f.Name -match $skipNameRegex) { continue }
    $skip = $false
    foreach ($seg in $skipPathSegs) { if ($f.FullName -match [regex]::Escape("\$seg\")) { $skip = $true; break } }
    if ($skip) { continue }

    $per = Parse-Period $f.Name $f.FullName
    if (-not $per) { Write-Warning ("Could not parse period, SKIPPED: {0}" -f $f.FullName); continue }
    if ($per.year -lt $SinceYear) { continue }

    $catalog += [pscustomobject]@{
      property_name = $cfg.name
      property_id   = $pmap[$cfg.name]
      year          = $per.year
      month         = $per.month
      file_name     = $f.Name
      source_path   = $f.FullName
      size          = [int64]$f.Length
      mtime         = $f.LastWriteTime
    }
  }
}

# ---------------------------------------------------------------------------
# 2) DEDUPE per (property, year, month): prefer FINAL/Consolidated path, then newest.
# ---------------------------------------------------------------------------
$deduped = @()
$groups = $catalog | Group-Object property_id, year, month
foreach ($g in $groups) {
  $pick = $g.Group |
    Sort-Object `
      @{ Expression = { if ($_.source_path -match '(?i)\\FINAL\\|\\Consolidated\\') { 0 } else { 1 } } }, `
      @{ Expression = { $_.mtime }; Descending = $true } |
    Select-Object -First 1
  $deduped += $pick
  if ($g.Count -gt 1) {
    Write-Host ("  {0} {1}-{2:00}: {3} candidates, picked '{4}'" -f $pick.property_name, $pick.year, $pick.month, $g.Count, $pick.file_name)
  }
}

# is_current = latest (year, month) per property
$currentKey = @{}
foreach ($grp in ($deduped | Group-Object property_id)) {
  $top = $grp.Group | Sort-Object year, month -Descending | Select-Object -First 1
  $currentKey[$grp.Name] = ("{0}|{1}|{2}" -f $top.property_id, $top.year, $top.month)
}
foreach ($r in $deduped) {
  $r | Add-Member NoteProperty is_current ($currentKey[$r.property_id] -eq ("{0}|{1}|{2}" -f $r.property_id, $r.year, $r.month)) -Force
}

$deduped = $deduped | Sort-Object property_name, @{Expression='year';Descending=$true}, @{Expression='month';Descending=$true}

# ---------------------------------------------------------------------------
# INVENTORY: write CSV, print summary, stop.
# ---------------------------------------------------------------------------
$csv = Join-Path $outDir 'inventory.csv'
$deduped | Select-Object property_name, property_id, year, month, is_current, file_name, size, source_path |
  Export-Csv -Path $csv -NoTypeInformation -Encoding UTF8
Write-Host ""
Write-Host ("Discovered {0} final monthly packages (since {1}):" -f $deduped.Count, $SinceYear)
foreach ($grp in ($deduped | Group-Object property_name)) {
  $yrs = ($grp.Group | Select-Object -ExpandProperty year -Unique | Sort-Object) -join ', '
  Write-Host ("  {0}: {1} reports (years {2}) -> property_id {3}" -f $grp.Name, $grp.Count, $yrs, $grp.Group[0].property_id)
}
Write-Host ("Inventory CSV: {0}" -f $csv)

if ($Inventory) {
  Write-Host ""
  Write-Host 'Inventory only - nothing uploaded. Review the CSV, then re-run with -Load.'
  return
}

# ---------------------------------------------------------------------------
# LOAD: upload to storage + upsert rows
# ---------------------------------------------------------------------------
function Send-ObjectToStorage([string]$localPath, [string]$objKey) {
  $uploadUrl = "$baseUrl/storage/v1/object/documents/$objKey"
  $resp = curl.exe -sS -X POST $uploadUrl `
    -H "Authorization: Bearer $svcJwt" `
    -H "Content-Type: application/pdf" `
    -H "x-upsert: true" `
    --data-binary "@$localPath"
  if ($resp -match '"error"' -or $resp -match '"statusCode"\s*:\s*"?4') { throw "Storage upload failed for ${objKey}: $resp" }
}

$rows = @()
foreach ($r in $deduped) {
  $objKey = ("p/{0}/monthly-reports/{1}-{2:00}.pdf" -f $r.property_id, $r.year, $r.month)
  Send-ObjectToStorage $r.source_path $objKey
  $rows += [ordered]@{
    property_id     = [string]$r.property_id
    property_name   = [string]$r.property_name
    report_year     = [int]$r.year
    report_month    = [int]$r.month
    report_type     = 'consolidated'
    is_current      = [bool]$r.is_current
    file_path       = $objKey
    file_name       = [string]$r.file_name
    mime_type       = 'application/pdf'
    file_size_bytes = [int64]$r.size
    source_path     = [string]$r.source_path
    is_active       = $true
    updated_at      = (Get-Date).ToUniversalTime().ToString('o')
  }
  Write-Host ("uploaded {0}  ({1})" -f $objKey, $r.file_name)
}

$payloadPath = Join-Path $outDir 'rows.json'
[IO.File]::WriteAllText($payloadPath, (ConvertTo-Json -InputObject $rows -Depth 5))
$restUrl = "$baseUrl/rest/v1/monthly_reports?on_conflict=file_path"
$resp = curl.exe -sS -X POST $restUrl `
  -H "apikey: $svcJwt" `
  -H "Authorization: Bearer $svcJwt" `
  -H "Content-Type: application/json" `
  -H "Prefer: resolution=merge-duplicates,return=representation" `
  --data-binary "@$payloadPath"
if ($resp -notmatch '"id"') { throw "Upsert did not return rows - check response: $resp" }
Write-Host ("Done: {0} monthly reports published." -f $rows.Count)
