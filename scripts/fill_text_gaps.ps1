# fill_text_gaps.ps1 - repair PARTIAL text coverage (see [[project-corpus-text-layer]]).
#
# WHY THIS EXISTS. reindex_text.ps1 skips any document that already has kind='text'
# chunks, so a document whose paged sweep failed part-way is permanently skipped with
# incomplete coverage - it looks recovered to every "does it have text?" check. Real
# examples found 2026-07-29: JINYA Ramen Bar had text only for pages 28-51, MYEYEDR
# 4 pages spanning 4-22, 100 Chiro 39 pages spanning 32-80.
#
# The obvious ratio test (distinct text pages vs MAX text page) does NOT find these
# reliably: a document with text on pages 1-2 only scores 2/2 = perfect. Coverage has
# to be measured against the document's TRUE page count, and documents.page_count is
# NULL across the corpus. So this script asks pdf-extract for the page count with a
# 1-page ranged probe (MuPDF counts pages without loading the file), and PERSISTS it to
# documents.page_count so future audits are a plain SQL query instead of 385 probes.
#
# Safe to re-run. pdf-extract v37's ranged delete is scoped to the requested pages, so
# filling a gap cannot disturb pages that already extracted.
#
#   .\fill_text_gaps.ps1 -DocSubtype lease_original -WhatIf     # report only
#   .\fill_text_gaps.ps1 -DocSubtype lease_original
param(
  [string]$DocSubtype = 'lease_original',
  [string]$StoragePrefix = 'p/',
  [int]$PageBatch = 8,          # gap slice size; halved automatically on OOM
  [int]$MinGap = 1,             # ignore gaps smaller than this many pages
  [int]$DelayMs = 150,
  [int]$Limit = 0,
  [switch]$WhatIf               # measure and report; write nothing
)
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$HP = @{ apikey = $KEY; Authorization = "Bearer $KEY"; Prefer = 'return=minimal' }
$log = "$PSScriptRoot\fill_text_gaps.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }

# ---- candidates: documents that HAVE text chunks (the ones reindex_text will skip) ----
$docs = New-Object System.Collections.Generic.List[object]
$off = 0
while ($true) {
  $sel = "select=id,storage_path,property_id,page_count&storage_path=like.$StoragePrefix*&order=id.asc&limit=1000&offset=$off"
  if ($DocSubtype -ne '') { $sel += "&doc_subtype=eq.$DocSubtype" }
  $page = Invoke-RestMethod -Uri "$BASE/rest/v1/documents?$sel" -Headers $H -UserAgent $UA -TimeoutSec 90
  if (-not $page -or $page.Count -eq 0) { break }
  foreach ($d in $page) { $docs.Add($d) }
  $off += 1000
  if ($page.Count -lt 1000) { break }
}
Log "candidates with prefix '$StoragePrefix' subtype '$DocSubtype': $($docs.Count)"

function GetTextPages($docId) {
  $set = New-Object System.Collections.Generic.HashSet[int]
  $o = 0
  while ($true) {
    $r = Invoke-RestMethod -Uri "$BASE/rest/v1/document_chunks?select=page_number&document_id=eq.$docId&kind=eq.text&limit=1000&offset=$o" -Headers $H -UserAgent $UA -TimeoutSec 90
    if (-not $r -or $r.Count -eq 0) { break }
    foreach ($x in $r) { if ($null -ne $x.page_number) { [void]$set.Add([int]$x.page_number) } }
    if ($r.Count -lt 1000) { break }
    $o += 1000
  }
  # `return $set` would be WRONG: PowerShell ENUMERATES a collection on function output,
  # so a set of one page came back as a bare [int] and `$have.Contains($i)` threw
  # "[System.Int32] does not contain a method named 'Contains'". With
  # $ErrorActionPreference='Continue' that failed per-document and silently skewed the
  # tally - the first -WhatIf run reported 348 examined but only 167 accounted for.
  # The unary comma wraps it so the HashSet survives as one object.
  return ,$set
}

