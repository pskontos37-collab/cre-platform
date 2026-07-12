# load_emergency_manuals.ps1  (ASCII only - PS 5.1)
# Publishes the completed per-property Emergency Procedures Manuals to the
# /emergency-manuals library (emergency_manuals table). It auto-discovers the
# manuals under K:\Property Management\Emergency Procedures Manual\<property>\...
#
# A "manual" = one (property, vintage). The source may be a Word document, a PDF,
# or both (a .docx/.doc and its .pdf twin, which are merged into one entry). For
# each manual we publish to the documents bucket under emergency-manuals/:
#   - the original file for download (the Word doc if present, else the PDF), and
#   - a PDF for in-browser viewing (the source PDF if present, else rendered from
#     the Word doc via Word COM).
# The most recent manual per property is flagged is_current; older ones fold
# underneath as history on the page.
#
# MODES (default = Inventory, which is READ-ONLY and touches nothing in prod):
#   -Inventory   scan K: and write a catalog CSV to review (no render, no upload)
#   -Load        render + upload + upsert (writes to production storage + DB)
# Re-run -Load after the annual refresh to publish new manuals in place.
#
# Requires migration 20240059_emergency_manuals. Storage calls use the classic
# service_role JWT (SUPABASE_SERVICE_JWT) - sb_secret_ keys are rejected by
# storage endpoints.

param(
  [switch]$Inventory,
  [switch]$Load,
  [switch]$SkipRender,  # -Load only: upload originals + existing PDFs, do NOT
                        # invoke Word COM to render Word-only manuals. Word-only
                        # entries become download-only (no in-browser View PDF).
                        # Use when Word COM hangs; render later with a plain -Load.
  [string[]]$Properties = @()   # allow-list of property_name values to include.
                        # Empty = all discovered. We roll this feature out one
                        # property at a time, so pass the CURRENT set each run,
                        # e.g. -Properties 'Gateway Port Chester','Knightdale Marketplace','Magnolia Park'
)
if (-not $Load) { $Inventory = $true }   # safe default: read-only inventory

$ErrorActionPreference = 'Stop'

$root = 'K:\Property Management\Emergency Procedures Manual'

# Top-level entries that are NOT a single property's manual folder.
$skipTop = @(
  'Archives', 'Emergency Manual Cover Templates', 'Active Shooter Drills',
  'Office', 'Sunrise Properties'   # Sunrise handled as a container below
)
# Folders that hold several distinct properties (each file/subfolder is its own
# property; the container name becomes the `portfolio`).
$containers = @('CenterSquare PA Portfolio', 'Sunrise Properties', 'PITT')
# Path segments whose contents are duplicates/working copies - excluded.
$skipSegs = @('Back Up Documents', 'Backup', 'Back Up')
# Manual per-file overrides after reviewing the inventory. Key = full source
# path; value = @{ property=...; portfolio=...; skip=$true } to correct or drop.
$overrides = @{
  # "Waterfront" under the PITT folder is the same asset as the owned
  # "The Waterfront" (Homestead, PA) - fold it into that property's history.
  'K:\Property Management\Emergency Procedures Manual\PITT\Waterfront\Emergency Manual Waterfront - final.docx' =
    @{ property = 'The Waterfront'; portfolio = $null }
}

# ---- helpers ---------------------------------------------------------------
function Slugify([string]$s) {
  $s = $s.ToLower() -replace '[^a-z0-9]+', '-'
  return ($s.Trim('-'))
}

