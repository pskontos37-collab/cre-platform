# extract_underwriting.ps1 - auto-fills each active deal's underwriting snapshot
# (proj IRR, equity multiple, avg cash-on-cash, hold, exit cap, stabilized yield,
# equity requirement, total cap) by having Claude READ the deal's own mirrored
# documents. Run AFTER mirror_deal_docs.ps1 -Apply.
#
# Discipline rules:
#  - EXTRACT ONLY: values must be stated in a document; nothing computed/invented.
#  - SOURCE HIERARCHY: the firm's own Financial Analysis PDFs (role 'financials')
#    are underwriting; OM "projected returns" are BROKER PRO-FORMA. By default,
#    deal fields fill only from internal docs; broker-OM-only deals get a
#    Discussion comment with the numbers instead (opt in with -IncludeBrokerProforma).
#  - NEVER CLOBBER: only NULL fields are filled (analyst entries win); -Force overrides.
#  - AUDIT TRAIL: every fill posts a [AI] Discussion comment citing file + page +
#    confidence so the team reviews before relying.
#
#   DEFAULT = DRY RUN (shows candidate docs per deal).  -Apply to extract + write.
param(
  [switch]$Apply,
  [switch]$IncludeBrokerProforma,
  [switch]$Force,
  [string]$DealFilter,
  [string]$Model = 'claude-sonnet-5'
)
$ErrorActionPreference = "Stop"
$repo = "C:\Users\pskontos\Desktop\Software\cre-platform"
$cfg = @{}; foreach ($ln in (Get-Content "$repo\.env" | Where-Object { $_ -match "=" })) { $a,$b = $ln -split '=',2; $cfg[$a.Trim()]=$b.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $AK = $cfg['SUPABASE_SECRET_KEY']; $ANTH = $cfg['ANTHROPIC_API_KEY']
$enc = New-Object System.Text.UTF8Encoding($false)
$TMP = "$env:TEMP\_uw_post.json"

$FIELDS = @('proj_irr','equity_multiple','avg_coc','hold_years','exit_cap','stabilized_yield','equity_required','total_capitalization')

function Sign([string]$spath){
  $b = '{"expiresIn":3600}'
  [System.IO.File]::WriteAllText($TMP,$b,$enc)
  $r = & curl.exe -s -X POST "$BASE/storage/v1/object/sign/documents/$spath" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" --data-binary "@$TMP" | ConvertFrom-Json
  if(-not $r.signedURL){ throw "sign failed for $spath" }
  return "$BASE/storage/v1$($r.signedURL)"
}

# Claude forced-tool extraction over N attached PDF urls. Stepped degradation:
# on a page/size-cap error, drop the largest attachment and retry.
function Extract-Underwriting($docs){
  $work = @($docs)
  while($work.Count -gt 0){
    $content = @()
    foreach($doc in $work){ $content += @{ type='document'; source=@{ type='url'; url=(Sign $doc.storage_path) } } }
    $content += @{ type='text'; text=@"
You are an acquisitions analyst at M&J Wilkow. The attached PDF(s) belong to ONE deal: $($work[0].deal_name). Attached files: $(($work | ForEach-Object { '"' + $_.title + '" [' + $_.kind + ']' }) -join ', ').

Extract the deal-level PROJECTED (underwritten) LEVERED return metrics. Rules:
- EXTRACT ONLY values stated in the documents. NEVER compute, derive, or estimate a number yourself. A field the documents don't state = null.
- Prefer the BASE CASE over any upside/downside scenario.
- Percentages as decimals (12.4% -> 0.124). Dollars as plain numbers.
- source_kind: 'internal_model' if the figures come from M&J Wilkow's own financial analysis / underwriting file, 'broker_om' if they come from a broker offering memorandum's pro-forma. If both exist, use the INTERNAL figures and say so.
- Call the report_underwriting tool with exactly:
{"found": bool, "source_kind": "internal_model"|"broker_om"|null, "source_file": str|null, "source_page": int|null,
 "confidence": "high"|"medium"|"low"|null, "proj_irr": num|null, "equity_multiple": num|null, "avg_coc": num|null,
 "hold_years": num|null, "exit_cap": num|null, "stabilized_yield": num|null, "equity_required": num|null,
 "total_capitalization": num|null, "note": str|null}
"@ }
    $body = @{ model=$Model; max_tokens=800
      tools=@(@{ name='report_underwriting'; description='Report extracted underwriting metrics.'; input_schema=@{ type='object'; additionalProperties=$true } })
      tool_choice=@{ type='tool'; name='report_underwriting' }
      messages=@(@{ role='user'; content=$content }) } | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($TMP,$body,$enc)
    $resp = & curl.exe -s "https://api.anthropic.com/v1/messages" -H "x-api-key: $ANTH" -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json" --data-binary "@$TMP" | ConvertFrom-Json
    if($resp.error){
      if($resp.error.message -match 'page|too large|too long|exceed' -and $work.Count -gt 1){
        $work = @($work | Sort-Object { [long]$_.file_size_bytes } | Select-Object -First ($work.Count-1))
        continue
      }
      throw ("anthropic: " + $resp.error.message)
    }
    $tu = $resp.content | Where-Object { $_.type -eq 'tool_use' } | Select-Object -First 1
    if(-not $tu){ throw "no tool_use in response" }
    return $tu.input
  }
  return $null
}

# Many deals keep underwriting ONLY in Excel CF models (xlsx) + ARGUS binaries.
# Claude can't read xlsx natively -> print the model's summary sheets to PDF via
# Excel COM, upload it (role 'financials', "(print)") so it's ALSO viewable
# in-app, and extract from that. ARGUS .avux stays unreadable.
$SHEET_RE = 'summary|return|assumption|annual|cash ?flow|cf|sources|uses'
function Convert-ModelToPdf([string]$xlsxPath, [string]$outPdf){
  $xl = New-Object -ComObject Excel.Application
  $xl.Visible=$false; $xl.DisplayAlerts=$false; $xl.AskToUpdateLinks=$false
  try {
    $wb = $xl.Workbooks.Open($xlsxPath, 0, $true)   # no link update, read-only
    $names = @(); foreach($ws in $wb.Worksheets){ if($ws.Visible -eq -1){ $names += $ws.Name } }
    $pick = @($names | Where-Object { $_ -match $SHEET_RE } | Select-Object -First 4)
    if($pick.Count -eq 0){ $pick = @($names | Select-Object -First 2) }
    $wb.Worksheets.Item($pick[0]).Select()
    for($i=1;$i -lt $pick.Count;$i++){ $wb.Worksheets.Item($pick[$i]).Select($false) }
    $xl.ActiveSheet.ExportAsFixedFormat(0, $outPdf)   # exports the selected sheets
    $wb.Close($false)
    return $pick
  } finally { $xl.Quit(); [System.Runtime.Interopservices.Marshal]::ReleaseComObject($xl) | Out-Null }
}

function Upload-Doc([string]$dealId, [string]$localPdf, [string]$title, [string]$srcPath, [string]$role){
  $spath = "pipeline/$dealId/mirror/_extracted/" + (([IO.Path]::GetFileName($localPdf)) -replace '[^\w.\-]+','_')
  $uc = & curl.exe -s -o NUL -w "%{http_code}" -X POST "$BASE/storage/v1/object/documents/$spath" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/pdf" -H "x-upsert: true" --data-binary "@$localPdf"
  if([int]$uc -lt 200 -or [int]$uc -ge 300){ throw "upload failed HTTP $uc" }
  $docBody = @{ title=$title; file_name=[IO.Path]::GetFileName($localPdf); file_path=$srcPath; storage_path=$spath;
    doc_type='other'; file_size_bytes=[long](Get-Item $localPdf).Length; property_id=$null } | ConvertTo-Json
  [System.IO.File]::WriteAllText($TMP,$docBody,$enc)
  $docResp = & curl.exe -s -X POST "$BASE/rest/v1/documents" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" -H "Prefer: return=representation" --data-binary "@$TMP" | ConvertFrom-Json
  if(-not $docResp -or -not $docResp[0].id){ throw "documents row failed" }
  $lnk = @{ deal_id=$dealId; document_id=$docResp[0].id; role=$role } | ConvertTo-Json
  [System.IO.File]::WriteAllText($TMP,$lnk,$enc)
  & curl.exe -s -o NUL -X POST "$BASE/rest/v1/pipeline_deal_documents" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" -H "Prefer: return=minimal" --data-binary "@$TMP" | Out-Null
  return @{ storage_path=$spath; title=$title; file_size_bytes=[long](Get-Item $localPdf).Length }
}

# Newest CF model ON DISK (the live K: folder), per user 2026-07-11: "use the
# latest updated one". Disk-first beats mirrored-only — the mirror's bulk cap can
# drop models, and a fresh model may postdate the last mirror run.
$MODEL_NAME_RE = 'cf model|cash ?flow|underwrit|model|argus'
$MODEL_EXCL_RE = 'invoice|reconcil|occupanc|tax|sales|budget|rent ?roll|parking'
function Get-DiskModel([string]$folderPath){
  if(-not $folderPath -or -not (Test-Path -LiteralPath $folderPath)){ return $null }
  $hits = @(Get-ChildItem -LiteralPath $folderPath -Recurse -File -Depth 4 -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -match '^\.xlsx?$' -and -not $_.Name.StartsWith('~$') `
      -and $_.Name -match $MODEL_NAME_RE -and $_.Name -notmatch $MODEL_EXCL_RE })
  if($hits.Count -eq 0){ return $null }
  return ($hits | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
}

$fieldSel = ($FIELDS -join ',')
$deals = & curl.exe -s "$BASE/rest/v1/pipeline_deals?select=id,name,folder_path,$fieldSel&limit=100" -H "apikey: $AK" -H "Authorization: Bearer $AK" | ConvertFrom-Json
if($DealFilter){ $deals = @($deals | Where-Object { $_.name -like "*$DealFilter*" }) }
Write-Output ("Deals: {0}   mode: {1}" -f $deals.Count, $(if($Apply){'APPLY'}else{'DRY RUN'}))

$filled=0; $commented=0; $noDocs=0
foreach($d in $deals){
  # fully-filled deals need nothing (also prevents duplicate audit comments on re-runs)
  $blank = @($FIELDS | Where-Object { $null -eq $d.$_ })
  if($blank.Count -eq 0){ continue }
  $links = & curl.exe -s "$BASE/rest/v1/pipeline_deal_documents?deal_id=eq.$($d.id)&select=role,documents(title,file_name,file_path,storage_path,file_size_bytes)" -H "apikey: $AK" -H "Authorization: Bearer $AK" | ConvertFrom-Json
  $pdf = @($links | Where-Object { $_.documents.file_name -match '\.pdf$' -and $_.documents.title -notmatch '^\xAB' })

  # Ordered extraction attempts (user 2026-07-11: "use the latest updated one"):
  #   1. newest CF model ON DISK -> Excel-print -> extract (a prior print of the
  #      SAME model is reused; a newer model gets a fresh print)
  #   2. internal financial PDFs
  #   3. broker OM (comment-only unless -IncludeBrokerProforma)
  $attempts = @()
  $dm = Get-DiskModel ([string]$d.folder_path)
  if($dm){
    $printTitle = ([IO.Path]::GetFileNameWithoutExtension($dm.Name)) + ' (print)'
    $existingPrint = @($pdf | Where-Object { $_.documents.title -eq $printTitle } | Select-Object -First 1)
    if($existingPrint.Count -gt 0){
      $attempts += @{ tag=("disk model " + $dm.Name); broker=$false; cand=@($existingPrint[0]) }
    } elseif($Apply){
      try {
        $localPdf = Join-Path $env:TEMP (([IO.Path]::GetFileNameWithoutExtension($dm.Name)) + '_print.pdf')
        Write-Output ("    converting newest disk model: '{0}' (updated {1:MM/dd/yy})" -f $dm.Name, $dm.LastWriteTime)
        $sheets = Convert-ModelToPdf $dm.FullName $localPdf
        $up = Upload-Doc $d.id $localPdf $printTitle $dm.FullName 'financials'
        Write-Output ("    converted sheets [{0}] -> viewable print" -f ($sheets -join ', '))
        $attempts += @{ tag=("disk model " + $dm.Name); broker=$false; cand=@([pscustomobject]@{ role='financials'; documents=[pscustomobject]$up }) }
      } catch { Write-Output ("    !! model conversion failed: {0}" -f $_.Exception.Message) }
    } else {
      $attempts += @{ tag=("disk model " + $dm.Name + " [would convert]"); broker=$false; cand=@() }
    }
  }
  $internal = @($pdf | Where-Object { $_.role -eq 'financials' -and $_.documents.title -notmatch '\(print\)$' } | Sort-Object { [long]$_.documents.file_size_bytes } | Select-Object -First 3)
  if($internal.Count -gt 0){ $attempts += @{ tag='internal PDFs'; broker=$false; cand=$internal } }
  $omdocs = @($pdf | Where-Object { $_.role -eq 'om' } | Sort-Object { [long]$_.documents.file_size_bytes } -Descending | Select-Object -First 1)
  if($omdocs.Count -gt 0){ $attempts += @{ tag='broker OM'; broker=$true; cand=$omdocs } }

  if($attempts.Count -eq 0){ Write-Output ("  {0}: no candidate documents" -f $d.name); $noDocs++; continue }
  Write-Output ("  {0}: {1}" -f $d.name, (($attempts | ForEach-Object { $_.tag }) -join ' -> '))
  if(-not $Apply){ continue }

  $r = $null; $brokerAttempt = $false
  foreach($att in $attempts){
    if(@($att.cand).Count -eq 0){ continue }
    $docs = @($att.cand | ForEach-Object { @{ storage_path=$_.documents.storage_path; title=$_.documents.title; file_size_bytes=$_.documents.file_size_bytes; kind=$(if($att.broker){'broker offering memorandum'}else{'M&J Wilkow internal financial analysis'}); deal_name=$d.name } })
    try { $r = Extract-Underwriting $docs } catch { Write-Output ("    !! extraction failed ({0}): {1}" -f $att.tag, $_.Exception.Message); $r = $null; continue }
    if($r -and $r.found){ $brokerAttempt = [bool]$att.broker; break }
    Write-Output ("    -> nothing stated in {0}" -f $att.tag)
    $r = $null
  }
  if(-not $r){ Write-Output "    -> no stated return metrics found in any source"; continue }

  # decide whether fields get written
  $isBroker = ($r.source_kind -eq 'broker_om') -or $brokerAttempt
  $writeFields = (-not $isBroker) -or $IncludeBrokerProforma

  $patch = @{}
  $summaryBits = @()
  foreach($f in $FIELDS){
    $v = $r.$f
    if($null -eq $v){ continue }
    $summaryBits += ("{0}={1}" -f $f, $v)
    $cur = $d.$f
    if($writeFields -and ($Force -or $null -eq $cur)){ $patch[$f] = $v }
  }
  if($summaryBits.Count -eq 0){ Write-Output "    -> found nothing statable"; continue }

  if($patch.Count -gt 0){
    $patch['updated_at'] = (Get-Date).ToUniversalTime().ToString('o')
    $pj = $patch | ConvertTo-Json
    [System.IO.File]::WriteAllText($TMP,$pj,$enc)
    $pc = & curl.exe -s -o NUL -w "%{http_code}" -X PATCH "$BASE/rest/v1/pipeline_deals?id=eq.$($d.id)" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" -H "Prefer: return=minimal" --data-binary "@$TMP"
    if([int]$pc -lt 200 -or [int]$pc -ge 300){ Write-Output "    !! PATCH failed HTTP $pc"; continue }
    $filled++
  }

  # audit-trail comment. Three cases:
  #   filled            -> post the fill record
  #   internal, no diff -> the fields already held these values; nothing to say
  #   broker-only       -> post ONCE (skip if an [AI] comment already exists)
  $srcLine = "{0}{1}" -f $r.source_file, $(if($r.source_page){", p.$($r.source_page)"}else{''})
  $bodyTxt = $null
  if($patch.Count -gt 0){
    $bodyTxt = "[AI] Underwriting auto-filled from $($(if($isBroker){'BROKER PRO-FORMA'}else{'internal model'})): $srcLine (confidence: $($r.confidence)). Values: $($summaryBits -join ', '). $(if($r.note){$r.note+' '})Review on the Underwriting tab before relying."
  } elseif($isBroker) {
    $prior = & curl.exe -s "$BASE/rest/v1/pipeline_deal_comments?deal_id=eq.$($d.id)&body=like.%5BAI%5D*&select=id&limit=1" -H "apikey: $AK" -H "Authorization: Bearer $AK" | ConvertFrom-Json
    if(@($prior).Count -eq 0){
      $bodyTxt = "[AI] Return metrics found in BROKER PRO-FORMA only ($srcLine, confidence: $($r.confidence)): $($summaryBits -join ', '). NOT written to the deal - enter on the Underwriting tab if appropriate, or re-run with -IncludeBrokerProforma."
    }
  }
  if($bodyTxt){
    $cj = @{ deal_id=$d.id; body=$bodyTxt; author_id=$null } | ConvertTo-Json
    [System.IO.File]::WriteAllText($TMP,$cj,$enc)
    & curl.exe -s -o NUL -X POST "$BASE/rest/v1/pipeline_deal_comments" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" -H "Prefer: return=minimal" --data-binary "@$TMP" | Out-Null
    $commented++
  }
  Write-Output ("    -> {0} [{1}] {2}" -f $(if($patch.Count){'FILLED ' + (($patch.Keys | Where-Object { $_ -ne 'updated_at' } | Sort-Object) -join ',')}elseif($isBroker){'broker pro-forma (comment-only)'}else{'no change (values already set)'}), $r.confidence, $srcLine)
}
Write-Output ("SUMMARY: {0} deals filled, {1} audit comments, {2} without candidate docs." -f $filled, $commented, $noDocs)
