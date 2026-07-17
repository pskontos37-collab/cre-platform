# ingest_scan.ps1 - nightly multi-folder drive scanner.
# Reads scan_folders.json, and for each configured folder builds a filtered manifest
# (excludes junk + excluded subdirs) then hands it to ingest_local_docs.ps1 via the
# INGEST_ROOT/INGEST_PID/INGEST_MANIFEST env contract. ingest_local_docs is idempotent
# (it skips file: paths already in `documents`), so a nightly re-run only ingests NEW files.
#
#   .\ingest_scan.ps1 -WhatIf                 # enumerate only: per-folder NEW-file counts, no AI calls, no cost
#   .\ingest_scan.ps1                         # ingest all configured folders (PDF)
#   .\ingest_scan.ps1 -Only Magnolia          # limit to folders whose property_name/category matches
#   .\ingest_scan.ps1 -MaxNewPerFolder 200    # cap new uploads per folder (throttle a first backfill)
#
# PHASE 1 = PDF only. Word (.doc/.docx) and Outlook (.msg) extraction is a later phase
# (needs Word/Outlook COM -> PDF/text); those are counted under -WhatIf but not ingested.
param(
  [switch]$WhatIf,
  [string]$Only = '',
  [string]$RootMatch = '',            # regex filter on the folder root path (precise single-folder targeting)
  [int]$MaxNewPerFolder = 0
)
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}; foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
# Stable work dir - a scheduled task fires long after any per-session scratchpad
# is gone, so use a fixed location and share it with ingest_local_docs via env.
$SP = "C:\Users\pskontos\AppData\Local\cre-ingest"
if (-not (Test-Path -LiteralPath $SP)) { New-Item -ItemType Directory -Force -Path $SP | Out-Null }
$env:INGEST_SP = $SP
$log = "$PSScriptRoot\ingest_scan.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [scan] $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }

