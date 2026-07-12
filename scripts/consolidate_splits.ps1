# consolidate_splits.ps1 - re-unify documents that were ingested as split pieces
# (big PDFs presplit into scratchpad "..._g-NNN-NNN.pdf" segments, each its own
# documents row). For each source file: locate the ORIGINAL full PDF on the file
# server by a normalized-name match, upload it to Storage, fold every piece's chunk
# under one canonical document (preserving segment-level chunks + voyage embeddings),
# point the canonical doc at the full PDF, and delete the redundant piece rows.
#
# DRY-RUN by default (matches + reports only). Pass -Execute to apply changes.
param([switch]$Execute)
$ErrorActionPreference = "Stop"
$repo = "C:\Users\pskontos\Desktop\Software\cre-platform"
$cfg = @{}; foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match "=" })) { $k,$v = $l -split '=',2; $cfg[$k.Trim()]=$v.Trim() }
$BASE=$cfg['VITE_SUPABASE_URL']; $KEY=$cfg['SUPABASE_SECRET_KEY']; $JWT=$cfg['SUPABASE_SERVICE_JWT']
$enc = New-Object System.Text.UTF8Encoding($false)
$tmp = "$env:TEMP\_consolidate.json"

$roots = @{
  '00000000-0000-0000-0000-000000000010' = '\\192.168.220.121\virtual_file_room\Knightdale Marketplace 7-15-19'
  '00000000-0000-0000-0000-000000000011' = '\\192.168.220.121\virtual_file_room\Knightdale Marketplace 7-15-19'
  '00000000-0000-0000-0000-000000000012' = '\\192.168.220.121\virtual_file_room\Knightdale Marketplace 7-15-19'
  'd5a4ed03-0b60-4168-9208-83822dd24884' = '\\192.168.220.121\virtual_file_room\Gateway (Formerly Port Chester) 2-8-19'
  'd4f08824-2d88-472d-b7aa-a703310c2aaf' = '\\192.168.220.121\virtual_file_room\Magnolia Park 11-20-14'
}
function Norm($s){ (($s -replace '[^a-zA-Z0-9]','')).ToLower() }

# ---- fetch all scratchpad piece docs via PostgREST ----
$u = "$BASE/rest/v1/documents?select=id,property_id,file_path,doc_type&file_path=ilike.*scratchpad*&limit=2000"
$raw = & curl.exe -s $u -H "apikey: $KEY" -H "Authorization: Bearer $KEY"
$all = $raw | ConvertFrom-Json
$rx = '(__g-|_g-|_p)\d+-\d+\.pdf$'
$pieces = $all | Where-Object { $_.file_path -match $rx }
Write-Output ("piece docs: {0}" -f $pieces.Count)

# ---- group by (property_id, stem) ----
$groups = @{}
foreach ($d in $pieces) {
  $stem = [regex]::Replace($d.file_path, $rx, '', 'IgnoreCase')
  $segStart = 0; if ($d.file_path -match '(\d+)-\d+\.pdf$') { $segStart = [int]$Matches[1] }
  $key = "$($d.property_id)|$stem"
  if (-not $groups.ContainsKey($key)) { $groups[$key] = @() }
  $groups[$key] += [pscustomobject]@{ id=$d.id; seg=$segStart; doc_type=$d.doc_type; fp=$d.file_path; prop=$d.property_id; stem=$stem }
}
Write-Output ("instruments (groups): {0}" -f $groups.Count)

# ---- build file-server PDF index per root (cached) ----
$idxCache = @{}
function Get-Index($root){
  if ($idxCache.ContainsKey($root)) { return $idxCache[$root] }
  $map = @{}
  if (Test-Path -LiteralPath $root) {
    Get-ChildItem -LiteralPath $root -Recurse -File -Filter *.pdf -ErrorAction SilentlyContinue | ForEach-Object {
      $n = Norm($_.BaseName)
      if (-not $map.ContainsKey($n)) { $map[$n] = @() }
      $map[$n] += $_.FullName
    }
  }
  $idxCache[$root] = $map
  [Console]::Error.WriteLine(("  indexed {0} pdf names under {1}" -f $map.Count, $root))
  return $map
}

