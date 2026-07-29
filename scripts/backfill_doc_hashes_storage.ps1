param([int]$MaxDocs = 0, [string]$Tag = 'stor', [switch]$DryRun, [switch]$NoResume)
$ErrorActionPreference = "Stop"
# Register backfill, STORAGE variant: SHA-256 every sha-null document from its copy in
# Supabase Storage (bucket 'documents', documents.storage_path) instead of from its LOCAL
# file, then write content_sha256 back via PostgREST upsert (on_conflict=id,
# merge-duplicates). Deterministic, no AI. Companion to backfill_doc_hashes.ps1 -- that one
# reads documents.file_path off the file server; this one reads the mirrored bytes.
#
# WHY THIS EXISTS. 252 documents were ingested from a Temp\claude scratchpad that has since
# been deleted, so their file_path can never resolve and the local-path script records them
# {"missing":true} forever. They were called permanently unhashable. They are not: all 252
# storage objects are present, indexed, and carry ~5,100 text chunks. Measured 2026-07-29:
# of the 300 sha-null documents, 286 have a storage object that EXISTS -- so the real
# irreducible remainder is 14, not 300.
#
# WHAT THOSE 252 ARE (verified, not inferred from filenames): ranged-OCR page slices of 9
# oversize source PDFs, e.g. Gateway's Phase 1 ESA (10-4-18) is 114.8 MB on the file server
# and was cut into 104 slices to be OCR'd. Three of the 9 sources have sibling rows already
# pointing at the real file-server original, and those siblings cover COMPLEMENTARY page
# ranges -- so the temp-path rows are the only carrier of their content. Nothing here is a
# duplicate that could simply be dropped.
#
# WHY HASH THE SLICE AND NOT THE ORIGINAL. Repointing file_path at the parent PDF would let
# the local script hash it, but every slice of one parent would then share the parent's
# hash, and duplicate_group_id would group them as copies of each other. Hashing the row's
# OWN bytes keeps content_sha256 meaning what it says.
#
# Usage: powershell -File backfill_doc_hashes_storage.ps1 [-DryRun] [-MaxDocs 5]

