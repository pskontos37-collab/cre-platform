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
  [string]$DocSubtype = '',             # '' = ANY subtype = the whole textless corpus. SEE THE WARNING BELOW.
  [string]$StoragePrefix = 'p/',        # 'pipeline/' reaches deal-mirrored docs the p/ default cannot see
  [int]$Shard = 0, [int]$Of = 1,
  [int]$Limit = 0,
  [int]$DelayMs = 300,
  [int]$PageBatch = 100,                # docs over OCR_MAX_PAGES are retried in ranged slices of this size (0 = off)
  [switch]$NoResume,                    # ignore the done-files; retry docs a prior run marked done
  [switch]$Embed                        # default = skipEmbed (backfill later); -Embed to vectorize inline
)
# WARNING: SCOPE THIS RUN OR IT WILL SPEND REAL MONEY. Unlike reindex_text.ps1, which is
# free (unpdf in-worker), every document here is a paid Claude-vision transcription.
# Measured 2026-07-30: 3,467 documents corpus-wide have no kind='text' chunk, 2,319 of
# them under the default 'p/' prefix. Running this with no -DocSubtype therefore OCRs
# 2,319 docs, not the handful you probably mean - about 150x the lease-original backlog
# of 15. ALWAYS pass -DocSubtype (and/or -PropertyId), and prove the target count from
# the "OCR TARGETS" line below BEFORE letting it run unattended.
# WARNING: -StoragePrefix exists because 'p/' is the corpus mirror only. Deal documents live
# under 'pipeline/<deal>/mirror/...' and are invisible to the default - that alone hid
# 8 textless lease originals from every prior pass, and still hides 1 of the current 15.
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
  $sel = "select=id,storage_path,property_id" + $amp + "storage_path=like.$StoragePrefix*" + $amp + "order=id.asc" + $amp + "limit=1000" + $amp + "offset=$off"
  if ($PropertyId -ne 'all') { $sel = $sel + $amp + "property_id=eq.$PropertyId" }
  if ($DocSubtype -ne '')    { $sel = $sel + $amp + "doc_subtype=eq.$DocSubtype" }
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
# -NoResume drops the done-files only. The DB half of the skip set (docs that already
# have a kind='text' chunk) still applies, so a NoResume run re-attempts exactly the
# docs that have no text - it does not re-OCR and re-bill the whole corpus.
if (-not $NoResume) {
  foreach ($df in (Get-ChildItem "$PSScriptRoot\ocr_text_done_s*.txt" -ErrorAction SilentlyContinue)) {
    foreach ($id in (Get-Content $df.FullName)) { if ($id) { [void]$skip.Add($id.Trim()) } }
  }
} else {
  Log "-NoResume: ignoring done-files; DB text-chunk skip still applies"
}
Log "skip set (has text / done): $($skip.Count) - OCR targets the rest"

# State the paid workload BEFORE spending anything. Every target below is a billed
# Claude-vision call, so this count is the number to sanity-check against what you
# intended - an unscoped run reaches into the thousands.
$targets = 0
for ($t = 0; $t -lt $docs.Count; $t++) {
  if (($t % $Of) -ne $Shard) { continue }
  if ($skip.Contains([string]$docs[$t].id)) { continue }
  $targets++
}
$plan = $targets
if ($Limit -gt 0 -and $Limit -lt $targets) { $plan = $Limit }
Log "OCR TARGETS: $targets doc(s) [prefix='$StoragePrefix' subtype='$(if($DocSubtype){$DocSubtype}else{'ANY'})' property='$PropertyId'] - will process $plan this run (PAID Claude-vision calls)"

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
    $rangedChunks = 0
    $rangedFail = 0

    # A doc over OCR_MAX_PAGES returns too_large WITHOUT transcribing anything, so
    # without this retry it is simply never OCR'd. pdf-extract accepts ?pageStart/
    # ?pageEnd (span must be <= OCR_MAX_PAGES) and SPLICES each slice into the text
    # layer - the delete is scoped to the range, so slices accumulate instead of
    # overwriting one another. Measured 2026-07-30: 7 of 13 lease originals were
    # stuck here at 102-213 pages.
    if ($r.too_large -and $PageBatch -gt 0 -and [int]$r.page_count -gt 0) {
      $pc = [int]$r.page_count
      Log "idx=$idx too-large $pc pg -> ranged OCR in slices of $PageBatch"
      for ($ps = 1; $ps -le $pc; $ps += $PageBatch) {
        $pe = [Math]::Min($ps + $PageBatch - 1, $pc)
        $rqs = $qs + $amp + "pageStart=$ps" + $amp + "pageEnd=$pe"
        try {
          $rr = Invoke-RestMethod -Method Post -Uri "$BASE/functions/v1/pdf-extract?$rqs" -Headers $H -UserAgent $UA -TimeoutSec 280
          $rangedChunks += [int]$rr.text_chunks
          Log "   pages $ps-$pe OK $($rr.text_chunks) chunks"
        } catch {
          $rangedFail++
          $rm = $_.Exception.Message
          $rp = $_.Exception.Response
          if ($rp) { try { $rs = New-Object IO.StreamReader($rp.GetResponseStream()); $rm = $rs.ReadToEnd() } catch {} }
          Log "   pages $ps-$pe FAIL :: " + (($rm -replace '\s+', ' ').Substring(0, [Math]::Min(160, $rm.Length)))
        }
        if ($DelayMs -gt 0) { Start-Sleep -Milliseconds $DelayMs }
      }
      if ($rangedChunks -gt 0) { $okChunks += $rangedChunks } else { $big++ }
    }
    elseif ($r.too_large) { $big++ }

    if ($r.empty) { $empty++ }
    $okChunks += [int]$r.text_chunks

    # Only mark done when the doc actually got text (or is genuinely empty). Marking a
    # too-large doc done - which this used to do unconditionally - permanently hides it
    # from every later run, which is how one of these went unprocessed for a whole pass.
    if (([int]$r.text_chunks + $rangedChunks) -gt 0 -or $r.empty) {
      "$($d.id)" | Out-File $done -Append -Encoding utf8
    }

    $tag = "$($r.text_chunks) chunks"
    if ($r.truncated) { $tag = "$tag TRUNC" }
    if ($r.empty) { $tag = 'empty' }
    if ($r.too_large) { $tag = "too-large $($r.page_count) pg -> ranged $rangedChunks chunks ($rangedFail slice fails)" }
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
