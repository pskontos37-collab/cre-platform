# reindex_text.ps1 - verbatim-text recall layer (see [[project-corpus-text-layer]]).
# Calls pdf-extract?reindexText=1 for corpus docs mirrored to storage, adding real
# document text (kind='text') alongside the legacy summary chunk. No Claude call -
# unpdf extracts text in-worker; only Voyage embeddings are billed. Resumable.
#
#   # whole corpus, 4 parallel shards (run each in its own window/background):
#   .\reindex_text.ps1 -Shard 0 -Of 4
#   .\reindex_text.ps1 -Shard 1 -Of 4   ... etc
#   # one property only:
#   .\reindex_text.ps1 -PropertyId 00000000-0000-0000-0000-000000000010
#
# Rollback: delete from document_chunks where kind='text';
param(
  [string]$PropertyId = 'all',          # 'all' = every property (per-doc property_id); else one property id
  [int]$Shard = 0, [int]$Of = 1,        # process docs where index % Of == Shard (parallel workers)
  [int]$Limit = 0,                      # 0 = all; >0 = stop after N (testing)
  [int]$DelayMs = 0                     # throttle: sleep between docs to protect the live prod DB
)
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }        # service token -> isServiceToken() full access
$log  = "$PSScriptRoot\reindex_text_s$Shard.log"
$done = "$PSScriptRoot\reindex_text_done_s$Shard.txt"          # resumable: processed doc ids (one per line)
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [s$Shard] $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }

# ---- Build the target doc list (paged). All docs mirrored to storage. ----
$docs = New-Object System.Collections.Generic.List[object]
$off = 0
while ($true) {
  $sel = "select=id,storage_path,property_id&storage_path=like.p/*&order=id.asc&limit=1000&offset=$off"
  if ($PropertyId -ne 'all') { $sel += "&property_id=eq.$PropertyId" }
  $page = Invoke-RestMethod -Uri "$BASE/rest/v1/documents?$sel" -Headers $H -UserAgent $UA -TimeoutSec 90
  if (-not $page -or $page.Count -eq 0) { break }
  foreach ($d in $page) { $docs.Add($d) }
  $off += 1000
  if ($page.Count -lt 1000) { break }
}
Log "corpus target: $($docs.Count) docs mirrored to storage"

# ---- Skip set: docs already text-indexed (DB) + this shard's local done file ----
$skip = New-Object System.Collections.Generic.HashSet[string]
$to = 0
while ($true) {
  $r = Invoke-RestMethod -Uri "$BASE/rest/v1/document_chunks?select=document_id&kind=eq.text&limit=1000&offset=$to" -Headers $H -UserAgent $UA -TimeoutSec 90
  if (-not $r -or $r.Count -eq 0) { break }
  foreach ($x in $r) { [void]$skip.Add($x.document_id) }
  $to += 1000
  if ($r.Count -lt 1000) { break }
}
# Load ALL shards' done-files (resume is shard-count-independent: a 2-worker
# mop-up must still skip everything the original 4 workers finished).
foreach ($df in (Get-ChildItem "$PSScriptRoot\reindex_text_done_s*.txt" -ErrorAction SilentlyContinue)) {
  foreach ($id in (Get-Content $df.FullName)) { if ($id) { [void]$skip.Add($id.Trim()) } }
}
Log "skip set (already text-indexed / done): $($skip.Count)"

$i = 0; $proc = 0; $okChunks = 0; $ocr = 0; $big = 0; $fail = 0
for ($idx = 0; $idx -lt $docs.Count; $idx++) {
  if (($idx % $Of) -ne $Shard) { continue }
  $d = $docs[$idx]
  if ($skip.Contains([string]$d.id)) { continue }
  $i++
  if ($Limit -gt 0 -and $i -gt $Limit) { break }
  $enc = [uri]::EscapeDataString("documents/$($d.storage_path)")
  $propId = if ($d.property_id) { $d.property_id } else { '' }
  # skipEmbed=1: content-only text chunks (no Voyage vector). Embedded inserts hit
  # >100s/doc of HNSW maintenance and blew the edge wall; the abstractor + FTS need
  # only content. Semantic embeddings backfilled later (backfill_text_embeddings.ps1).
  $uri = "$BASE/functions/v1/pdf-extract?reindexText=1&skipEmbed=1&storagePath=$enc&documentId=$($d.id)&propertyId=$propId"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $r = Invoke-RestMethod -Method Post -Uri $uri -Headers $H -UserAgent $UA -TimeoutSec 280
    $sw.Stop(); $proc++
    if ($r.needs_ocr) { $ocr++ }
    if ($r.too_large) { $big++ }
    $okChunks += [int]$r.text_chunks
    "$($d.id)" | Out-File $done -Append -Encoding utf8    # mark processed (resumable)
    $tag = if ($r.needs_ocr) { 'needs-ocr' } elseif ($r.too_large) { "too-large($($r.page_count)pg)" } else { "$($r.text_chunks) chunks" }
    if (($proc % 25) -eq 0 -or $r.too_large) { Log ("#$idx OK $([math]::Round($sw.Elapsed.TotalSeconds))s $tag (proc=$proc chunks=$okChunks ocr=$ocr big=$big fail=$fail)") }
  } catch {
    $sw.Stop(); $fail++
    $msg = $_.Exception.Message
    $resp = $_.Exception.Response
    if ($resp) { try { $sr = New-Object IO.StreamReader($resp.GetResponseStream()); $msg = $sr.ReadToEnd() } catch {} }
    Log ("#$idx FAIL $([math]::Round($sw.Elapsed.TotalSeconds))s :: $($d.id) :: " + (($msg -replace '\s+', ' ').Substring(0, [Math]::Min(200, $msg.Length))))
  }
  if ($DelayMs -gt 0) { Start-Sleep -Milliseconds $DelayMs }   # throttle to protect live prod DB
}
Log "SHARD DONE: processed=$proc, text chunks=$okChunks, needs-ocr=$ocr, too-large=$big, failed=$fail"