$cfg = @{}; foreach ($l in (Get-Content "C:\Users\pskontos\Desktop\Software\cre-platform\.env" | Where-Object { $_ -match "=" })) { $k,$v = $l -split '=',2; $cfg[$k.Trim()]=$v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
if (-not $BASE -or -not $KEY) { throw "missing VITE_SUPABASE_URL or SUPABASE_SECRET_KEY in .env" }
$BUCKET = 'documents'
$enc = [System.Text.Encoding]::UTF8

# done-set lives OUTSIDE the repo: an untracked file in scripts\ can be nuked by a parallel
# session's git clean mid-run (happened 2026-07-24). The DB filter is the durable resume
# state anyway; the done-set only avoids re-downloading known-bad objects within a run.
$DONE = "$env:LOCALAPPDATA\cre_doc_hash_storage_done$Tag.jsonl"
$TMP  = "$env:LOCALAPPDATA\cre_doc_hash_storage_post$Tag.json"
$BLOB = "$env:LOCALAPPDATA\cre_doc_hash_storage_blob$Tag.bin"

Write-Output ("start[$Tag] pid=" + ([System.Diagnostics.Process]::GetCurrentProcess().Id) + " bucket=$BUCKET dryrun=$DryRun")

# -NoResume ignores the done-set. Use it when re-running to pick up objects that were absent
# before and are present now: a previous run records those as {"missing":true} and the resume
# load would then SKIP them forever. That exact defect made a 290-document re-run attempt 4
# documents and report success (2026-07-27, local-path script).
$done = @{}
if ($NoResume) {
  Write-Output "resume[$Tag]: SKIPPED (-NoResume) -- every sha-null document will be re-tested"
} elseif (Test-Path $DONE) {
  foreach ($ln in [System.IO.File]::ReadAllLines($DONE, $enc)) {
    if ($ln -match '"id"\s*:\s*"([0-9a-f-]{36})"') { $done[$matches[1]] = $true }
  }
  Write-Output ("resume[$Tag]: " + $done.Count + " docs already in done-set (re-run with -NoResume to retest them)")
}

function PostChunk($rows) {
  if ($rows.Count -eq 0) { return }
  $json = $rows | ConvertTo-Json -Depth 3
  if ($rows.Count -eq 1) { $json = "[$json]" }
  [System.IO.File]::WriteAllText($TMP, $json, (New-Object System.Text.UTF8Encoding($false)))
  # transient REST failures must not kill a long worker: retry, then give up on the CHUNK
  # (those docs stay sha-null and are re-fetched by the next run)
  for ($try = 1; $try -le 4; $try++) {
    $resp = & curl.exe -s -X POST "$BASE/rest/v1/documents?on_conflict=id" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Prefer: resolution=merge-duplicates,return=minimal" --data-binary "@$TMP"
    if (-not ($resp -match '"message"\s*:' -and $resp -match '"code"')) { return }
    $errHead = [string]$resp; if ($errHead.Length -gt 200) { $errHead = $errHead.Substring(0, 200) }
    Write-Output ("upsert retry $try" + ": " + $errHead)
    Start-Sleep -Seconds (10 * $try)
  }
  Write-Output ("WARN: upsert chunk dropped after retries (" + $rows.Count + " rows will re-fetch next run)")
}

$lastId = "00000000-0000-0000-0000-000000000000"
$fetched = 0; $hashed = 0; $missing = 0; $errors = 0; $bytes = 0
$pending = New-Object System.Collections.Generic.List[object]
$sw = [System.Diagnostics.Stopwatch]::StartNew()

while ($true) {
  $url = "$BASE/rest/v1/documents?select=id,doc_type,title,storage_path,file_size_bytes&content_sha256=is.null&storage_path=not.is.null&order=id.asc&id=gt.$lastId&limit=500"
  # GET with retries: an empty/garbled page must not silently end the worker
  $page = $null
  for ($try = 1; $try -le 4; $try++) {
    $raw = (& curl.exe -s "$url" -H "apikey: $KEY" -H "Authorization: Bearer $KEY") -join "`n"
    if ($raw -and -not ($raw -match '"message"\s*:' -and $raw -match '"code"')) {
      try {
        # PS 5.1: ConvertFrom-Json returns a JSON array as ONE boxed Object[] -- pipe
        # through ForEach-Object to actually enumerate it
        $page = @((ConvertFrom-Json -InputObject $raw) | ForEach-Object { $_ })
        break
      } catch { $page = $null }
    }
    Write-Output ("GET retry $try after bad page response")
    Start-Sleep -Seconds (10 * $try)
  }
  if ($null -eq $page) { throw "GET documents failed after retries at id=gt.$lastId" }
  if ($page.Count -eq 0) { break }

  foreach ($doc in $page) {
    $lastId = $doc.id
    if ($done.ContainsKey($doc.id)) { continue }
    $fetched++
    if ($MaxDocs -gt 0 -and $fetched -gt $MaxDocs) { break }

    if ($DryRun) {
      Write-Output ("would hash " + $doc.id + "  " + $doc.storage_path + "  " + $doc.file_size_bytes + " bytes")
      continue
    }

    if (Test-Path $BLOB) { Remove-Item $BLOB -Force -ErrorAction SilentlyContinue }
    $objUrl = "$BASE/storage/v1/object/$BUCKET/" + $doc.storage_path
    $line = $null
    # -f fails the request on HTTP >=400 so a JSON error body is never hashed as if it were
    # a PDF -- that would write a confident, wrong hash, the worst outcome here.
    & curl.exe -s -f -o $BLOB "$objUrl" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" 2>$null
    $ok = ($LASTEXITCODE -eq 0) -and (Test-Path $BLOB)
    if ($ok) {
      $len = (Get-Item $BLOB).Length
      if ($len -le 0) { $ok = $false }
    }
    if (-not $ok) {
      $missing++
      $line = '{"id":"' + $doc.id + '","missing":true}'
    } else {
      try {
        $len = (Get-Item $BLOB).Length
        $h = (Get-FileHash -LiteralPath $BLOB -Algorithm SHA256).Hash.ToLower()
        $pending.Add(@{ id = $doc.id; doc_type = $doc.doc_type; title = $doc.title; content_sha256 = $h })
        $hashed++; $bytes += $len
        $line = '{"id":"' + $doc.id + '","sha":"' + $h + '"}'
      } catch {
        $errors++
        $line = '{"id":"' + $doc.id + '","error":true}'
      }
    }
    try { [System.IO.File]::AppendAllText($DONE, $line + "`r`n", $enc) } catch {}

    # smaller chunks than the local script: these are multi-MB downloads, so flush often
    # enough that a crash loses little work
    if ($pending.Count -ge 50) {
      PostChunk $pending
      $pending = New-Object System.Collections.Generic.List[object]
      Write-Output ("progress[$Tag]: hashed=$hashed missing=$missing errors=$errors mb=" + [int]($bytes/1MB) + " elapsed=" + [int]$sw.Elapsed.TotalSeconds + "s")
    }
  }
  if ($MaxDocs -gt 0 -and $fetched -gt $MaxDocs) { break }
}
PostChunk $pending
if (Test-Path $BLOB) { Remove-Item $BLOB -Force -ErrorAction SilentlyContinue }
Write-Output ("DONE[$Tag] hashed=$hashed missing=$missing errors=$errors total_attempted=$fetched mb=" + [int]($bytes/1MB) + " elapsed=" + [int]$sw.Elapsed.TotalSeconds + "s")
