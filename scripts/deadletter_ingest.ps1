# deadletter_ingest.ps1 - recovers the 118 oversized (>100pg / >23MB) PDFs that the
# TENANTS scans dead-lettered — mostly ANCHOR LEASES. Splits each into 30-page pieces
# (qpdf) and ingests the pieces per property. Prefers the OCR twin when both exist.
# Idempotent: ingest skips already-present piece paths; safe to re-run. Run DETACHED.
$ErrorActionPreference='Continue'
$repo = Split-Path $PSScriptRoot -Parent
$SP  = "C:\Users\pskontos\AppData\Local\Temp\claude\C--Users-pskontos-Desktop-Software\8fda4944-9fea-4fcc-916a-24df37037889\scratchpad"
$DL  = "C:\Users\pskontos\AppData\Local\Temp\claude\C--Users-pskontos-Desktop-Software\4813eb50-3027-4b15-81ea-2a63a5f0357b\scratchpad\ingest_deadletter.txt"
$QPDF= "C:\Users\pskontos\AppData\Local\Temp\claude\C--Users-pskontos-Desktop-Software\4813eb50-3027-4b15-81ea-2a63a5f0357b\scratchpad\qpdf\qpdf-12.3.2-mingw64\bin\qpdf.exe"
$log = "$PSScriptRoot\deadletter_ingest.log"
function Log($m){ $line="$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }

$PROPS = @(
  @('Gateway (Formerly Port Chester)', 'd5a4ed03-0b60-4168-9208-83822dd24884', 'gw'),
  @('Magnolia Park',                   'd4f08824-2d88-472d-b7aa-a703310c2aaf', 'mag'),
  @('KM-East',                         '00000000-0000-0000-0000-000000000010', 'kme'),
  @('KM-West',                         '00000000-0000-0000-0000-000000000011', 'kmw')
)

# 1. Load + dedupe (prefer OCR twin)
$raw = Get-Content $DL | Where-Object { $_ -match 'file:' } | ForEach-Object { ($_ -replace '^﻿','') -replace '^file:','' } | Select-Object -Unique
$groups = @{}
foreach($p in $raw){
  $k = ($p -replace 'OCR\.pdf$','.pdf').ToLower()
  if(-not $groups.ContainsKey($k)){ $groups[$k] = New-Object System.Collections.Generic.List[string] }
  $groups[$k].Add($p)
}
$files = @()
foreach($g in $groups.Values){
  $ocr = @($g | Where-Object { $_ -match 'OCR\.pdf$' })
  $files += $(if($ocr.Count){ $ocr[0] } else { $g[0] })
}
Log ("deadletter unique documents: " + $files.Count + " (from " + $raw.Count + " entries)")

# 2. Split per property
foreach($trio in $PROPS){
  $needle=$trio[0]; $pid2=$trio[1]; $key=$trio[2]
  $mine = @($files | Where-Object { $_ -match [regex]::Escape($needle) })
  if(-not $mine.Count){ continue }
  $outdir = "$SP\dl_pieces_$key"
  if(-not (Test-Path $outdir)){ New-Item -ItemType Directory -Path $outdir -Force | Out-Null }
  Log ("[$key] documents to split: " + $mine.Count)
  foreach($f in $mine){
    if(-not (Test-Path -LiteralPath $f)){ Log ("[$key] MISSING " + $f); continue }
    $base = ([IO.Path]::GetFileNameWithoutExtension($f)) -replace '[^\w\-]','_'
    if(Get-ChildItem "$outdir\${base}__g*.pdf" -ErrorAction SilentlyContinue){ continue }  # already split
    $tmp = "$outdir\_src_tmp.pdf"
    try {
      Copy-Item -LiteralPath $f -Destination $tmp -Force
      & $QPDF --warning-exit-0 $tmp --split-pages=30 -- "$outdir\${base}__g.pdf" 2>$null
      $made = (Get-ChildItem "$outdir\${base}__g*.pdf" -ErrorAction SilentlyContinue).Count
      Log ("[$key] split " + $base + " -> " + $made + " pieces")
    } catch { Log ("[$key] SPLIT FAIL " + $base + " :: " + $_.Exception.Message) }
  }
  if(Test-Path "$outdir\_src_tmp.pdf"){ Remove-Item "$outdir\_src_tmp.pdf" -Force }
}

# 3. Ingest pieces per property (idempotent by file_path)
foreach($trio in $PROPS){
  $pid2=$trio[1]; $key=$trio[2]
  $outdir = "$SP\dl_pieces_$key"
  if(-not (Test-Path $outdir)){ continue }
  $env:INGEST_ROOT = $outdir
  $env:INGEST_PID  = $pid2
  Log ("[$key] ingest starting")
  & "$repo\scripts\ingest_local_docs.ps1"
  Log ("[$key] ingest done")
}
Log "deadletter recovery complete"