param(
  [switch]$Apply,
  [int]$MaxDocs = 0,
  [string]$ReportDir = ''
)
$ErrorActionPreference = "Stop"
# ---------------------------------------------------------------------------
# Clear the register's "unaccounted" backlog -- documents with a NULL
# processing_status. Deterministic, no AI, no spend. DRY RUN BY DEFAULT.
#
# WHY THIS EXISTS: `unaccounted` = processing_status IS NULL AND NOT is_indexed.
# Until 2026-07-27 no writer set processing_status, so the count grew with every
# new document and the audit's "100% accountability" decayed. The six script
# writers + pdf-extract now stamp AT INSERT, so this is a one-off catch-up and a
# safety net for any future writer that forgets -- not a recurring chore.
#
# FAIL-CLOSED BY DESIGN: only documents this script can classify with confidence
# are stamped. Today that is exactly one class -- acquisition-pipeline deal
# documents under ASSTMGMT\ACQUISITIONS, which are accounted for through
# pipeline_deal_documents and keep property_id NULL BY DESIGN (do not "fix" them
# onto properties). Anything else is listed and left alone; a wrong status is
# worse than a null one, because a null is visibly unaccounted while a wrong
# value silently claims the document was handled.
#
# The status value and note text deliberately reuse the convention the 2026-07-24
# triage established for this same population (verified against 1,000 already-
# stamped rows: all 'classified'; 992 carry the deal-scoped note, 8 carry the
# source-file-unavailable note), so the register reads consistently.
#
# Usage:
#   powershell -File stamp_unaccounted_docs.ps1            # dry run + report
#   powershell -File stamp_unaccounted_docs.ps1 -Apply     # write
# ---------------------------------------------------------------------------

$REPO = "C:\Users\pskontos\Desktop\Software\cre-platform"
$conf = @{}
foreach ($ln in (Get-Content "$REPO\.env" | Where-Object { $_ -match "=" })) {
  $kk,$vv = $ln -split '=',2; $conf[$kk.Trim()] = $vv.Trim()
}
# distinctive names: short ones collide with locals (PowerShell vars are
# case-insensitive, and $base / $sb have both bitten this project already)
$SUPA_URL = $conf['VITE_SUPABASE_URL']; $SUPA_KEY = $conf['SUPABASE_SECRET_KEY']
if (-not $SUPA_URL -or -not $SUPA_KEY) { throw "missing VITE_SUPABASE_URL / SUPABASE_SECRET_KEY in .env" }
if (-not $ReportDir) { $ReportDir = "$env:LOCALAPPDATA" }
$POSTFILE = "$env:LOCALAPPDATA\cre_stamp_post.json"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$STAMP_DATE = '2026-07-27'

$DEAL_NOTE    = "acquisition pipeline document - deal-scoped, no property by design (triage $STAMP_DATE)"
$NOFILE_NOTE  = "acquisition pipeline document - deal-scoped, no property by design (triage $STAMP_DATE); source file unavailable at recorded file_path (hash not computed)"

function CountOf($path) {
  $hdr = & curl.exe -s -I "$SUPA_URL/rest/v1/$path" -H "apikey: $SUPA_KEY" -H "Authorization: Bearer $SUPA_KEY" -H "Prefer: count=exact" -H "Range: 0-0"
  return ((($hdr | Select-String 'content-range').Line -split '/')[-1]).Trim()
}

Write-Output "=== BEFORE ==="
Write-Output ("  documents total        = " + (CountOf "documents?select=id"))
Write-Output ("  processing_status null = " + (CountOf "documents?select=id&processing_status=is.null"))
Write-Output ("  unaccounted (view def) = " + (CountOf "documents?select=id&processing_status=is.null&is_indexed=eq.false"))

# --- fetch the unstamped population --------------------------------------
$rows = New-Object System.Collections.Generic.List[object]
$lastId = "00000000-0000-0000-0000-000000000000"
while ($true) {
  $url = "$SUPA_URL/rest/v1/documents?select=id,doc_type,title,file_path,property_id,is_indexed,content_sha256&processing_status=is.null&order=id.asc&id=gt.$lastId&limit=500"
  $page = $null
  for ($try = 1; $try -le 4; $try++) {
    $raw = (& curl.exe -s "$url" -H "apikey: $SUPA_KEY" -H "Authorization: Bearer $SUPA_KEY") -join "`n"
    if ($raw -and -not ($raw -match '"message"\s*:' -and $raw -match '"code"')) {
      try { $page = @((ConvertFrom-Json -InputObject $raw) | ForEach-Object { $_ }); break } catch { $page = $null }
    }
    Start-Sleep -Milliseconds (500 * $try)
  }
  if ($null -eq $page) { throw "GET documents failed at id=gt.$lastId" }
  if ($page.Count -eq 0) { break }
  foreach ($d in $page) { $rows.Add($d); $lastId = $d.id }
  if ($MaxDocs -gt 0 -and $rows.Count -ge $MaxDocs) { break }
}
Write-Output ""
Write-Output ("unstamped documents fetched = " + $rows.Count)

