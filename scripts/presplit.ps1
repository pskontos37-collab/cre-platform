# ⚠ DEPRECATED — DO NOT USE FOR CORPUS INGESTION.
# Ingesting the pieces this produces creates ONE documents row per piece, which fragments a single
# lease into many "…g-001-030 / g-031-060 …" records (users can't pull up "the lease"). Use
# split_ingest.ps1 instead: it sends the WHOLE PDF to pdf-extract, which segments internally and
# writes ONE document with many chunks (clause-level search preserved, full PDF openable).
# ingest_local_docs.ps1 now also SKIPS any "__g-NNN-NNN.pdf" piece as a safety net.
# (Kept only for ad-hoc, non-ingestion PDF splitting.)
#
# Pre-split oversized PDFs locally with qpdf into small pieces (lossless, low-memory) so each
# piece extracts single-shot via the normal scanner (no edge-fn OOM).
# Efficient: copies each source LOCAL once (one UNC read), then adaptively sizes pages/piece to
# target ~TARGET_MB per piece based on the doc's bytes-per-page (handles high-DPI scans).
# Env: GIANTS_LIST (source paths), PIECES_DIR (output), TARGET_MB (default 15).
$ErrorActionPreference = "Stop"
$SP = "C:\Users\pskontos\AppData\Local\Temp\claude\C--Users-pskontos-Desktop-Software\4813eb50-3027-4b15-81ea-2a63a5f0357b\scratchpad"
$qpdf = "$SP\qpdf\qpdf-12.3.2-mingw64\bin\qpdf.exe"
if(-not (Test-Path $qpdf)){ throw "qpdf not found at $qpdf" }
$giants = Get-Content -LiteralPath $env:GIANTS_LIST | Where-Object { $_ }
$outdir = $env:PIECES_DIR
$targetMB = 15; if($env:TARGET_MB){ $targetMB = [int]$env:TARGET_MB }
$targetB = $targetMB * 1MB
if(-not (Test-Path $outdir)){ New-Item -ItemType Directory -Path $outdir -Force | Out-Null }
$tmp = "$outdir\_src_tmp.pdf"
foreach($g in $giants){
  if(-not (Test-Path -LiteralPath $g)){ Write-Output "MISSING $g"; continue }
  $base = ([System.IO.Path]::GetFileNameWithoutExtension($g)) -replace '[^\w\-]','_'
  try {
    Copy-Item -LiteralPath $g -Destination $tmp -Force          # one UNC read
    $np = [int](& $qpdf --show-npages -- $tmp)
    $bpp = [Math]::Max(1,(Get-Item $tmp).Length / [Math]::Max(1,$np))
    $pp = [Math]::Max(1, [Math]::Floor($targetB / $bpp))         # pages/piece to hit ~target size
    $maxpg = 90; if($env:MAX_PAGES){ $maxpg = [int]$env:MAX_PAGES }
    if($pp -gt $maxpg){ $pp = $maxpg }                           # also cap pages/piece under Anthropic 100pg limit
                                                                 # (small-byte/many-page scans fail on pages, not bytes)
    if($pp -gt $np){ $pp = $np }
    & $qpdf --warning-exit-0 $tmp --split-pages=$pp -- "$outdir\${base}__g.pdf" 2>$null   # one local read -> all pieces
    $made = (Get-ChildItem "$outdir\${base}__g*.pdf" -ErrorAction SilentlyContinue).Count
    Write-Output ("$base : $np pg, ~$([int]($bpp/1KB))KB/pg -> $pp pg/piece -> $made pieces")
  } catch { Write-Output ("FAIL $base :: " + $_.Exception.Message) }
}
if(Test-Path $tmp){ Remove-Item $tmp -Force }
$man = Get-ChildItem "$outdir\*.pdf" | ForEach-Object { "{0}`t{1}" -f $_.Length, $_.FullName }
[System.IO.File]::WriteAllLines("$outdir\pieces_manifest.txt",$man,(New-Object System.Text.UTF8Encoding($false)))
$big = ($man | Where-Object { [long](($_ -split "`t")[0]) -gt 25165824 }).Count
Write-Output ("TOTAL pieces: " + $man.Count + "  >24MB: " + $big)
