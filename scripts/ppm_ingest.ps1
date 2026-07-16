# ppm_ingest.ps1 - walks a deal's acquisitions folder (K:\ASSTMGMT\ACQUISITIONS\
# <State>\<Deal>\), classifies the key due-diligence documents by the standard
# DD taxonomy, has Claude extract the relevant PPM data-sheet fields from each,
# merges them, and writes a ppm_drafts row so the /ppm page opens pre-filled.
#
# This is the counterpart to the in-app "paste & extract" - it reads the WHOLE
# folder at once (rent roll, PCA, Phase I, loan + JV term sheets, operating
# statements, zoning, survey, co-tenancy summary, and the cash-flow model).
# The web app can't reach K:\, so this runs locally like the other loaders.
#
# WHY LOCAL: folder walk + PDF/Word/Excel reads need K:\ + Office COM.
#
# Discipline: EXTRACT ONLY (never compute a number); fill-empty merge (analyst
# entries and prior ingests win) unless -Force; percentages stored as decimals.
#
#   .\ppm_ingest.ps1 -Deal "Silverado"                 # DRY RUN: classify only
#   .\ppm_ingest.ps1 -Deal "Silverado" -Apply          # extract + create a draft
#   .\ppm_ingest.ps1 -Deal "Silverado" -Apply -Draft <ppm_draft_id>   # merge into existing
#   .\ppm_ingest.ps1 -FolderPath "K:\...\Deal" -DealName "X" -Apply    # folder w/o a pipeline deal
param(
  [string]$Deal,
  [string]$FolderPath,
  [string]$DealName,
  [string]$Draft,
  [switch]$Apply,
  [switch]$Force,
  [int]$MaxPdfMB = 20,
  [string]$Model = 'claude-sonnet-5'
)
$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\pskontos\Desktop\Software\cre-platform'
$cfg = @{}; foreach ($ln in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $a,$b = $ln -split '=',2; $cfg[$a.Trim()]=$b.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $AK = $cfg['SUPABASE_SECRET_KEY']; $ANTH = $cfg['ANTHROPIC_API_KEY']
$enc = New-Object System.Text.UTF8Encoding($false)
$TMP = "$env:TEMP\_ppm_ingest.json"
$WORK = Join-Path $env:TEMP 'ppm_ingest'
New-Item -ItemType Directory -Force $WORK | Out-Null

# ---------------------------------------------------------------------------
# Resolve the deal + its folder
# ---------------------------------------------------------------------------
$dealId = $null; $seed = $null; $folder = $FolderPath
if ($Deal) {
  $sel = 'id,name,city,state,submarket,gla_sf,year_built,asset_type,risk_profile,ask_price,going_in_cap,equity_required,total_capitalization,proj_irr,equity_multiple,avg_coc,hold_years,exit_cap,thesis,folder_path'
  $hits = & curl.exe -s "$BASE/rest/v1/pipeline_deals?select=$sel&name=ilike.*$([uri]::EscapeDataString($Deal))*" -H "apikey: $AK" -H "Authorization: Bearer $AK" | ConvertFrom-Json
  if (@($hits).Count -eq 0) { throw "No pipeline deal matches '$Deal'." }
  if (@($hits).Count -gt 1) { Write-Host ("Multiple deals match '{0}': {1}. Using the first." -f $Deal, (($hits | ForEach-Object { $_.name }) -join ', ')) -ForegroundColor Yellow }
  $seed = $hits[0]; $dealId = $seed.id
  if (-not $folder) { $folder = [string]$seed.folder_path }
  if (-not $DealName) { $DealName = [string]$seed.name }
}
if (-not $folder) { throw 'No folder to walk. Pass -Deal (with a linked folder_path) or -FolderPath.' }
if (-not (Test-Path -LiteralPath $folder)) { throw "Folder not found: $folder" }
if (-not $DealName) { $DealName = Split-Path $folder -Leaf }
Write-Host ("Deal: {0}" -f $DealName)
Write-Host ("Folder: {0}" -f $folder)
Write-Host ("Mode: {0}{1}" -f $(if($Apply){'APPLY'}else{'DRY RUN'}), $(if($Force){' (force overwrite)'}else{''}))

# ---------------------------------------------------------------------------
# Document categories. Each is classified by filename OR relative-path regex;
# `prefer` promotes a summary/exec version; `schema` is the exact JSON the model
# must return (keys = PpmDataSheet field names).
# ---------------------------------------------------------------------------
$CATS = @(
  @{ key='rent_roll'; label='rent roll'; nameRe='rent ?roll'; pathRe='rent ?roll|1\.05';
     prefer='current|summary'; focus='the RENT ROLL';
     schema='{"glaSf":num|null,"occupancyPct":decimal|null,"tenants":[{"name":str,"sf":num|null,"pctGla":decimal|null,"rentPsf":num|null,"leaseType":str|null,"expiration":str|null,"options":str|null}]}' }
  @{ key='pca'; label='PCA (property condition)'; nameRe='pca|property condition|quick ?look'; pathRe='partner|8\.03|property condition|inspection';
     prefer='quick ?look|summary|cost'; focus='the PROPERTY CONDITION ASSESSMENT (PCA) report';
     schema='{"pcaFirm":str|null,"pcaDate":str|null,"pcaImmediateRepairs":num|null,"pcaReserve12yr":num|null,"pcaPsfPerYear":num|null,"pcaKeyItems":str|null}' }
  @{ key='esa'; label='Phase I environmental'; nameRe='phase ?i|esa|environmental'; pathRe='environmental|8\.04|phase ?i';
     prefer='summary|finding|conclusion|exec'; focus='the PHASE I ENVIRONMENTAL SITE ASSESSMENT';
     schema='{"esaFirm":str|null,"esaDate":str|null,"esaFindings":"the sentence continuing: the Phase I ESA for the Property ..."}' }
  @{ key='loan'; label='loan term sheet'; nameRe='loan|term ?sheet|commitment|application|debt|financing|mortgage'; pathRe='loan|debt|financing|3\.00';
     prefer='term ?sheet|commitment|application'; focus='the MORTGAGE LOAN term sheet / application / commitment';
     schema='{"lenderName":str|null,"loanAmount":num|null,"ltvPct":decimal|null,"interestRate":decimal|null,"rateDescription":str|null,"loanTermYears":num|null,"ioDescription":str|null,"futureFunding":str|null}' }
  @{ key='jv'; label='JV term sheet / LOI'; nameRe='\bjv\b|joint ?venture'; pathRe='\bjv\b|joint ?venture';
     exclude='tenant|lease|estoppel|snda|commenc|car ?wash|broker|easement'; prefer='term ?sheet|loi'; focus='the JOINT VENTURE term sheet / letter of intent';
     schema='{"jvPartnerName":str|null,"jvPartnerShort":str|null,"jvPartnerPct":decimal|null,"mjwPct":decimal|null,"jvVehicleName":str|null,"propertyOwnerLlc":str|null,"classAPrefIrr":decimal|null,"classAPrefEm":num|null,"jvWaterfallTiers":[{"split":str,"until":str}]}' }
  @{ key='zoning'; label='zoning / PZR'; nameRe='zoning|pzr'; pathRe='zoning|pzr|5\.03';
     prefer='report|summary'; focus='the ZONING REPORT (or PZR)';
     schema='{"zoningText":str|null,"taxParcels":str|null,"floodZoneText":str|null}' }
  @{ key='opstmt'; label='operating statements'; nameRe='operating ?statement|income ?statement|\bt-?12\b|\bop ?stmt\b|trailing ?twelve'; pathRe='operating ?statement|income statement|1\.02';
     exclude='tenant|lease|commenc|estoppel|deposit'; prefer='trailing|annual|income ?statement|summary'; focus='the HISTORICAL OPERATING STATEMENTS / income statements';
     schema='{"opexPsfYr1":num|null,"retPsfYr1":num|null,"historicalNoi":[{"year":str,"income":num|null,"expenses":num|null,"noi":num|null}]}' }
  @{ key='cotenancy'; label='co-tenancy / exclusives'; nameRe='cotenancy|co-?tenancy|exclusive|termination'; pathRe='cotenancy|co-?tenancy|exclusive|termination|4\.18';
     prefer='summary'; focus='the CO-TENANCY, EXCLUSIVE USE and TERMINATION RIGHTS summary';
     schema='{"coTenancy":[{"tenant":str,"requirement":str,"conclusion":str}]}' }
  @{ key='survey'; label='survey'; nameRe='survey|alta'; pathRe='survey|5\.01';
     prefer='alta'; focus='the ALTA SURVEY';
     schema='{"landAcres":num|null,"parkingSpaces":num|null,"parkingRatio":str|null}' }
)

# The cash-flow model is handled separately (Excel print of its summary sheets).
$MODEL_NAME_RE = 'cf model|cash ?flow|underwrit|model|argus'
$MODEL_EXCL_RE = 'invoice|reconcil|occupanc|tax|sales|budget|rent ?roll|parking|~\$'
$CF_SHEET_RE   = 'summary|return|assumption|annual|cash ?flow|cf|sources|uses|leasing'
$CF_SCHEMA = '{"holdYears":num|null,"exitCap":decimal|null,"projSalePrice":num|null,"projSalePsf":num|null,"projIrr":decimal|null,"avgCoc":decimal|null,"equityMultiple":num|null,"afterTaxIrr":decimal|null,"afterTaxCoc":decimal|null,"capexBudgetTotal":num|null,"capexBudgetLines":[{"item":str,"amount":num}],"opexPsfYr1":num|null,"retPsfYr1":num|null,"mgmtFeePct":decimal|null,"structuralReservePsf":num|null,"leasingAssumptionsNote":str|null}'

# ---------------------------------------------------------------------------
# File discovery + classification (single recursive walk)
# ---------------------------------------------------------------------------
$EXT_OK = '\.(pdf|docx?|xlsx?)$'
$all = @(Get-ChildItem -LiteralPath $folder -Recurse -File -Depth 5 -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match $EXT_OK -and -not $_.Name.StartsWith('~$') })
$extRank = @{ '.pdf'=0; '.docx'=1; '.doc'=2; '.xlsx'=3; '.xls'=4 }

