# load_form_templates.ps1  (ASCII only - PS 5.1)
# Publishes firm reference forms to the /forms library (form_templates table):
#   1) converts each source file to PDF via Office COM (Excel for .xls/.xlsx,
#      Word for .doc/.docx),
#   2) uploads original + PDF to the documents bucket under forms/<category>/,
#   3) upserts form_templates rows (on_conflict=file_path).
# Re-run after replacing a source file on K: to publish a new version (same
# storage key = same row, updated in place). Requires migration
# 20240056_form_templates. Storage calls use the classic service_role JWT
# (SUPABASE_SERVICE_JWT) - sb_secret_ keys are rejected by storage endpoints.

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile  = Join-Path $repoRoot '.env'
$envMap = @{}
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*([^#=]+)=(.*)$') { $envMap[$matches[1].Trim()] = $matches[2].Trim() }
}
$baseUrl = $envMap['VITE_SUPABASE_URL']
$svcJwt  = $envMap['SUPABASE_SERVICE_JWT']
if (-not $baseUrl -or -not $svcJwt) { throw 'Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_JWT in .env' }

# ---- form definitions (add new forms here) --------------------------------
$forms = @(
  @{
    source      = 'K:\Property Management\POLICY MANUAL\16.0 Property Operations\16.3 Property Inspections\Retail Property Inspection Report - 2026 FINAL.xls'
    slug        = 'retail-property-inspection-2026'
    category    = 'inspection'
    title       = 'Retail Property Inspection Report'
    version     = '2026'
    sort        = 0
    description = 'Quarterly site-inspection scorecard for retail properties (goal 1x/quarter, performed during all site visits). 58 line items scored 1-5 across signage, parking lots/sidewalks, storefronts/facade, landscaping, lighting, common areas, leasing, back of house, and office/paperwork/safety audit. Items scored 1, 2 or 5 require notes in the detail column.'
  },
  @{
    source      = 'K:\Property Management\POLICY MANUAL\16.0 Property Operations\16.3 Property Inspections\Office Property Inspection Report - 2026.xls'
    slug        = 'office-property-inspection-2026'
    category    = 'inspection'
    title       = 'Office Property Inspection Report'
    version     = '2026'
    sort        = 1
    description = 'Quarterly site-inspection scorecard for office properties (goal 1x/quarter, performed during all site visits). Line items scored 1-5 by building area, with an averaged overall score. Items scored 1, 2 or 5 require notes in the detail column.'
  },
  @{
    source      = 'K:\Property Management\Emergency Procedures Manual\Emergency Manual Template - MASTER TEMPLATE.docx'
    slug        = 'emergency-procedures-manual-template'
    category    = 'emergency'
    title       = 'Emergency Procedures Manual Template'
    version     = 'Master'
    sort        = 0
    noPdf       = $true   # 18MB image-heavy doc: Word PDF export is impractically slow; publish download-only
    description = 'Firm master template for building a property-specific Emergency Procedures Manual. Download the Word document and fill in property details, emergency contacts, and site-specific procedures (fire, severe weather, medical, active shooter, evacuation, utility failure, etc.) to produce that property''s manual. Property-specific completed manuals live under each property in the Emergency Procedures Manual folder.'
  }
)

# mime type by file extension (used for storage Content-Type and the stored row)
function Get-Mime([string]$ext) {
  switch ($ext.ToLower()) {
    '.xls'  { 'application/vnd.ms-excel' }
    '.xlsx' { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
    '.doc'  { 'application/msword' }
    '.docx' { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
    default { 'application/octet-stream' }
  }
}

# ---- 1) render PDFs -------------------------------------------------------
$staging = Join-Path $env:TEMP 'form_templates_staging'
New-Item -ItemType Directory -Force $staging | Out-Null

foreach ($f in $forms) {
  if (-not (Test-Path $f.source)) { throw "Source not found: $($f.source)" }
  $f.ext      = [IO.Path]::GetExtension($f.source).ToLower()
  # noPdf forms publish download-only (no PDF preview) - e.g. very large,
  # image-heavy docs whose Office->PDF export is impractically slow.
  $f.pdfLocal = if ($f.noPdf) { $null } else { Join-Path $staging ($f.slug + '.pdf') }
}

$excelForms = @($forms | Where-Object { -not $_.noPdf -and $_.ext -in '.xls', '.xlsx', '.xlsm' })
$wordForms  = @($forms | Where-Object { -not $_.noPdf -and $_.ext -in '.doc', '.docx' })

if ($excelForms.Count) {
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  foreach ($f in $excelForms) {
    $wb = $excel.Workbooks.Open($f.source, 0, $true)   # UpdateLinks=0, ReadOnly=$true
    $wb.ExportAsFixedFormat(0, $f.pdfLocal)            # 0 = xlTypePDF
    $wb.Close($false)
    Write-Host ("rendered " + $f.slug + ".pdf (Excel)")
  }
  $excel.Quit()
  [Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
}

if ($wordForms.Count) {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0                               # wdAlertsNone
  try { $word.AutomationSecurity = 3 } catch {}         # msoAutomationSecurityForceDisable (no macro/data prompts)
  try { $word.Options.UpdateLinksAtOpen = $false } catch {}
  try { $word.Options.ConfirmConversions = $false } catch {}
  foreach ($f in $wordForms) {
    # Copy off the network share to local disk first. Opening a large doc
    # straight from a UNC/mapped drive can trigger Protected View or a
    # link-update prompt that hangs invisible automation (Visible=$false).
    $localSrc = Join-Path $staging ($f.slug + $f.ext)
    Copy-Item -LiteralPath $f.source -Destination $localSrc -Force
    try {
      # ConfirmConversions=$false, ReadOnly=$true, AddToRecentFiles=$false
      $doc = $word.Documents.Open($localSrc, $false, $true, $false)
      $doc.ExportAsFixedFormat($f.pdfLocal, 17)        # 17 = wdExportFormatPDF
      $doc.Close($false)
      Write-Host ("rendered " + $f.slug + ".pdf (Word)")
    } catch {
      $f.pdfLocal = $null   # publish download-only if the PDF preview can't render
      Write-Host ("WARN: Word PDF render failed for " + $f.slug + " - publishing download-only. " + $_.Exception.Message)
    }
  }
  $word.Quit()
  [Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}

# ---- 2) upload to storage -------------------------------------------------
function Send-ObjectToStorage([string]$localPath, [string]$objKey, [string]$contentType) {
  $uploadUrl = "$baseUrl/storage/v1/object/documents/$objKey"
  $resp = curl.exe -sS -X POST $uploadUrl `
    -H "Authorization: Bearer $svcJwt" `
    -H "Content-Type: $contentType" `
    -H "x-upsert: true" `
    --data-binary "@$localPath"
  Write-Host ("upload " + $objKey + " -> " + $resp)
  if ($resp -match '"error"' -or $resp -match '"statusCode"\s*:\s*"?4') { throw "Storage upload failed for $objKey" }
}

$rows = @()
foreach ($f in $forms) {
  $ext     = $f.ext
  $mime    = Get-Mime $ext
  $fileKey = 'forms/' + $f.category + '/' + $f.slug + $ext
  Send-ObjectToStorage $f.source $fileKey $mime
  $pdfKey = $null
  if ($f.pdfLocal) {
    $pdfKey = 'forms/' + $f.category + '/' + $f.slug + '.pdf'
    Send-ObjectToStorage $f.pdfLocal $pdfKey 'application/pdf'
  }
  $rows += [ordered]@{
    category        = $f.category
    title           = $f.title
    description     = $f.description
    version_label   = $f.version
    file_path       = $fileKey
    file_name       = [IO.Path]::GetFileName($f.source)
    mime_type       = $mime
    file_size_bytes = [int](Get-Item $f.source).Length
    pdf_path        = $pdfKey
    sort_order      = [int]$f.sort
    is_active       = $true
    source_path     = $f.source
    updated_at      = (Get-Date).ToUniversalTime().ToString('o')
  }
}

# ---- 3) upsert rows (return=representation so silent no-persist is caught) -
$payloadPath = Join-Path $staging 'rows.json'
[IO.File]::WriteAllText($payloadPath, (ConvertTo-Json -InputObject $rows -Depth 5))
$restUrl = "$baseUrl/rest/v1/form_templates?on_conflict=file_path"
$resp = curl.exe -sS -X POST $restUrl `
  -H "apikey: $svcJwt" `
  -H "Authorization: Bearer $svcJwt" `
  -H "Content-Type: application/json" `
  -H "Prefer: resolution=merge-duplicates,return=representation" `
  --data-binary "@$payloadPath"
Write-Host $resp
if ($resp -notmatch '"id"') { throw 'Upsert did not return rows - check response above' }
Write-Host ("Done: " + $rows.Count + " forms published.")