# Best-effort (year, date, label) from a filename + its path segments.
function Get-Vintage([string]$name, [string[]]$segs) {
  $year = $null; $date = $null
  # date anywhere: m.d.yy(yy) with . - _ or space separators
  if ($name -match '\b(\d{1,2})[._\- ](\d{1,2})[._\- ](20\d{2}|\d{2})\b') {
    $mo = [int]$matches[1]; $dy = [int]$matches[2]; $yr = $matches[3]
    if ($yr.Length -eq 2) { $yr = "20$yr" }
    try { $date = (Get-Date -Year ([int]$yr) -Month $mo -Day $dy -Hour 0 -Minute 0 -Second 0); $year = [int]$yr } catch { $date = $null }
  }
  # MMYYYY glued (e.g. FINAL-032025)
  elseif ($name -match '[-_ ](0[1-9]|1[0-2])(20\d{2})\b') {
    $mo = [int]$matches[1]; $year = [int]$matches[2]
    try { $date = (Get-Date -Year $year -Month $mo -Day 1) } catch {}
  }
  # A standalone 4-digit year wins for `year` even if a date was found (handles
  # names like "... 2026 3.13.2026" where the intended year is 2026).
  $yrs = [regex]::Matches($name, '\b(20\d{2})\b') | ForEach-Object { [int]$_.Groups[1].Value }
  if ($yrs.Count) { $year = ($yrs | Sort-Object)[-1] }
  # fall back to a year-named ancestor folder
  if (-not $year) { foreach ($seg in $segs) { if ($seg -match '^(20\d{2})$') { $year = [int]$matches[1] } } }

  $label = if ($year) { "$year" }
           elseif ($name -match '(?i)final') { 'Final' }
           elseif ($name -match '(?i)draft') { 'Draft' }
           else { $null }
  return @{ year = $year; date = $date; label = $label; isDraft = [bool]($name -match '(?i)draft') }
}

# ---- discover --------------------------------------------------------------
if (-not (Test-Path $root)) { throw "Root not found: $root" }

$found = New-Object System.Collections.ArrayList
$topDirs = Get-ChildItem -LiteralPath $root -Directory | Where-Object { $skipTop -notcontains $_.Name }
$sunrise = Join-Path $root 'Sunrise Properties'          # own container, after the loop
$asDrills = Join-Path $root 'Active Shooter Drills'      # shared folder, resolve property by name
$knownNames = @($topDirs | ForEach-Object { $_.Name }) + @('Gateway Port Chester')

# Which annual deliverable is this file? Active-shooter recaps/drills vs the manual.
function Get-DocKind([string]$name) {
  if ($name -match '(?i)active shooter') { return 'active_shooter' }
  return 'manual'
}

