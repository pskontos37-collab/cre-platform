# analyze_doc_gaps.ps1 - READ-ONLY. Finds abstracts built WITHOUT a governing
# lease instrument in the file (like Destination XL: only CAM recon summaries),
# plus any "MISSING FROM FILE" open items the abstractor itself raised. Output is
# the corpus-ingestion worklist: which tenants need their lease/amendments pulled
# in before their abstract can be trusted. Gentle on the prod DB (batched reads).
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']; $UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }

$rows = Invoke-RestMethod -Uri "$BASE/rest/v1/lease_abstracts?select=tenant_name,property_id,source_doc_ids,oi:abstract->open_items,ld:abstract->lease_documents&order=tenant_name" -Headers $H -UserAgent $UA -TimeoutSec 90
Write-Output "abstracts: $(@($rows).Count)"

# Collect all source doc ids, resolve doc_type in batches (read-only, spaced).
$allIds = @($rows | ForEach-Object { $_.source_doc_ids } | Where-Object { $_ } | Select-Object -Unique)
$typeOf = @{}
for ($i = 0; $i -lt $allIds.Count; $i += 80) {
  $batch = $allIds[$i..([Math]::Min($i + 79, $allIds.Count - 1))]
  $inList = ($batch -join ',')
  $docs = Invoke-RestMethod -Uri "$BASE/rest/v1/documents?select=id,doc_type&id=in.($inList)" -Headers $H -UserAgent $UA -TimeoutSec 90
  foreach ($d in $docs) { $typeOf[[string]$d.id] = $d.doc_type }
  Start-Sleep -Milliseconds 250
}

$noLease = @(); $missingItems = @()
foreach ($r in $rows) {
  $ids = @($r.source_doc_ids)
  $types = @($ids | ForEach-Object { $typeOf[[string]$_] })
  $hasLease = @($types | Where-Object { $_ -eq 'lease' }).Count -gt 0
  # "MISSING FROM FILE:" open items naming a lease/amendment instrument
  $miss = @(@($r.oi) | Where-Object { $_ -match 'MISSING FROM FILE' -and $_ -match 'lease|amendment|assignment|guaranty' })
  $typeStr = (@($types | Sort-Object -Unique) -join '/')
  $srcCount = @($ids).Count
  if (-not $hasLease) { $noLease += ("{0}  [{1} src docs, types: {2}]" -f $r.tenant_name, $srcCount, $typeStr) }
  if ($miss.Count -gt 0) { $missingItems += ("{0}: {1}" -f $r.tenant_name, ($miss -join ' | ')) }
}

Write-Output ""
Write-Output "=== ABSTRACTS WITH NO 'lease'-type source doc ($($noLease.Count)) - likely missing governing lease ==="
$noLease | ForEach-Object { Write-Output "  $_" }
Write-Output ""
Write-Output "=== ABSTRACTOR-RAISED 'MISSING FROM FILE' (lease/amendment/guaranty) ($($missingItems.Count)) ==="
$missingItems | ForEach-Object { Write-Output "  $_" }