$examined = 0; $repaired = 0; $filledChunks = 0; $noGap = 0; $skipped = 0; $dead = 0
foreach ($d in $docs) {
  if ($Limit -gt 0 -and $examined -ge $Limit) { break }
  $have = GetTextPages $d.id
  if ($null -eq $have -or $have.Count -eq 0) { $skipped++; continue }   # zero text: reindex_text's job
  if ($have -isnot [System.Collections.Generic.HashSet[int]]) {
    # Defensive: never let a non-set through to .Contains() again.
    $tmp = New-Object System.Collections.Generic.HashSet[int]
    foreach ($v in @($have)) { [void]$tmp.Add([int]$v) }
    $have = $tmp
  }
  $examined++
  $enc = [uri]::EscapeDataString("documents/$($d.storage_path)")
  $uri = "$BASE/functions/v1/pdf-extract?reindexText=1&skipEmbed=1&storagePath=$enc&documentId=$($d.id)&propertyId=$($d.property_id)"

  # True page count: use the stored value if present, else a 1-page probe, then persist it.
  $total = 0
  if ($d.page_count) { $total = [int]$d.page_count }
  if ($total -le 0) {
    try {
      $p = Invoke-RestMethod -Method Post -Uri "$uri&pageStart=1&pageEnd=1" -Headers $H -UserAgent $UA -TimeoutSec 280
      $total = [int]$p.page_count
      if ($total -gt 0 -and -not $WhatIf) {
        $body = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json @{ page_count = $total } -Compress))
        try { Invoke-RestMethod -Method Patch -Uri "$BASE/rest/v1/documents?id=eq.$($d.id)" -Headers $HP -ContentType 'application/json' -Body $body -UserAgent $UA -TimeoutSec 90 | Out-Null } catch {}
      }
      if ($p.text_chunks) { [void]$have.Add(1) }
    } catch { Log "probe failed :: $($d.id)"; continue }
  }
  if ($total -le 0) { continue }

  # Missing pages -> consecutive ranges.
  $missing = @(); for ($i = 1; $i -le $total; $i++) { if (-not $have.Contains($i)) { $missing += $i } }
  if ($missing.Count -eq 0) { $noGap++; continue }
  # NOTE the Count guard: with exactly one missing page, $missing[1..0] does NOT yield an
  # empty slice in PowerShell - the range 1..0 counts DOWN, so it returns index 1 (null)
  # and index 0, which would emit a bogus range and re-emit the real one.
  $ranges = @(); $s = $missing[0]; $prev = $missing[0]
  if ($missing.Count -gt 1) {
    foreach ($m in $missing[1..($missing.Count - 1)]) {
      if ($m -eq $prev + 1) { $prev = $m; continue }
      $ranges += ,@($s, $prev); $s = $m; $prev = $m
    }
  }
  $ranges += ,@($s, $prev)
  $ranges = @($ranges | Where-Object { ($_[1] - $_[0] + 1) -ge $MinGap })
  if ($ranges.Count -eq 0) { $noGap++; continue }

  $covPct = [math]::Round(100.0 * $have.Count / $total, 1)
  Log ("GAP $($d.id) ${total}pg coverage ${covPct}% missing $($missing.Count)pg in $($ranges.Count) range(s): " + (($ranges | ForEach-Object { "$($_[0])-$($_[1])" }) -join ','))
  if ($WhatIf) { continue }

  # Fill each gap, halving a range that OOMs (heavy pages cluster).
  $queue = New-Object System.Collections.Generic.Queue[object]
  foreach ($rg in $ranges) {
    for ($s2 = $rg[0]; $s2 -le $rg[1]; $s2 += $PageBatch) {
      $queue.Enqueue(@{ s = $s2; e = [Math]::Min($s2 + $PageBatch - 1, $rg[1]) })
    }
  }
  $got = 0; $deadRanges = @()
  while ($queue.Count -gt 0) {
    $rg = $queue.Dequeue()
    try {
      $r2 = Invoke-RestMethod -Method Post -Uri ("$uri&pageStart=$($rg.s)&pageEnd=$($rg.e)") -Headers $H -UserAgent $UA -TimeoutSec 280
      $got += [int]$r2.text_chunks
    } catch {
      $m2 = $_.Exception.Message; $rp2 = $_.Exception.Response
      if ($rp2) { try { $sr = New-Object IO.StreamReader($rp2.GetResponseStream()); $m2 = $sr.ReadToEnd() } catch {} }
      if ($m2 -match 'WORKER_RESOURCE_LIMIT' -and $rg.e -gt $rg.s) {
        $mid = [Math]::Floor(($rg.s + $rg.e) / 2)
        $queue.Enqueue(@{ s = $rg.s; e = $mid }); $queue.Enqueue(@{ s = $mid + 1; e = $rg.e })
      } else {
        $deadRanges += "$($rg.s)-$($rg.e)"
      }
    }
    if ($DelayMs -gt 0) { Start-Sleep -Milliseconds $DelayMs }
  }
  if ($got -gt 0) { $repaired++; $filledChunks += $got }
  if ($deadRanges.Count -gt 0) { $dead++; Log ("  unrecoverable pages: " + ($deadRanges -join ',')) }
  Log ("  filled +$got chunks$(if($deadRanges.Count){' (some pages unrecoverable)'})")
}
Log "DONE examined=$examined repaired=$repaired filled_chunks=$filledChunks already_complete=$noGap zero_text_skipped=$skipped with_unrecoverable=$dead"