# --- classify (fail-closed) ----------------------------------------------
$toWrite  = New-Object System.Collections.Generic.List[object]
$skipped  = New-Object System.Collections.Generic.List[object]
$hashed = 0; $noFile = 0
foreach ($d in $rows) {
  $path = [string]$d.file_path
  if ($path -match '^file:(\\\\.*)$') { $path = $matches[1] }
  if (-not ($path -match '(?i)ASSTMGMT[\\/]ACQUISITIONS')) {
    # not a class this script is confident about -- leave the null in place
    $skipped.Add([pscustomobject]@{ id = $d.id; reason = 'not an ASSTMGMT\ACQUISITIONS deal document'; doc_type = $d.doc_type; file_path = $d.file_path })
    continue
  }
  $sha = $null
  if ($path -and (Test-Path -LiteralPath $path)) {
    try { $sha = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower() } catch { $sha = $null }
  }
  $note = $DEAL_NOTE
  if ($sha) { $hashed++ } else { $note = $NOFILE_NOTE; $noFile++ }
  # doc_type + title are echoed because a PostgREST upsert is INSERT..ON CONFLICT
  # and must satisfy the table's NOT NULL columns
  $row = @{ id = $d.id; doc_type = $d.doc_type; title = $d.title
            processing_status = 'classified'; processing_note = $note }
  if ($sha) { $row['content_sha256'] = $sha }
  $toWrite.Add($row)
}

Write-Output ""
Write-Output "=== plan ==="
Write-Output ("  to stamp 'classified'          = " + $toWrite.Count)
Write-Output ("    with a freshly computed hash = " + $hashed)
Write-Output ("    file absent, no hash written = " + $noFile)
Write-Output ("  LEFT ALONE (unclassifiable)    = " + $skipped.Count)
if ($skipped.Count -gt 0) {
  Write-Output "  -- left alone, listed for a human --"
  $skipped | Select-Object -First 20 | ForEach-Object { Write-Output ("     [" + $_.doc_type + "] " + $_.file_path) }
}
$planCsv = "$ReportDir\cre_stamp_plan.csv"
$toWrite | ForEach-Object { [pscustomobject]@{ id = $_.id; status = $_.processing_status; sha = $_.content_sha256; note = $_.processing_note } } |
  Export-Csv -Path $planCsv -NoTypeInformation -Encoding UTF8
Write-Output ("  plan -> " + $planCsv)

if (-not $Apply) {
  Write-Output ""
  Write-Output "DRY RUN -- nothing written. Re-run with -Apply to stamp."
  return
}

# --- write ---------------------------------------------------------------
$written = 0
$chunk = 100
for ($i = 0; $i -lt $toWrite.Count; $i += $chunk) {
  $end = [math]::Min($i + $chunk - 1, $toWrite.Count - 1)
  $batch = @($toWrite[$i..$end])
  # PGRST102: a bulk array upsert needs identical keys on every object, and
  # content_sha256 is present only for the rows whose file we found -- so pad it
  foreach ($b in $batch) { if (-not $b.ContainsKey('content_sha256')) { $b['content_sha256'] = $null } }
  $json = $batch | ConvertTo-Json -Depth 3
  if ($batch.Count -eq 1) { $json = "[$json]" }
  [System.IO.File]::WriteAllText($POSTFILE, $json, $utf8NoBom)
  $ok = $false
  for ($try = 1; $try -le 4; $try++) {
    $resp = & curl.exe -s -X POST "$SUPA_URL/rest/v1/documents?on_conflict=id" -H "apikey: $SUPA_KEY" -H "Authorization: Bearer $SUPA_KEY" -H "Content-Type: application/json" -H "Prefer: resolution=merge-duplicates,return=representation" --data-binary "@$POSTFILE"
    if (-not ($resp -match '"message"\s*:' -and $resp -match '"code"')) {
      # count what actually PERSISTED; return=minimal can 201 without persisting
      $written += ([regex]::Matches([string]$resp, '"id"\s*:')).Count
      $ok = $true; break
    }
    $head = [string]$resp
    if ($head.Length -gt 300) { $head = $head.Substring(0,300) }
    Write-Output ("  POST retry $try" + ": " + $head)
    Start-Sleep -Seconds (2 * $try)
  }
  if (-not $ok) { Write-Output ("  WARN: batch dropped (" + $batch.Count + " rows)") }
}
Write-Output ""
Write-Output ("rows persisted = " + $written + " of " + $toWrite.Count)
Write-Output ""
Write-Output "=== AFTER ==="
Write-Output ("  processing_status null = " + (CountOf "documents?select=id&processing_status=is.null"))
Write-Output ("  unaccounted (view def) = " + (CountOf "documents?select=id&processing_status=is.null&is_indexed=eq.false"))
Write-Output ("  content_sha256 null    = " + (CountOf "documents?select=id&content_sha256=is.null") + "   (the remainder is the moved/temp-path residue -- needs path fixes, not stamping)")
