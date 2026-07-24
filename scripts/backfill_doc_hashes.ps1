param([int]$MaxDocs = 0, [string]$IdGte = '', [string]$IdLt = '', [string]$Tag = '')
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

# resume: ids already hashed (or known-missing) in a previous run
$done = @{}
if (Test-Path $DONE) {
  foreach ($ln in [System.IO.File]::ReadAllLines($DONE, $enc)) {
    if ($ln -match '"id"\s*:\s*"([0-9a-f-]{36})"') { $done[$matches[1]] = $true }
  }
}
Write-Output ("resume: " + $done.Count + " docs already in done-set")

function PostChunk($rows) {
  if ($rows.Count -eq 0) { return }
  $json = $rows | ConvertTo-Json -Depth 3
  if ($rows.Count -eq 1) { $json = "[$json]" }
  [System.IO.File]::WriteAllText($TMP, $json, (New-Object System.Text.UTF8Encoding($false)))
  $resp = & curl.exe -s -X POST "$BASE/rest/v1/documents?on_conflict=id" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Prefer: resolution=merge-duplicates,return=minimal" --data-binary "@$TMP"
  if ($resp -match '"message"\s*:' -and $resp -match '"code"') { throw "upsert failed: $resp" }
}

$lastId = if ($IdGte) { $IdGte } else { "00000000-0000-0000-0000-000000000000" }
$ltFilter = if ($IdLt) { "&id=lt.$IdLt" } else { "" }
$fetched = 0; $hashed = 0; $missing = 0; $errors = 0
$pending = New-Object System.Collections.Generic.List[object]
$sw = [System.Diagnostics.Stopwatch]::StartNew()

while ($true) {
  $url = "$BASE/rest/v1/documents?select=id,doc_type,title,file_path&content_sha256=is.null&file_path=not.is.null&order=id.asc&id=gt.$lastId$ltFilter&limit=500"
  $raw = (& curl.exe -s "$url" -H "apikey: $KEY" -H "Authorization: Bearer $KEY") -join "`n"
  if ($raw -match '"message"\s*:' -and $raw -match '"code"') { throw "GET documents failed: $raw" }
  # PS 5.1: ConvertFrom-Json returns a JSON array as ONE boxed Object[] (even via
  # -InputObject, @() keeps it nested) -> pipe through ForEach-Object to enumerate
  $page = @((ConvertFrom-Json -InputObject $raw) | ForEach-Object { $_ })
  if ($page.Count -eq 0) { break }
  foreach ($doc in $page) {
    $lastId = $doc.id
    if ($done.ContainsKey($doc.id)) { continue }
    $fetched++
    if ($MaxDocs -gt 0 -and $fetched -gt $MaxDocs) { break }
    $p = $doc.file_path
    if ($p -match '^file:(\\\\.*)$') { $p = $matches[1] }
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
    [System.IO.File]::AppendAllText($DONE, $line + "`r`n", $enc)
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