function Rel($f){ $f.FullName.Substring($folder.Length).TrimStart('\') }

function Pick-Best($cat){
  $matches = @($all | Where-Object {
    $rel = Rel $_
    $dir = [string](Split-Path $rel -Parent)
    # path patterns test the DIRECTORY only (so a date like "1.02.14" in a
    # filename can't hit a "1.02" taxonomy code); name patterns test the file.
    $hit = ($_.Name -match $cat.nameRe) -or ($dir -match $cat.pathRe)
    if ($hit -and $cat.exclude) { $hit = -not ($rel -match $cat.exclude) }
    $hit
  })
  if ($matches.Count -eq 0) { return $null }
  # rank: prefer-hit, then live folders over TEMP/Archive/Old/Prelim copies,
  # then extension (pdf best), then smaller file (favors summaries).
  $ranked = $matches | Sort-Object `
    @{ Expression = { if ($cat.prefer -and ($_.Name -match $cat.prefer)) { 0 } else { 1 } } },
    @{ Expression = { if ((Rel $_) -match 'temp|archive|\bold\b|prelim|~\$') { 1 } else { 0 } } },
    @{ Expression = { $r = $extRank[$_.Extension.ToLower()]; if ($null -eq $r) { 9 } else { $r } } },
    @{ Expression = { [long]$_.Length } }
  return $ranked | Select-Object -First 1
}

# ---------------------------------------------------------------------------
# Convert any supported file to a local PDF (Claude reads PDFs). Word/Excel via
# COM. Excel: for CF models, print only the summary sheets; otherwise first few.
# ---------------------------------------------------------------------------
function Convert-ToPdf($file, [bool]$modelMode){
  $ext = $file.Extension.ToLower()
  if ($ext -eq '.pdf') { return $file.FullName }
  $childName = (([IO.Path]::GetFileNameWithoutExtension($file.Name)) -replace '[^\w.\-]+','_') + '.pdf'
  $out = Join-Path $WORK $childName
  if ($ext -in '.doc','.docx') {
    $w = New-Object -ComObject Word.Application
    $w.Visible = $false; $w.DisplayAlerts = 0
    try {
      $doc = $w.Documents.Open($file.FullName, $false, $true)   # confirmConversions=false, readOnly=true
      $doc.SaveAs([ref]$out, [ref]17)                           # 17 = wdFormatPDF
      $doc.Close($false)
    } finally { $w.Quit(); [Runtime.Interopservices.Marshal]::ReleaseComObject($w) | Out-Null }
    return $out
  }
  if ($ext -in '.xls','.xlsx') {
    $xl = New-Object -ComObject Excel.Application
    $xl.Visible = $false; $xl.DisplayAlerts = $false; $xl.AskToUpdateLinks = $false
    try {
      $wb = $xl.Workbooks.Open($file.FullName, 0, $true)
      $names = @(); foreach ($ws in $wb.Worksheets) { if ($ws.Visible -eq -1) { $names += $ws.Name } }
      $pick = if ($modelMode) { @($names | Where-Object { $_ -match $CF_SHEET_RE } | Select-Object -First 5) } else { @() }
      if ($pick.Count -eq 0) { $pick = @($names | Select-Object -First 4) }
      $wb.Worksheets.Item($pick[0]).Select()
      for ($i=1; $i -lt $pick.Count; $i++) { $wb.Worksheets.Item($pick[$i]).Select($false) }
      $xl.ActiveSheet.ExportAsFixedFormat(0, $out)
      $wb.Close($false)
    } finally { $xl.Quit(); [Runtime.Interopservices.Marshal]::ReleaseComObject($xl) | Out-Null }
    return $out
  }
  return $null
}

# ---------------------------------------------------------------------------
# Claude extraction: one PDF sent as base64, forced-tool JSON matching a schema.
# ---------------------------------------------------------------------------
function Extract-Pdf([string]$pdfPath, [string]$focus, [string]$schema){
  $sizeMB = [math]::Round((Get-Item $pdfPath).Length / 1MB, 1)
  if ($sizeMB -gt $MaxPdfMB) { Write-Host ("    (skip: {0} MB exceeds {1} MB cap)" -f $sizeMB, $MaxPdfMB) -ForegroundColor DarkYellow; return $null }
  $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($pdfPath))
  $prompt = @"
You are an acquisitions analyst at M&J Wilkow preparing a Private Placement Memorandum for the deal: $DealName. The attached PDF is $focus.

Extract facts for the PPM data sheet. Rules:
- EXTRACT ONLY values stated in the document. NEVER compute, derive, estimate, or infer a number. A field the document does not state = null.
- Percentages as decimals (7.98% -> 0.0798). Dollars as plain numbers (no commas/$).
- Dates as written in the document.
- For array fields, return one object per item; return an empty array if none.
- Call the report_ppm tool with an object matching this schema EXACTLY (all top-level keys present):
$schema
"@
  $content = @(
    @{ type='document'; source=@{ type='base64'; media_type='application/pdf'; data=$b64 } },
    @{ type='text'; text=$prompt }
  )
  $body = @{ model=$Model; max_tokens=4000
    tools=@(@{ name='report_ppm'; description='Report the extracted PPM data-sheet fields.'; input_schema=@{ type='object'; additionalProperties=$true } })
    tool_choice=@{ type='tool'; name='report_ppm' }
    messages=@(@{ role='user'; content=$content }) } | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText($TMP, $body, $enc)
  $resp = & curl.exe -s 'https://api.anthropic.com/v1/messages' -H "x-api-key: $ANTH" -H 'anthropic-version: 2023-06-01' -H 'Content-Type: application/json' --data-binary "@$TMP" | ConvertFrom-Json
  if ($resp.error) {
    $em = if ($resp.error.message -is [string]) { $resp.error.message } else { ($resp.error | ConvertTo-Json -Compress -Depth 6) }
    Write-Host ("    !! anthropic: {0}" -f $em) -ForegroundColor Red
    return $null
  }
  $tu = $resp.content | Where-Object { $_.type -eq 'tool_use' } | Select-Object -First 1
  if (-not $tu) { Write-Host '    !! no tool_use in response' -ForegroundColor Red; return $null }
  return $tu.input
}

# ---------------------------------------------------------------------------
# Merge helper (fill-empty unless -Force). $ds is a plain hashtable of the
# fields we've populated; the frontend hydrates the rest from a blank sheet.
# ---------------------------------------------------------------------------
function Is-Empty($v){
  if ($null -eq $v) { return $true }
  if ($v -is [string]) { return ($v.Trim() -eq '') }
  if ($v -is [Array]) { return ($v.Count -eq 0) }
  return $false
}
function Merge-Into($ds, $fields){
  if (-not $fields) { return 0 }
  $n = 0
  foreach ($p in $fields.PSObject.Properties) {
    $k = $p.Name; $v = $p.Value
    if (Is-Empty $v) { continue }
    if ($Force -or (Is-Empty $ds[$k])) { $ds[$k] = $v; $n++ }
  }
  return $n
}

# ---------------------------------------------------------------------------
# Seed the data sheet from the pipeline deal (same fields as the in-app prefill).
# ---------------------------------------------------------------------------
$ds = @{}
if ($seed) {
  if ($seed.name)            { $ds['propertyName'] = [string]$seed.name }
  if ($seed.city)            { $ds['city'] = [string]$seed.city }
  if ($seed.state)           { $ds['state'] = [string]$seed.state }
  if ($seed.submarket)       { $ds['submarketName'] = [string]$seed.submarket }
  if ($null -ne $seed.gla_sf){ $ds['glaSf'] = [double]$seed.gla_sf }
  if ($seed.year_built)      { $ds['yearBuilt'] = [string]$seed.year_built }
  if ($null -ne $seed.ask_price)            { $ds['purchasePrice'] = [double]$seed.ask_price }
  if ($null -ne $seed.going_in_cap)         { $ds['goingInCap'] = [double]$seed.going_in_cap }
  if ($null -ne $seed.equity_required)      { $ds['totalEquity'] = [double]$seed.equity_required }
  if ($null -ne $seed.total_capitalization) { $ds['totalCapitalization'] = [double]$seed.total_capitalization }
  if ($null -ne $seed.proj_irr)             { $ds['projIrr'] = [double]$seed.proj_irr }
  if ($null -ne $seed.equity_multiple)      { $ds['equityMultiple'] = [double]$seed.equity_multiple }
  if ($null -ne $seed.avg_coc)              { $ds['avgCoc'] = [double]$seed.avg_coc }
  if ($null -ne $seed.hold_years)           { $ds['holdYears'] = [double]$seed.hold_years }
  if ($null -ne $seed.exit_cap)             { $ds['exitCap'] = [double]$seed.exit_cap }
  if ($seed.thesis)          { $ds['marketOverviewNotes'] = [string]$seed.thesis }
  $ti = (Get-Culture).TextInfo
  $tp = @(); foreach ($x in @($seed.asset_type, $seed.risk_profile)) { if ($x) { $tp += $ti.ToTitleCase((([string]$x) -replace '_',' ')) } }
  if ($tp.Count) { $ds['propertyType'] = ($tp -join ' - ') }
}

# ---------------------------------------------------------------------------
# Classify, (optionally) extract, merge
# ---------------------------------------------------------------------------
$plan = @()
foreach ($cat in $CATS) {
  $best = Pick-Best $cat
  $plan += [pscustomobject]@{ cat=$cat; file=$best }
}
$cfModel = @($all | Where-Object { $_.Extension -match '^\.xlsx?$' -and $_.Name -match $MODEL_NAME_RE -and $_.Name -notmatch $MODEL_EXCL_RE } |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1)

Write-Host ''
Write-Host 'Classified documents:'
foreach ($p in $plan) {
  if ($p.file) { Write-Host ("  [{0,-22}] {1}" -f $p.cat.label, (Rel $p.file)) }
  else         { Write-Host ("  [{0,-22}] -- none found" -f $p.cat.label) -ForegroundColor DarkGray }
}
if ($cfModel.Count) { Write-Host ("  [{0,-22}] {1} (updated {2:MM/dd/yy})" -f 'cash-flow model', (Rel $cfModel[0]), $cfModel[0].LastWriteTime) }
else                { Write-Host ("  [{0,-22}] -- none found" -f 'cash-flow model') -ForegroundColor DarkGray }

if (-not $Apply) {
  Write-Host ''
  Write-Host 'DRY RUN complete. Re-run with -Apply to extract and write a PPM draft.' -ForegroundColor Cyan
  return
}

Write-Host ''
Write-Host 'Extracting...'
$totalFilled = 0
foreach ($p in $plan) {
  if (-not $p.file) { continue }
  Write-Host ("  {0}: reading '{1}'" -f $p.cat.label, $p.file.Name)
  $pdf = $null
  try { $pdf = Convert-ToPdf $p.file $false } catch { Write-Host ("    !! convert failed: {0}" -f $_.Exception.Message) -ForegroundColor Red; continue }
  if (-not $pdf) { Write-Host '    (unsupported file type)' -ForegroundColor DarkYellow; continue }
  $fields = Extract-Pdf $pdf $p.cat.focus $p.cat.schema
  if (-not $fields) { continue }
  # tenants: fill the client-side shape defaults the model wasn't asked for
  if ($fields.PSObject.Properties.Name -contains 'tenants' -and $fields.tenants) {
    $fields.tenants = @($fields.tenants | ForEach-Object {
      [pscustomobject]@{ name=[string]$_.name; sf=$_.sf; pctGla=$_.pctGla; pctRev=$null; rentPsf=$_.rentPsf;
        leaseType=$(if($_.leaseType){[string]$_.leaseType}else{'NNN'}); expiration=$(if($_.expiration){[string]$_.expiration}else{''});
        options=$(if($_.options){[string]$_.options}else{''}); salesPsf=$null; healthRatio=$null; placerRank=''; groundLease=$false }
    })
  }
  $n = Merge-Into $ds $fields
  Write-Host ("    -> merged {0} field group(s)" -f $n)
  $totalFilled += $n
}

# Cash-flow model (Excel-printed summary sheets)
if ($cfModel.Count) {
  Write-Host ("  cash-flow model: printing summary sheets from '{0}'" -f $cfModel[0].Name)
  try {
    $cfPdf = Convert-ToPdf $cfModel[0] $true
    if ($cfPdf) {
      $fields = Extract-Pdf $cfPdf 'the CASH-FLOW MODEL (summary / returns / assumptions sheets)' $CF_SCHEMA
      if ($fields) { $n = Merge-Into $ds $fields; Write-Host ("    -> merged {0} field group(s)" -f $n); $totalFilled += $n }
    }
  } catch { Write-Host ("    !! model print/extract failed: {0}" -f $_.Exception.Message) -ForegroundColor Red }
}

Write-Host ''
Write-Host ("Populated {0} data-sheet field group(s) total." -f $totalFilled)

# ---------------------------------------------------------------------------
# Write: update an existing draft (merge) or create a new one
# ---------------------------------------------------------------------------
if ($Draft) {
  $ex = & curl.exe -s "$BASE/rest/v1/ppm_drafts?id=eq.$Draft&select=data_sheet" -H "apikey: $AK" -H "Authorization: Bearer $AK" | ConvertFrom-Json
  if (@($ex).Count -eq 0) { throw "ppm_draft $Draft not found." }
  $merged = @{}
  # start from existing, then fill-empty from the freshly ingested $ds
  foreach ($pp in $ex[0].data_sheet.PSObject.Properties) { $merged[$pp.Name] = $pp.Value }
  foreach ($k in $ds.Keys) { if ($Force -or (Is-Empty $merged[$k])) { $merged[$k] = $ds[$k] } }
  $patch = @{ data_sheet=$merged; updated_at=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText($TMP, $patch, $enc)
  $code = & curl.exe -s -o NUL -w "%{http_code}" -X PATCH "$BASE/rest/v1/ppm_drafts?id=eq.$Draft" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" -H "Prefer: return=minimal" --data-binary "@$TMP"
  if ([int]$code -lt 200 -or [int]$code -ge 300) { throw "PATCH failed HTTP $code" }
  Write-Host ("Merged into existing draft {0}." -f $Draft) -ForegroundColor Green
} else {
  $row = @{ name="$DealName PPM"; deal_id=$dealId; status='draft'; data_sheet=$ds; sections=@{} } | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText($TMP, $row, $enc)
  $created = & curl.exe -s -X POST "$BASE/rest/v1/ppm_drafts" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" -H "Prefer: return=representation" --data-binary "@$TMP" | ConvertFrom-Json
  if (-not $created -or -not $created[0].id) { throw 'ppm_drafts insert failed' }
  Write-Host ("Created PPM draft {0} ('{1}')." -f $created[0].id, "$DealName PPM") -ForegroundColor Green
}
Write-Host 'Open /ppm, select the draft, review the data sheet, then Generate all sections.' -ForegroundColor Cyan
