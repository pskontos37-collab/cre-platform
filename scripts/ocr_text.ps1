# ocr_text.ps1 - OCR pass for scanned/image-only docs (see project-corpus-text-layer).
# Calls pdf-extract?ocrText=1 (Claude-vision verbatim transcription) for docs that
# have NO kind='text' chunk yet - i.e. what the unpdf reindex could not read
# (scanned images + pdfjs-OOM docs). Stores kind='text' chunks (skipEmbed by default;
# embeddings backfilled by backfill_text_embeddings.ps1). Resumable + shardable.
#
#   .\ocr_text.ps1 -Shard 0 -Of 4 -DelayMs 500     # full pass, 4 shards
#   .\ocr_text.ps1 -Limit 25                        # pilot: first 25 scanned docs
#
# COST: Claude Haiku transcription. Run -Limit first to gauge before the full ~3,100.
param(
  [string]$PropertyId = 'all',
  [int]$Shard = 0, [int]$Of = 1,
  [int]$Limit = 0,
  [int]$DelayMs = 300,
  [switch]$Embed                        # default = skipEmbed (backfill later); -Embed to vectorize inline
)
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$log  = "$PSScriptRoot\ocr_text_s$Shard.log"
$done = "$PSScriptRoot\ocr_text_done_s$Shard.txt"
$amp = [char]38
$skipEmbedQS = "${amp}skipEmbed=1"
if ($Embed) { $skipEmbedQS = '' }
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [ocr s$Shard] $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }

# Target docs (paged).
$docs = New-Object System.Collections.Generic.List[object]
$off = 0
while ($true) {
  $sel = "select=id,storage_path,property_id" + $amp + "storage_path=like.p/*" + $amp + "order=id.asc" + $amp + "limit=1000" + $amp + "offset=$off"
  if ($PropertyId -ne 'all') { $sel = $sel + $amp + "property_id=eq.$PropertyId" }
  $page = Invoke-RestMethod -Uri "$BASE/rest/v1/documents?$sel" -Headers $H -UserAgent $UA -TimeoutSec 90
  if (-not $page -or $page.Count -eq 0) { break }
  foreach ($d in $page) { $docs.Add($d) }
  $off += 1000
  if ($page.Count -lt 1000) { break }
}
Log "corpus target: $($docs.Count) docs"

# SKIP = docs that already have a kind='text' chunk + this pass's done-files.
$skip = New-Object System.Collections.Generic.HashSet[string]
$to = 0
while ($true) {
  $q = "select=document_id" + $amp + "kind=eq.text" + $amp + "limit=1000" + $amp + "offset=$to"
  $r = Invoke-RestMethod -Uri "$BASE/rest/v1/document_chunks?$q" -Headers $H -UserAgent $UA -TimeoutSec 90
  if (-not $r -or $r.Count -eq 0) { break }
  foreach ($x in $r) { [void]$skip.Add($x.document_id) }
  $to += 1000
  if ($r.Count -lt 1000) { break }
}
foreach ($df in (Get-ChildItem "$PSScriptRoot\ocr_text_done_s*.txt" -ErrorAction SilentlyContinue)) {
  foreach ($id in (Get-Content $df.FullName)) { if ($id) { [void]$skip.Add($id.Trim()) } }
}
Log "skip set (has text / done): $($skip.Count) - OCR targets the rest"

$i = 0; $proc = 0; $okChunks = 0; $big = 0; $empty = 0; $fail = 0
for ($idx = 0; $idx -lt $docs.Count; $idx++) {
  if (($idx % $Of) -ne $Shard) { continue }
  $d = $docs[$idx]
  if ($skip.Contains([string]$d.id)) { continue }
  $i++
  if ($Limit -gt 0 -and $i -gt $Limit) { break }
  $sp = "documents/$($d.storage_path)"
  $propId = ''
  if ($d.property_id) { $propId = $d.property_id }
  $qs = "ocrText=1" + $skipEmbedQS + $amp + "storagePath=$sp" + $amp + "documentId=$($d.id)" + $amp + "propertyId=$propId"
  $uri = "$BASE/functions/v1/pdf-extract?$qs"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $r = Invoke-RestMethod -Method Post -Uri $uri -Headers $H -UserAgent $UA -TimeoutSec 280
    $sw.Stop(); $proc++
    if ($r.too_large) { $big++ }
    if ($r.empty) { $empty++ }
    $okChunks += [int]$r.text_chunks
    "$($d.id)" | Out-File $done -Append -Encoding utf8
    $tag = "$($r.text_chunks) chunks"
    if ($r.truncated) { $tag = "$tag TRUNC" }
    if ($r.empty) { $tag = 'empty' }
    if ($r.too_large) { $tag = "too-large $($r.page_count) pg" }
    if (($proc % 20) -eq 0 -or $r.too_large) { Log ("done=$idx OK $([math]::Round($sw.Elapsed.TotalSeconds))s $tag (proc=$proc chunks=$okChunks big=$big empty=$empty fail=$fail)") }
  } catch {
    $sw.Stop(); $fail++
    $msg = $_.Exception.Message
    $resp = $_.Exception.Response
    if ($resp) { try { $sr = New-Object IO.StreamReader($resp.GetResponseStream()); $msg = $sr.ReadToEnd() } catch {} }
    Log ("idx=$idx FAIL $([math]::Round($sw.Elapsed.TotalSeconds))s :: $($d.id) :: " + (($msg -replace '\s+', ' ').Substring(0, [Math]::Min(200, $msg.Length))))
  }
  if ($DelayMs -gt 0) { Start-Sleep -Milliseconds $DelayMs }
}
Log "OCR SHARD DONE: processed=$proc, text chunks=$okChunks, too-large=$big, empty=$empty, failed=$fail"
