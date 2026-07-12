# render_site_plans.ps1 - pre-rasterizes each deal's site-plan PDF to a stored
# JPEG so the meeting deck can embed it INSTANTLY (client-side pdf.js can't
# rasterize these vector-dense OM site plans fast enough - it renders on the
# browser main thread at >15s each). Uses qpdf to normalize (WinRT's PDF loader
# rejects the qpdf-clipped originals: HRESULT 0x80048040) then Windows' built-in
# Windows.Data.Pdf engine to render, then System.Drawing to JPEG-encode. ~0.4s/plan.
#
# Output: storage pipeline/<dealId>/siteplan_img/plan.jpg + a documents row +
# a pipeline_deal_documents link role='site_plan_img' (fetchDeckExtras reads it).
#
#   Idempotent: skips deals that already have a site_plan_img link unless -Force.
param([switch]$Force, [string]$DealFilter, [int]$Width = 1600)
$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\pskontos\Desktop\Software\cre-platform'
$cfg = @{}; foreach ($ln in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $a,$b = $ln -split '=',2; $cfg[$a.Trim()]=$b.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $AK = $cfg['SUPABASE_SECRET_KEY']
$enc = New-Object System.Text.UTF8Encoding($false); $TMP = "$env:TEMP\_sp_post.json"
$qpdf = (Get-ChildItem -Path "$env:TEMP\claude" -Recurse -Filter qpdf.exe -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
if (-not $qpdf) { throw 'qpdf.exe not found under the claude scratchpad tree' }

Add-Type -AssemblyName System.Runtime.WindowsRuntime; Add-Type -AssemblyName System.Drawing
$rt = [System.WindowsRuntimeSystemExtensions]
$asOp  = $rt.GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 } | Select-Object -First 1
$asAct = $rt.GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
function AwaitOp($op,$t){ $task=$asOp.MakeGenericMethod($t).Invoke($null,@($op)); [void]$task.Wait(-1); $task.Result }
function AwaitAct($op){ $task=$asAct.Invoke($null,@($op)); [void]$task.Wait(-1) }
[Windows.Data.Pdf.PdfDocument,Windows.Data.Pdf,ContentType=WindowsRuntime]|Out-Null
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]|Out-Null
[Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]|Out-Null
$jpgEnc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }

# normalize (qpdf) -> WinRT render page 0 -> JPEG bytes
function Render-Jpeg([string]$pdfPath, [int]$w){
  $norm = "$env:TEMP\_sp_norm.pdf"
  & $qpdf --decrypt --object-streams=disable --recompress-flate $pdfPath $norm 2>$null
  if ($LASTEXITCODE -ne 0 -and -not (Test-Path $norm)) { throw "qpdf failed ($LASTEXITCODE)" }
  $src = if (Test-Path $norm) { $norm } else { $pdfPath }
  $file = AwaitOp ([Windows.Storage.StorageFile]::GetFileFromPathAsync($src)) ([Windows.Storage.StorageFile])
  $pdf  = AwaitOp ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
  $page = $pdf.GetPage(0)
  $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions; $opts.DestinationWidth = [uint32]$w
  $ras  = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  AwaitAct ($page.RenderToStreamAsync($ras, $opts)); $page.Dispose()
  $sz = [uint32]$ras.Size; $dr = New-Object Windows.Storage.Streams.DataReader($ras.GetInputStreamAt(0))
  [void](AwaitOp ($dr.LoadAsync($sz)) ([uint32])); $bmpBuf = New-Object byte[] $sz; $dr.ReadBytes($bmpBuf)
  $img = [System.Drawing.Image]::FromStream((New-Object IO.MemoryStream(,$bmpBuf)))
  $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality,[long]75)
  $outJpg = "$env:TEMP\_sp_out.jpg"; $img.Save($outJpg, $jpgEnc, $ep); $img.Dispose()
  Remove-Item $norm -ErrorAction SilentlyContinue
  return $outJpg
}

