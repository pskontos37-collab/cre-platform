param([int]$MaxDocs = 0, [string]$IdGte = '', [string]$IdLt = '', [string]$Tag = '', [switch]$NoResume)
$ErrorActionPreference = "Stop"
# Register backfill (audit Phase 2, Document Control): SHA-256 every document from
# its LOCAL source file (documents.file_path; 'file:' UNC prefix stripped, K:\ used
# as-is) and write content_sha256 back via PostgREST upsert (on_conflict=id,
# merge-duplicates). Deterministic, no AI. Resumable: done-set JSONL in scripts\.
# After a FULL run, the session runs the SQL derivations (duplicate groups,
# page_count from text chunks, processing_status) -- see project memory.
#
# Usage: powershell -File backfill_doc_hashes.ps1 [-MaxDocs 5]
#   Parallel: run several with disjoint uuid ranges, e.g.
#     -IdGte '' -IdLt '40000000-...' -Tag w1   (workers share nothing; the DB
#     filter content_sha256=is.null makes overlap harmless anyway)

$cfg = @{}; foreach ($l in (Get-Content "C:\Users\pskontos\Desktop\Software\cre-platform\.env" | Where-Object { $_ -match "=" })) { $k,$v = $l -split '=',2; $cfg[$k.Trim()]=$v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$enc = [System.Text.Encoding]::UTF8
$SCRIPTS = "C:\Users\pskontos\Desktop\Software\cre-platform\scripts"
# done-set lives OUTSIDE the repo: an untracked file in scripts\ can be nuked by a
# parallel session's git clean mid-run (happened 2026-07-24). The DB is the durable
# resume state anyway (the GET filters content_sha256=is.null); the done-set only
# avoids re-testing missing/error files within+across runs.
$DONE = "$env:LOCALAPPDATA\cre_doc_hash_done$Tag.jsonl"
$TMP  = "$env:LOCALAPPDATA\cre_doc_hash_post$Tag.json"

Write-Output ("start[$Tag] pid=" + ([System.Diagnostics.Process]::GetCurrentProcess().Id) + " done=$DONE gte='$IdGte' lt='$IdLt'")

# resume: ids already hashed (or known-missing) in a previous run.
#
# -NoResume ignores the done-set. USE IT when re-running to pick up files that
# were absent before and are present now: a previous run records those ids as
# {"missing":true}, and the resume load then SKIPS them forever, so the re-run
# silently does almost nothing. That happened 2026-07-27 -- a run meant to hash
# 290 now-present files attempted 4 documents and reported success. A fresh -Tag
# is NOT a reliable escape either: the done-set path can resolve differently for
# a detached/sandboxed process than for the shell that checked for it, so the
# file can be absent to you and present to the run.
#
# The DB filter (content_sha256=is.null) is the durable resume state anyway --
# the done-set only saves re-testing missing/error files within a single run.
$done = @{}
if ($NoResume) {
  Write-Output "resume[$Tag]: SKIPPED (-NoResume) -- every sha-null document will be re-tested"
} else {
  if (Test-Path $DONE) {
    foreach ($ln in [System.IO.File]::ReadAllLines($DONE, $enc)) {
      if ($ln -match '"id"\s*:\s*"([0-9a-f-]{36})"') { $done[$matches[1]] = $true }
    }
  }
  Write-Output ("resume[$Tag]: " + $done.Count + " docs already in done-set")
  if ($done.Count -gt 0) {
    Write-Output "  NOTE: those ids will be SKIPPED. If you are re-running to catch files that have since"
    Write-Output "        appeared, or that were recorded missing, re-run with -NoResume."
  }
}

function PostChunk($rows) {
  if ($rows.Count -eq 0) { return }
  $json = $rows | ConvertTo-Json -Depth 3
  if ($rows.Count -eq 1) { $json = "[$json]" }
  [System.IO.File]::WriteAllText($TMP, $json, (New-Object System.Text.UTF8Encoding($false)))
  # transient REST failures must not kill a multi-hour worker: retry, then give up
  # on the CHUNK (docs stay sha-null and are re-fetched by the next run)
  for ($try = 1; $try -le 4; $try++) {
    $resp = & curl.exe -s -X POST "$BASE/rest/v1/documents?on_conflict=id" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Prefer: resolution=merge-duplicates,return=minimal" --data-binary "@$TMP"
    if (-not ($resp -match '"message"\s*:' -and $resp -match '"code"')) { return }
    $errHead = [string]$resp; if ($errHead.Length -gt 200) { $errHead = $errHead.Substring(0, 200) }
    Write-Output ("upsert retry $try" + ": " + $errHead)
    Start-Sleep -Seconds (10 * $try)
  }
  Write-Output ("WARN: upsert chunk dropped after retries (" + $rows.Count + " rows will re-fetch next run)")
}

$lastId = if ($IdGte) { $IdGte } else { "00000000-0000-0000-0000-000000000000" }
$ltFilter = if ($IdLt) { "&id=lt.$IdLt" } else { "" }
$fetched = 0; $hashed = 0; $missing = 0; $errors = 0
$pending = New-Object System.Collections.Generic.List[object]
$sw = [System.Diagnostics.Stopwatch]::StartNew()

while ($true) {
  $url = "$BASE/rest/v1/documents?select=id,doc_type,title,file_path&content_sha256=is.null&file_path=not.is.null&order=id.asc&id=gt.$lastId$ltFilter&limit=500"
  # GET with retries: an empty/garbled response (network blip, nightly-task load)
  # must not kill or silently end the worker
  $page = $null
  for ($try = 1; $try -le 4; $try++) {
    $raw = (& curl.exe -s "$url" -H "apikey: $KEY" -H "Authorization: Bearer $KEY") -join "`n"
    if ($raw -and -not ($raw -match '"message"\s*:' -and $raw -match '"code"')) {
      try {
        # PS 5.1: ConvertFrom-Json returns a JSON array as ONE boxed Object[] (even via
        # -InputObject, @() keeps it nested) -> pipe through ForEach-Object to enumerate
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
    $p = $doc.file_path
    # Strip the 'file:' prefix whatever follows it. The old pattern was
    # '^file:(\\\\.*)$' -- UNC only -- so a drive-letter path like
    # 'file:V:\Gateway...\x.pdf' kept its prefix, got Test-Path'd as the literal
    # string "file:V:\...", failed, and was recorded missing. That silently made
    # 361 documents permanently unhashable, 96 of whose files were sitting right
    # there on disk. Verified 2026-07-27: old regex stripped 0 of 361, this one
    # strips 361 of 361.
    if ($p -match '^file:(.+)$') { $p = $matches[1] }
    $line = $null
    if (-not (Test-Path -LiteralPath $p)) {
      $missing++
      $line = '{"id":"' + $doc.id + '","missing":true}'
    } else {
      try {
        $h = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower()
        $pending.Add(@{ id = $doc.id; doc_type = $doc.doc_type; title = $doc.title; content_sha256 = $h })
        $hashed++
        $line = '{"id":"' + $doc.id + '","sha":"' + $h + '"}'
      } catch {
        $errors++
        $line = '{"id":"' + $doc.id + '","error":true}'
      }
    }
    try { [System.IO.File]::AppendAllText($DONE, $line + "`r`n", $enc) } catch {}
    if ($pending.Count -ge 200) {
      PostChunk $pending
      $pending = New-Object System.Collections.Generic.List[object]
      Write-Output ("progress[$Tag]: hashed=$hashed missing=$missing errors=$errors elapsed=" + [int]$sw.Elapsed.TotalSeconds + "s")
    }
  }
  if ($MaxDocs -gt 0 -and $fetched -gt $MaxDocs) { break }
}
PostChunk $pending
Write-Output ("DONE[$Tag] hashed=$hashed missing=$missing errors=$errors total_attempted=$fetched elapsed=" + [int]$sw.Elapsed.TotalSeconds + "s")
