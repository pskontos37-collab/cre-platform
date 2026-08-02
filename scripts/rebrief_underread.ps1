# rebrief_underread.ps1 - re-brief the documents whose stored brief covers only a
# FRACTION of their text.
#
# THE DEFECT. doc_briefs rows written before segmentation landed (all dated on or before
# 2026-07-23) carry segments_total = 1 for documents that need 9-23 segments at the
# current SEGMENT_CHARS = 60,000. They average 64:1 compression against a 5.9:1 median
# for correctly-segmented docs; the worst is 148:1 (971,306 chars -> a 6,553-char brief).
# Those briefs never saw most of their document. Target's $2,842,335 Section 6.3
# allowance was missed exactly this way - its brief is in this cohort at 71.5:1.
#
# Re-briefing with the CURRENT doc-brief (v9) fixes both problems at once: it segments
# properly AND populates the new allowance_effects slot.
#
# WARNING: SNAPSHOT FIRST. doc_briefs has no audit trigger and force=true overwrites
# permanently, so the run writes _briefs_before_rebrief_<ts>.json before touching
# anything. That file IS the backup - a hash would prove change without allowing repair.
#
# WARNING: FORCE ONLY ON THE FIRST CALL PER DOCUMENT. doc-brief resumes from persisted
# segments only when force is ABSENT (`resume = ... && !body.force`). Sending force on a
# resume call restarts the document from zero and it can never finish. First call sends
# force to invalidate the stale single-segment row; every later call omits it.
#
# Each invocation briefs one concurrent wave (SEGMENT_CONCURRENCY=4) and returns
# done=false with progress persisted, so a 12-segment document needs ~3 calls.
#
# Usage:  .\rebrief_underread.ps1            (all under-read docs)
#         .\rebrief_underread.ps1 -WhatIf    (list targets + exit, no spend)
#         .\rebrief_underread.ps1 -Limit 5   (first N, for a smoke test)
# Safe to re-run: docs already fixed (segments_total > 1) are skipped.
param(
  [switch]$WhatIf,
  [int]$Limit = 0,
  [int]$MaxRoundsPerDoc = 40
)
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$enc = New-Object System.Text.UTF8Encoding($false)
$log = "$PSScriptRoot\rebrief_underread.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }

function PostFn($slug, $bodyObj) {
  $body = $bodyObj | ConvertTo-Json -Compress -Depth 6
  $tmp = "$PSScriptRoot\_rebrief_body.json"
  [System.IO.File]::WriteAllText($tmp, $body, $enc)
  # -join: PS captures multi-line native output as an ARRAY; without joining, .Length is
  # the element count and the json extraction silently fails.
  $out = (& curl.exe -s -w "`n%{http_code}" -X POST "$BASE/functions/v1/$slug" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -A $UA --data-binary "@$tmp" --max-time 295) -join "`n"
  $code = ($out -split "`n")[-1]
  $json = if ($out.Length -gt $code.Length) { $out.Substring(0, $out.Length - $code.Length - 1) } else { '' }
  return @{ code = $code; json = $json }
}