# every site_plan link, grouped per deal (smallest = the clean single-page plan)
$links = & curl.exe -s "$BASE/rest/v1/pipeline_deal_documents?role=eq.site_plan&select=deal_id,documents(title,storage_path,file_size_bytes),pipeline_deals(name,stage)" -H "apikey: $AK" -H "Authorization: Bearer $AK" | ConvertFrom-Json
$byDeal = @{}
foreach ($l in $links) {
  if (-not $l.documents.storage_path) { continue }
  $st = $l.pipeline_deals.stage
  if ($st -in @('tracking','passed','dead','lost')) { continue }
  $cur = $byDeal[$l.deal_id]
  if (-not $cur -or [long]$l.documents.file_size_bytes -lt [long]$cur.documents.file_size_bytes) { $byDeal[$l.deal_id] = $l }
}
Write-Output ("Site-plan deals: {0}   width: {1}   {2}" -f $byDeal.Count, $Width, $(if($Force){'FORCE'}else{'skip-if-done'}))

$done=0; $skip=0; $fail=0
foreach ($dealId in $byDeal.Keys) {
  $l = $byDeal[$dealId]; $name = $l.pipeline_deals.name
  if ($DealFilter -and $name -notlike "*$DealFilter*") { continue }
  $existing = & curl.exe -s "$BASE/rest/v1/pipeline_deal_documents?deal_id=eq.$dealId&role=eq.site_plan_img&select=id&limit=1" -H "apikey: $AK" -H "Authorization: Bearer $AK" | ConvertFrom-Json
  if (@($existing).Count -gt 0 -and -not $Force) { Write-Output ("  {0}: already rendered" -f $name); $skip++; continue }
  try {
    $dl = "$env:TEMP\_sp_src.pdf"
    $code = & curl.exe -s -o $dl -w "%{http_code}" "$BASE/storage/v1/object/documents/$($l.documents.storage_path)" -H "apikey: $AK" -H "Authorization: Bearer $AK"
    if ([int]$code -ne 200) { throw "download HTTP $code" }
    $jpg = Render-Jpeg $dl $Width
    $spath = "pipeline/$dealId/siteplan_img/plan.jpg"
    $uc = & curl.exe -s -o NUL -w "%{http_code}" -X POST "$BASE/storage/v1/object/documents/$spath" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: image/jpeg" -H "x-upsert: true" --data-binary "@$jpg"
    if ([int]$uc -lt 200 -or [int]$uc -ge 300) { throw "upload HTTP $uc" }
    if (@($existing).Count -eq 0) {
      $docBody = @{ title=("Site plan (rendered) - " + $name); file_name='plan.jpg'; storage_path=$spath; doc_type='site_plan'; file_size_bytes=[long](Get-Item $jpg).Length; property_id=$null } | ConvertTo-Json
      [System.IO.File]::WriteAllText($TMP,$docBody,$enc)
      $doc = & curl.exe -s -X POST "$BASE/rest/v1/documents" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" -H "Prefer: return=representation" --data-binary "@$TMP" | ConvertFrom-Json
      if (-not $doc[0].id) { throw 'documents row failed' }
      $lnk = @{ deal_id=$dealId; document_id=$doc[0].id; role='site_plan_img' } | ConvertTo-Json
      [System.IO.File]::WriteAllText($TMP,$lnk,$enc)
      & curl.exe -s -o NUL -X POST "$BASE/rest/v1/pipeline_deal_documents" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" -H "Prefer: return=minimal" --data-binary "@$TMP" | Out-Null
    }
    Write-Output ("  {0}: rendered {1}KB -> {2}" -f $name, [int]((Get-Item $jpg).Length/1KB), $spath); $done++
  } catch { Write-Output ("  {0}: FAIL {1}" -f $name, $_.Exception.Message); $fail++ }
}
Write-Output ("SUMMARY: {0} rendered, {1} skipped, {2} failed." -f $done, $skip, $fail)