function Post-PATCH($pathAndQuery,$obj){
  [IO.File]::WriteAllText($tmp,(ConvertTo-Json -InputObject $obj -Compress),$enc)
  & curl.exe -s -X PATCH "$BASE/rest/v1/$pathAndQuery" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Prefer: return=minimal" --data-binary "@$tmp"
}

$done=@(); $review=@(); $manifest=@()
foreach ($key in $groups.Keys) {
  $g = $groups[$key] | Sort-Object seg
  $prop = $g[0].prop; $stem = $g[0].stem
  $baseStem = ($stem -split '[\\/]')[-1]
  $normStem = Norm($baseStem)
  $root = $roots[$prop]
  $orig = $null; $note=''
  if ($root) {
    $map = Get-Index $root
    if ($map.ContainsKey($normStem)) {
      if ($map[$normStem].Count -eq 1) { $orig = $map[$normStem][0] } else { $note = "AMBIGUOUS ($($map[$normStem].Count) matches)" }
    } else { $note = 'no file-server match' }
  } else { $note = 'no root for property' }

  if (-not $orig) { $review += [pscustomobject]@{ stem=$baseStem; prop=$prop; pieces=$g.Count; note=$note }; continue }

  $canonical = $g[0].id
  $fsPath = 'file:' + $orig   # -> file:\\192.168.220.121\...
  $spath  = "p/$prop/$canonical.pdf"
  Write-Output ("MATCH  {0}  <-  {1}  ({2} pieces)" -f $baseStem, (Split-Path $orig -Leaf), $g.Count)

  if ($Execute) {
    # Upload the original PDF for in-app preview; skip (file_path only) if too big for Storage.
    $uploaded=$false
    try {
      if ((Get-Item -LiteralPath $orig).Length -le 45MB) {
        $bytes=$null; for($a=1;$a -le 5;$a++){ try{ $bytes=[IO.File]::ReadAllBytes($orig); break }catch{ if($a -eq 5){throw}; Start-Sleep -Seconds (2*$a) } }
        Invoke-RestMethod -Method Post -Uri "$BASE/storage/v1/object/documents/$spath" -Headers @{ Authorization="Bearer $JWT"; apikey=$JWT; 'x-upsert'='true' } -ContentType 'application/pdf' -Body $bytes -TimeoutSec 600 | Out-Null
        $uploaded=$true
      } else { [Console]::Error.WriteLine("  $baseStem : original >45MB, file_path only (no preview)") }
    } catch { [Console]::Error.WriteLine("  $baseStem : upload failed ($($_.Exception.Message)) -> file_path only") }
    # Record the DB changes for the SQL step (DML runs via MCP execute_sql, which bypasses RLS
    # reliably — PostgREST DML was silently no-op'ing against the RLS-guarded tables).
    $manifest += [pscustomobject]@{
      canonical = $canonical
      fsPath    = $fsPath
      spath     = $(if ($uploaded) { $spath } else { $null })
      move      = @($g | Select-Object -Skip 1 | ForEach-Object { $_.id })
    }
  }
  $done += [pscustomobject]@{ stem=$baseStem; canonical=$canonical; pieces=$g.Count; orig=(Split-Path $orig -Leaf) }
}

Write-Output ""
Write-Output ("==== {0} : matched={1}  needs-review={2} ====" -f ($(if($Execute){'EXECUTED'}else{'DRY-RUN'})), $done.Count, $review.Count)
if ($review.Count) { Write-Output "--- NEEDS REVIEW ---"; $review | ForEach-Object { "  [$($_.note)] $($_.stem)  ($($_.pieces) pieces)" } }
if ($Execute) {
  $mfile = "$env:TEMP\consolidate_manifest.json"
  ($manifest | ConvertTo-Json -Compress -Depth 5) | Out-File -FilePath $mfile -Encoding utf8
  Write-Output ("MANIFEST written to {0} ({1} groups)" -f $mfile, $manifest.Count)
}