# ---- 1. Targets ----
# WARNING: DO NOT filter on doc_briefs.text_chars. That column records how much text existed
# WHEN THE BRIEF WAS WRITTEN, and for this cohort that predates the OCR pass - so 60 of
# the 61 under-read docs look <=60,000 chars there and a text_chars filter finds only
# ONE of them. The real measure is the CURRENT sum of kind='text' chunks, which needs a
# SQL aggregate PostgREST cannot express. So the authoritative list is generated from SQL
# into _rebrief_targets.txt:
#   select b.document_id from doc_briefs b
#   where b.status='complete' and b.segments_total = 1
#     and ceil((select sum(length(c.content)) from document_chunks c
#               where c.document_id=b.document_id and c.kind='text')/60000.0) > 1;
# (That same stale text_chars is why doc-brief will not serve these from cache - its
# freshness check compares stored text_chars to the current length and re-briefs.)
$targetsFile = "$PSScriptRoot\_rebrief_targets.txt"
if (-not (Test-Path $targetsFile)) { throw "missing $targetsFile - regenerate it with the SQL in the comment above" }
$wanted = @(Get-Content $targetsFile | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^[0-9a-f-]{36}$' })
Log ("target list: {0} document id(s) from {1}" -f $wanted.Count, (Split-Path $targetsFile -Leaf))
# Current state, so an interrupted run can be resumed safely: skip anything already
# multi-segment (i.e. already re-briefed by an earlier pass of this script).
# WARNING: SCOPE THIS TO THE TARGET IDS. An unfiltered select on doc_briefs returns only
# PostgREST's default first page (1,000 rows) out of 4,048, so the already-completed
# documents fell outside it, $segBy came back empty for them, NOTHING was skipped, and
# the 2026-08-02 resume began force-restarting finished work - wiping 23 segments of
# progress on the first document before it was killed. Filtering by the 61 ids keeps the
# response small and makes the lookup exact regardless of table size.
$idFilter = ($wanted -join ',')
$briefs = Invoke-RestMethod -Uri "$BASE/rest/v1/doc_briefs?select=document_id,segments_total,status&document_id=in.($idFilter)" -Headers $H -UserAgent $UA -TimeoutSec 120
$segBy = @{}
foreach ($b in @($briefs)) { $segBy[[string]$b.document_id] = $b.segments_total }
Log ("state lookup returned {0} of {1} target rows" -f @($briefs).Count, $wanted.Count)
$targets = New-Object System.Collections.Generic.List[object]
foreach ($id in $wanted) {
  $seg = $segBy[[string]$id]
  if ($null -ne $seg -and $seg -gt 1) { Log ("  SKIP already re-briefed ({0} segments): {1}" -f $seg, $id); continue }
  $chars = 0
  try {
    $cs = Invoke-RestMethod -Uri "$BASE/rest/v1/document_chunks?select=content&document_id=eq.$id&kind=eq.text" -Headers $H -UserAgent $UA -TimeoutSec 300
    foreach ($c in @($cs)) { $chars += ("" + $c.content).Length }
  } catch { Log ("  WARN could not size {0}: {1}" -f $id, $_.Exception.Message) }
  $exp = if ($chars -gt 0) { [Math]::Ceiling($chars / 60000.0) } else { 1 }
  $targets.Add([pscustomobject]@{ document_id = $id; text_chars = $chars; expected = $exp })
}
$targets = @($targets | Sort-Object -Property text_chars -Descending)
if ($Limit -gt 0 -and $targets.Count -gt $Limit) { $targets = @($targets[0..($Limit-1)]) }
$totalSeg = ($targets | Measure-Object -Property expected -Sum).Sum
Log ("TARGETS: {0} document(s), {1} segments expected, {2:N0} chars (PAID Claude calls)" -f $targets.Count, $totalSeg, (($targets | Measure-Object -Property text_chars -Sum).Sum))
foreach ($t in $targets) { Log ("  {0}  {1,9:N0} chars  ~{2} segments" -f $t.document_id, $t.text_chars, $t.expected) }
if ($WhatIf) { Log '-WhatIf: stopping before any paid call'; return }
if ($targets.Count -eq 0) { Log 'nothing to do'; return }

# ---- 2. Snapshot BEFORE overwriting (this file is the only way back) ----
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$snapPath = "$PSScriptRoot\_briefs_before_rebrief_$stamp.json"
$ids = ($targets | ForEach-Object { $_.document_id }) -join ','
$before = Invoke-RestMethod -Uri "$BASE/rest/v1/doc_briefs?select=*&document_id=in.($ids)" -Headers $H -UserAgent $UA -TimeoutSec 300
[IO.File]::WriteAllText($snapPath, ($before | ConvertTo-Json -Depth 40), $enc)
Log ("snapshot saved (FULL briefs, restorable): {0}  rows={1}" -f (Split-Path $snapPath -Leaf), @($before).Count)

# ---- 3. Re-brief ----
$ok = 0; $fail = 0; $i = 0
foreach ($t in $targets) {
  $i++
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $done = $false; $round = 0; $lastErr = ''; $stall = 0; $lastSegs = -1
  while (-not $done -and $round -lt $MaxRoundsPerDoc) {
    $round++
    # force ONLY on round 1 - later rounds must omit it or the doc restarts from zero.
    $body = if ($round -eq 1) { @{ document_id = $t.document_id; force = $true } } else { @{ document_id = $t.document_id } }
    $r = PostFn 'doc-brief' $body
    if ($r.code -ne '200') {
      $lastErr = "http=$($r.code)"
      # 546/54x = edge wall-kill mid-wave; progress is persisted, so just keep looping.
      if ($r.code -match '^(000|408|409|429|5\d\d)$') { Start-Sleep -Seconds 5; continue }
      break
    }
    try {
      $o = $r.json | ConvertFrom-Json
      $done = ($o.done -eq $true)
      # A CACHED done=true is NOT a re-brief. Round 1 sends force so it cannot be cached;
      # if round 1 failed and round 2 (which omits force) finds the row still 'complete'
      # with matching text_chars, doc-brief serves the OLD brief and reports done=true.
      # That is how 722d42ab was logged OK on 2026-08-02 without being re-briefed at all.
      if ($done -and $o.cached -eq $true) { $done = $false; $lastErr = 'served from cache - not re-briefed (earlier round must have failed)'; break }
      # doc-brief now reports a PERMANENT upstream failure here (billing/auth/4xx) even
      # when some segments already landed. Resuming past it is pointless.
      if (-not $done -and $o.error) { $lastErr = "$($o.error)"; break }
      if (-not $done) {
        Log ("  [{0}/{1}] {2} segments {3}/{4}" -f $i, $targets.Count, $t.document_id, $o.segments_done, $o.segments_total)
        # STALL GUARD. Every round is a paid attempt; if two consecutive rounds add no
        # segments the cause is not going to clear by asking again. On 2026-08-02 an
        # exhausted Anthropic balance made doc-brief answer 200/done:false instantly and
        # this loop burned 40 no-op rounds per document across 53 documents.
        if ($o.segments_done -eq $lastSegs) {
          $stall++
          if ($stall -ge 2) { $lastErr = "no progress at $($o.segments_done)/$($o.segments_total) - upstream is failing, not slow"; break }
        } else { $stall = 0 }
        $lastSegs = $o.segments_done
      }
    } catch { $lastErr = 'unparseable response'; break }
  }
  $sw.Stop()
  if ($done) {
    $ok++
    Log ("OK   [{0}/{1}] {2} in {3}s ({4} round(s))" -f $i, $targets.Count, $t.document_id, [math]::Round($sw.Elapsed.TotalSeconds), $round)
  } else {
    $fail++
    Log ("FAIL [{0}/{1}] {2} after {3}s / {4} round(s) :: {5}" -f $i, $targets.Count, $t.document_id, [math]::Round($sw.Elapsed.TotalSeconds), $round, $lastErr)
  }
}
Log ("REBRIEF DONE: ok=$ok fail=$fail of {0}; snapshot {1}" -f $targets.Count, (Split-Path $snapPath -Leaf))