# $knownNames (optional): when set (shared folders like 'Active Shooter Drills'),
# the property is resolved from the longest known name the filename starts with;
# files that name no known property are skipped.
function Add-Manuals([string]$scanDir, [string]$defaultProperty, [string]$portfolio, [string[]]$knownNames) {
  $files = Get-ChildItem -LiteralPath $scanDir -Recurse -File |
    Where-Object {
      $_.Extension -match '(?i)^\.(docx?|pdf)$' -and
      $_.Length -gt 0 -and
      $_.Name -notmatch '^~\$' -and
      ($_.Name -match '(?i)emergency manual' -or $_.Name -match '(?i)active shooter') -and
      $_.Name -notmatch '(?i)MASTER TEMPLATE|Cover Template|Completion Log'
    }
  foreach ($f in $files) {
    $rel  = $f.FullName.Substring($root.Length).TrimStart('\')
    $segs = $rel -split '\\'
    if ($segs | Where-Object { $skipSegs -contains $_ }) { continue }   # backup copies
    $v    = Get-Vintage $f.BaseName $segs
    $kind = Get-DocKind $f.BaseName
    $prop = $defaultProperty
    $pf   = $portfolio
    if ($knownNames) {
      # shared folder: match the property named at the start of the filename
      $hit = $knownNames | Where-Object { $f.BaseName -like ($_ + '*') } | Sort-Object Length -Descending | Select-Object -First 1
      if (-not $hit) { continue }
      $prop = $hit
    }
    elseif ($containers -contains $defaultProperty) {
      $sub = $segs[1]
      if ($sub -and $sub -notmatch '^(20\d{2}|Archive)$' -and (Test-Path (Join-Path $scanDir $sub) -PathType Container)) {
        $prop = $sub
      } elseif ($f.BaseName -match '(?i)emergency manual[^-]*-\s*(.+?)\s*(?:-\s*(?:final|draft).*)?$') {
        $prop = $matches[1].Trim()
      } else {
        $prop = ($f.BaseName -replace '(?i)emergency manual|template|final|draft|\d', '').Trim(' -_')
      }
      $pf = $defaultProperty
    }
    $ov = $overrides[$f.FullName]
    if ($ov) { if ($ov.skip) { continue }; if ($ov.property) { $prop = $ov.property }; if ($ov.ContainsKey('portfolio')) { $pf = $ov.portfolio } }
    [void]$found.Add([pscustomobject]@{
      property  = $prop
      portfolio = $pf
      doc_kind  = $kind
      year      = $v.year
      date      = if ($v.date) { $v.date.ToString('yyyy-MM-dd') } else { $null }
      label     = $v.label
      isDraft   = $v.isDraft
      ext       = $f.Extension.ToLower()
      base      = $f.BaseName
      file_name = $f.Name
      source    = $f.FullName
      size      = [int]$f.Length
      mtime     = $f.LastWriteTime.ToString('yyyy-MM-dd')
    })
  }
}

foreach ($d in $topDirs) {
  if ($containers -contains $d.Name) { Add-Manuals $d.FullName $d.Name $d.Name $null }
  else { Add-Manuals $d.FullName $d.Name $null $null }
}
if (Test-Path $sunrise)  { Add-Manuals $sunrise 'Sunrise Properties' 'Sunrise Properties' $null }
if (Test-Path $asDrills) { Add-Manuals $asDrills $null $null $knownNames }   # shared active-shooter folder

if ($found.Count -eq 0) { throw "No emergency manuals discovered under $root" }

# ---- merge Word+PDF twins into one entry per (property, kind, basename) ----
$manuals = New-Object System.Collections.ArrayList
foreach ($g in ($found | Group-Object { "$($_.property)|$($_.doc_kind)|$($_.base.ToLower())" })) {
  $items = @($g.Group)
  $doc   = $items | Where-Object { $_.ext -in '.docx', '.doc' } | Select-Object -First 1
  $pdf   = $items | Where-Object { $_.ext -eq '.pdf' } | Select-Object -First 1
  $ref   = if ($doc) { $doc } else { $pdf }      # the download original
  [void]$manuals.Add([pscustomobject]@{
    property    = $ref.property
    portfolio   = $ref.portfolio
    doc_kind    = $ref.doc_kind
    year        = $ref.year
    date        = $ref.date
    label       = $ref.label
    isDraft     = $ref.isDraft
    file_name   = $ref.file_name
    doc_source  = if ($doc) { $doc.source } else { $null }
    pdf_source  = if ($pdf) { $pdf.source } else { $null }
    dl_source   = $ref.source
    dl_ext      = $ref.ext
    size        = $ref.size
    mtime       = $ref.mtime
    is_current  = $false
    sort_order  = 0
  })
}

# ---- pick current per (property, doc_kind) (year, date, non-draft, mtime) ---
$catalog = New-Object System.Collections.ArrayList
foreach ($g in ($manuals | Group-Object { "$($_.property)|$($_.doc_kind)" })) {
  $sorted = @($g.Group | Sort-Object `
    @{ e = { if ($_.year) { [int]$_.year } else { 0 } }; Descending = $true }, `
    @{ e = { if ($_.date) { $_.date } else { '0000-00-00' } }; Descending = $true }, `
    @{ e = { if ($_.isDraft) { 1 } else { 0 } }; Descending = $false }, `
    @{ e = { $_.mtime }; Descending = $true })
  for ($i = 0; $i -lt $sorted.Count; $i++) {
    $sorted[$i].is_current = ($i -eq 0)
    $sorted[$i].sort_order = $i
    [void]$catalog.Add($sorted[$i])
  }
}

# ---- optional property allow-list (incremental roll-out) -------------------
if ($Properties.Count) {
  $before = $catalog.Count
  $catalog = New-Object System.Collections.ArrayList(,@($catalog | Where-Object { $Properties -contains $_.property }))
  if ($catalog.Count -eq 0) { throw ("No manuals match -Properties {0}. Discovered names differ - run -Inventory to see them." -f ($Properties -join ', ')) }
  Write-Host ("Property filter: keeping {0}/{1} manuals for {2}" -f $catalog.Count, $before, ($Properties -join ', '))
}

# ---- INVENTORY: write CSV + summary, no prod writes ------------------------
$outDir = Join-Path $env:TEMP 'emergency_manuals'
New-Item -ItemType Directory -Force $outDir | Out-Null
$csv = Join-Path $outDir 'catalog.csv'
$catalog |
  Select-Object property, portfolio, doc_kind, year, date, label, is_current,
    @{ n = 'has_word'; e = { [bool]$_.doc_source } }, @{ n = 'has_pdf'; e = { [bool]$_.pdf_source } },
    file_name, size, dl_source |
  Sort-Object property, doc_kind, @{ e = { [int]$_.year }; Descending = $true } |
  Export-Csv -NoTypeInformation -Encoding UTF8 $csv

$propCount = (@($catalog | ForEach-Object { $_.property }) | Sort-Object -Unique).Count
$asCount   = @($catalog | Where-Object { $_.doc_kind -eq 'active_shooter' }).Count
Write-Host ("Discovered {0} files ({1} manuals, {2} active-shooter) across {3} properties." -f `
  $catalog.Count, ($catalog.Count - $asCount), $asCount, $propCount)
Write-Host ("Catalog CSV: {0}" -f $csv)
Write-Host ''
Write-Host 'CURRENT per property + kind:'
$catalog | Where-Object { $_.is_current } | Sort-Object property, doc_kind | ForEach-Object {
  $fmt  = if ($_.pdf_source -and $_.doc_source) { 'word+pdf' } elseif ($_.pdf_source) { 'pdf' } else { 'word' }
  $knd  = if ($_.doc_kind -eq 'active_shooter') { 'ACTIVE SHOOTER' } else { 'Manual' }
  Write-Host ("  {0,-26} {1,-15} {2,-6} {3,-8} {4}" -f $_.property, $knd, $_.label, $fmt, $_.file_name)
}

if ($Inventory) {
  Write-Host ''
  Write-Host 'Inventory only - nothing was uploaded. Review the CSV, then re-run with -Load.'
  return
}

# ============================================================================
# LOAD MODE: render (only when needed), upload, upsert
# ============================================================================
$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile  = Join-Path $repoRoot '.env'
$envMap = @{}
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*([^#=]+)=(.*)$') { $envMap[$matches[1].Trim()] = $matches[2].Trim() }
}
$baseUrl = $envMap['VITE_SUPABASE_URL']
$svcJwt  = $envMap['SUPABASE_SERVICE_JWT']
if (-not $baseUrl -or -not $svcJwt) { throw 'Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_JWT in .env' }

function Get-Mime([string]$ext) {
  switch ($ext.ToLower()) {
    '.doc'  { 'application/msword' }
    '.docx' { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
    '.pdf'  { 'application/pdf' }
    default { 'application/octet-stream' }
  }
}

# unique storage slug per manual
foreach ($m in $catalog) {
  $h = [BitConverter]::ToString(
    (New-Object Security.Cryptography.SHA1Managed).ComputeHash([Text.Encoding]::UTF8.GetBytes($m.dl_source))
  ).Replace('-', '').Substring(0, 6).ToLower()
  $kindTag = if ($m.doc_kind -eq 'active_shooter') { 'as' } else { 'em' }
  $m | Add-Member NoteProperty slug (Slugify ("$($m.property)-$kindTag-$($m.year)-$h")) -Force
  $m | Add-Member NoteProperty pdfLocal $null -Force
}

# ---- 1) render PDFs only for manuals with a Word source but no PDF ---------
$needRender = if ($SkipRender) { @() } else { @($catalog | Where-Object { $_.doc_source -and -not $_.pdf_source }) }
if ($SkipRender) { Write-Host 'SkipRender: uploading originals + existing PDFs only (no Word->PDF render).' }
if ($needRender.Count) {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  foreach ($m in $needRender) {
    $local = Join-Path $outDir ($m.slug + '.pdf')
    try {
      $doc = $word.Documents.Open($m.doc_source, $false, $true)   # ConfirmConversions=false, ReadOnly=true
      $doc.ExportAsFixedFormat($local, 17)                        # 17 = wdExportFormatPDF
      $doc.Close($false)
      $m.pdfLocal = $local
      Write-Host ("rendered {0}" -f $m.slug)
    } catch {
      Write-Warning ("PDF render FAILED for {0}: {1}" -f $m.dl_source, $_.Exception.Message)
    }
  }
  $word.Quit()
  [Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}

# ---- 2) upload to storage --------------------------------------------------
function Send-ObjectToStorage([string]$localPath, [string]$objKey, [string]$contentType) {
  $uploadUrl = "$baseUrl/storage/v1/object/documents/$objKey"
  $resp = curl.exe -sS -X POST $uploadUrl `
    -H "Authorization: Bearer $svcJwt" `
    -H "Content-Type: $contentType" `
    -H "x-upsert: true" `
    --data-binary "@$localPath"
  if ($resp -match '"error"' -or $resp -match '"statusCode"\s*:\s*"?4') { throw "Storage upload failed for ${objKey}: $resp" }
}

$rows = @()
foreach ($m in $catalog) {
  $dlMime  = Get-Mime $m.dl_ext
  $fileKey = 'emergency-manuals/' + $m.slug + $m.dl_ext
  Send-ObjectToStorage $m.dl_source $fileKey $dlMime

  # viewer PDF: the source PDF, the rendered PDF, or (pdf-only manual) = the file itself
  $pdfKey = $null
  if ($m.dl_ext -eq '.pdf') {
    $pdfKey = $fileKey
  } elseif ($m.pdf_source) {
    $pdfKey = 'emergency-manuals/' + $m.slug + '.pdf'
    Send-ObjectToStorage $m.pdf_source $pdfKey 'application/pdf'
  } elseif ($m.pdfLocal -and (Test-Path $m.pdfLocal)) {
    $pdfKey = 'emergency-manuals/' + $m.slug + '.pdf'
    Send-ObjectToStorage $m.pdfLocal $pdfKey 'application/pdf'
  }

  $rows += [ordered]@{
    property_name   = [string]$m.property
    portfolio       = $m.portfolio
    doc_kind        = [string]$m.doc_kind
    manual_year     = $m.year
    effective_date  = $m.date
    is_current      = [bool]$m.is_current
    version_label   = $m.label
    file_path       = $fileKey
    file_name       = [string]$m.file_name
    mime_type       = $dlMime
    file_size_bytes = [int]$m.size
    pdf_path        = $pdfKey
    sort_order      = [int]$m.sort_order
    is_active       = $true
    source_path     = [string]$m.dl_source
    updated_at      = (Get-Date).ToUniversalTime().ToString('o')
  }
  Write-Host ("uploaded {0}" -f $fileKey)
}

# ---- 3) upsert rows (return=representation catches silent no-persist) -------
$payloadPath = Join-Path $outDir 'rows.json'
[IO.File]::WriteAllText($payloadPath, (ConvertTo-Json -InputObject $rows -Depth 5))
$restUrl = "$baseUrl/rest/v1/emergency_manuals?on_conflict=file_path"
$resp = curl.exe -sS -X POST $restUrl `
  -H "apikey: $svcJwt" `
  -H "Authorization: Bearer $svcJwt" `
  -H "Content-Type: application/json" `
  -H "Prefer: resolution=merge-duplicates,return=representation" `
  --data-binary "@$payloadPath"
if ($resp -notmatch '"id"') { throw "Upsert did not return rows - check response: $resp" }
Write-Host ("Done: {0} manuals published." -f $rows.Count)