# Single-owner guard: never run two passes at once (they share the work dir and
# would double-ingest). A stale lock from a crash is ignored (PID not alive).
$lock = "$SP\ingest_scan.lock"
if (Test-Path -LiteralPath $lock) {
  $opid = (Get-Content -LiteralPath $lock -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($opid -and (Get-Process -Id ([int]$opid) -ErrorAction SilentlyContinue)) { Log "another ingest_scan (PID $opid) running - exiting"; exit 0 }
}
Set-Content -LiteralPath $lock -Value $PID

# The corpus stores file paths in UNC form (K: = \\192.168.220.121\users,
# V: = \\192.168.220.121\virtual_file_room). We enumerate via drive letters but MUST
# translate to UNC before the dedup check AND before ingest, or every already-ingested
# doc looks "new" and gets re-ingested as a duplicate (9,644 docs are UNC-form).
function ToUnc([string]$p) {
  if ($p -imatch '^K:\\') { return ($p -ireplace '^K:\\', '\\192.168.220.121\users\') }
  if ($p -imatch '^V:\\') { return ($p -ireplace '^V:\\', '\\192.168.220.121\virtual_file_room\') }
  return $p
}

$conf = Get-Content -LiteralPath "$PSScriptRoot\scan_folders.json" -Raw | ConvertFrom-Json
$folders = $conf.folders
if ($Only) { $folders = $folders | Where-Object { $_.property_name -match [regex]::Escape($Only) -or $_.category -match [regex]::Escape($Only) } }
if ($RootMatch) { $folders = $folders | Where-Object { $_.root -match $RootMatch } }

# ---- done-set: file: paths already ingested (load ONCE, shared across folders) ----
$done = New-Object System.Collections.Generic.HashSet[string]
$off = 0
while ($true) {
  $r = & curl.exe -s "$BASE/rest/v1/documents?select=file_path&file_path=like.file:*" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Range: $off-$($off+999)"
  $arr = $r | ConvertFrom-Json; if (-not $arr) { break }
  foreach ($d in $arr) { if ($d.file_path) { [void]$done.Add($d.file_path) } }
  if ($arr.Count -lt 1000) { break }; $off += 1000
}
Log "already-ingested file: docs = $($done.Count)"

$JUNK = '(?i)(\\Thumbs\.db$|desktop\.ini$|\\~\$|\.lnk$|\.tmp$|\.avux$)'
$grandNew = 0; $grandNewMB = 0.0; $grandOther = 0
foreach ($fdr in $folders) {
  if ($fdr.PSObject.Properties['enabled'] -and $fdr.enabled -eq $false) { Log "DISABLED (skip): $($fdr.root)"; continue }
  if (-not (Test-Path -LiteralPath $fdr.root)) { Log "MISSING (skip): $($fdr.root)"; continue }
  $excl = @(); if ($fdr.exclude) { $excl = @($fdr.exclude) }
  $inc = @(); if ($fdr.include) { $inc = @($fdr.include | ForEach-Object { $_.ToLower() }) }
  $rootLen = $fdr.root.Length
  $all = Get-ChildItem -LiteralPath $fdr.root -Recurse -File -ErrorAction SilentlyContinue
  # junk filter + excluded-subdir denylist + (if present) document-worthy-subdir allowlist.
  # allowlist keeps a file only if some path segment under the root STARTS WITH an include token.
  $keep = $all | Where-Object {
    $p = $_.FullName
    if ($p -match $JUNK) { return $false }
    foreach ($x in $excl) { if ($p -match ('(?i)\\' + [regex]::Escape($x) + '\\')) { return $false } }
    if ($inc.Count -gt 0) {
      # Match ONLY the top-level subfolder under the root (segment 0) against the
      # allowlist - NOT filenames or nested folders. Matching any segment leaked
      # Accounting invoices in (a file named "Insurance...pdf" or a nested
      # "Tenant Plans" folder under Accounting/Construction would slip through).
      $segs = $p.Substring($rootLen).Trim('\').ToLower() -split '\\'
      $top = $segs[0]
      $hit = $false
      foreach ($t in $inc) { if ($top.StartsWith($t)) { $hit = $true; break } }
      if (-not $hit) { return $false }
    }
    return $true
  }
  $pdfs = @($keep | Where-Object { $_.Extension -ieq '.pdf' })
  $other = @($keep | Where-Object { $_.Extension -imatch '\.(docx?|msg|eml)$' })   # phase-2 candidates
  $newPdfs = @($pdfs | Where-Object { -not $done.Contains('file:' + (ToUnc $_.FullName)) })
  $newMB = [math]::Round((($newPdfs | Measure-Object Length -Sum).Sum / 1MB), 1)
  $grandNew += $newPdfs.Count; $grandNewMB += $newMB; $grandOther += $other.Count
  Log ("{0,-55} PDF new={1,5} (of {2,5})  {3,8}MB  | doc/msg={4} [{5}]" -f `
      ($fdr.root -replace '^([A-Za-z]:).*\\', '$1..\'), $newPdfs.Count, $pdfs.Count, $newMB, $other.Count, $fdr.property_name)

  if ($WhatIf) { continue }
  if ($newPdfs.Count -eq 0) { continue }
  # build a PDF-only manifest (size<TAB>path) for ingest_local_docs.ps1 manifest mode
  $manifest = "$SP\scan_manifest.txt"
  ($newPdfs | ForEach-Object { "$($_.Length)`t$(ToUnc $_.FullName)" }) | Set-Content -LiteralPath $manifest -Encoding utf8
  $env:INGEST_ROOT = (ToUnc $fdr.root)
  $env:INGEST_PID = $fdr.property_id
  $env:INGEST_MANIFEST = $manifest
  $env:GIANTS_OUT = "$SP\giants_$($fdr.property_id.Substring($fdr.property_id.Length-4)).txt"
  Log "  -> ingesting $($newPdfs.Count) new PDFs into $($fdr.property_name) ($($fdr.property_id))"
  if ($MaxNewPerFolder -gt 0) { & "$PSScriptRoot\ingest_local_docs.ps1" -Limit $MaxNewPerFolder }
  else { & "$PSScriptRoot\ingest_local_docs.ps1" }
}
Log ("TOTAL new PDFs to ingest = $grandNew  ($([math]::Round($grandNewMB,1)) MB)   | phase-2 doc/msg files seen = $grandOther")
if ($WhatIf) { Log 'WhatIf: no ingest performed.' }
Remove-Item -LiteralPath $lock -ErrorAction SilentlyContinue
