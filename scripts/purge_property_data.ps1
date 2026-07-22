# purge_property_data.ps1  (ASCII only - PS 5.1)
# Per-property PURGE: removes every Project record the platform holds for one
# property -- database rows (FK-closure, policy-driven) AND storage mirror
# objects -- in support of PMA s.9.03 (destroy-or-return, return of all copies
# of Personal Information on termination) and s.1.03. See memory topic
# project_pma_data_compliance and migration 20240122_property_purge_export.sql.
#
# SAFETY MODEL
#   * INERT until migration 20240122 is applied: without the RPCs this script
#     prints a notice and exits. It cannot touch production before then.
#   * DRY RUN is the default: prints the full plan (table, action, row count,
#     storage objects) and records a purge_log row with mode='dry_run'.
#   * EXECUTE requires ALL of: -Execute, -AcknowledgeExported (you exported the
#     handover bundle first -- s.1.03 deliver-before-destroy), and
#     -ConfirmText "PURGE <exact property name>". The confirmation text is ALSO
#     re-validated server-side on every single RPC call.
#   * The server refuses to run if ANY closure table lacks a purge_policy row
#     (new feature tables must be classified before any purge can proceed).
#   * The properties row itself is never deleted. K:/V: file-server originals
#     are never touched. Supabase BACKUPS cannot be selectively purged -- they
#     age out on the project's retention window (note this in the runbook).
#
# WHAT IT DOES (execute mode, in order)
#   1. nullify links (e.g. pipeline_deals.transaction_id -> purged transactions)
#   2. delete rows child-first (closure depth DESC), FK-violation retry passes
#   3. orphan-clean shared masters (tenants with no remaining references)
#   4. delete storage objects under p/<property_id>/ in every bucket
#   5. refresh GL matviews, verify all delete-tables count 0, close purge_log
#
# Examples
#   .\purge_property_data.ps1 -PropertyName "Gateway Port Chester"            # dry run
#   .\purge_property_data.ps1 -PropertyName "Gateway Port Chester" -Execute `
#       -AcknowledgeExported -ConfirmText "PURGE Gateway Port Chester"

param(
  [Parameter(Mandatory = $true)][string]$PropertyName,
  [switch]$Execute,
  [string]$ConfirmText = '',
  [switch]$AcknowledgeExported,
  [switch]$SkipStorage,
  [int]$MaxPasses = 3
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------
$envPath = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
if (-not (Test-Path $envPath)) { throw ".env not found at $envPath" }
$envMap = @{}
foreach ($line in [IO.File]::ReadAllLines($envPath)) {
  if ($line -match '^\s*([A-Z_0-9]+)\s*=\s*(.*)$') { $envMap[$Matches[1]] = $Matches[2].Trim() }
}
$secretKey  = $envMap['SUPABASE_SECRET_KEY']
$serviceJwt = $envMap['SUPABASE_SERVICE_JWT']
$supaUrl    = $envMap['VITE_SUPABASE_URL']
if (-not $secretKey -or -not $supaUrl) { throw 'SUPABASE_SECRET_KEY / VITE_SUPABASE_URL missing from .env' }

$restHeaders = @{ apikey = $secretKey; Authorization = "Bearer $secretKey" }

function Invoke-Rpc([string]$fn, [hashtable]$rpcBody) {
  # PS 5.1 gotcha: IRM emits a JSON array as ONE pipeline object; assigning to a
  # variable and returning THAT enumerates it, so callers can safely @( ) us.
  $json = $rpcBody | ConvertTo-Json -Compress -Depth 6
  $resp = Invoke-RestMethod -Method Post -Uri "$supaUrl/rest/v1/rpc/$fn" -Body $json `
    -ContentType 'application/json' -Headers $restHeaders -UserAgent 'cre-purge/1.0'
  if ($null -eq $resp) { return @() }
  return $resp
}

function Get-ErrBody($err) {
  if ($err.ErrorDetails -and $err.ErrorDetails.Message) { return $err.ErrorDetails.Message }
  return $err.Exception.Message
}

# ---------------------------------------------------------------------------
# Preflight: property + plan (inert without migration 20240122)
# ---------------------------------------------------------------------------
$propResp = Invoke-RestMethod -Method Get `
  -Uri ("$supaUrl/rest/v1/properties?select=id,name&name=eq." + [uri]::EscapeDataString($PropertyName)) `
  -Headers $restHeaders -UserAgent 'cre-purge/1.0'
$propRows = @()
if ($null -ne $propResp) { $propRows = @($propResp) }
if ($propRows.Count -eq 0) { throw "No property named '$PropertyName' (must match public.properties.name exactly)" }
$propId = $propRows[0].id
$propNameExact = $propRows[0].name

$plan = $null
try {
  $plan = @(Invoke-Rpc 'property_purge_plan' @{ p_property_id = $propId })
} catch {
  Write-Host 'Migration 20240122 (property_purge_export) is NOT applied.'
  Write-Host 'This tool is intentionally inert until it is: apply the migration on a'
  Write-Host 'branch database first, rehearse there, then apply to production with'
  Write-Host 'explicit approval. Nothing was changed.'
  exit 2
}

$unclassified = @($plan | Where-Object { $_.status -ne 'ok' })
if ($unclassified.Count -gt 0) {
  Write-Host 'BLOCKED - these closure tables have no purge_policy row (new since the'
  Write-Host 'policy was seeded). Classify each (delete/keep/nullify) before any purge:'
  foreach ($u in $unclassified) { Write-Host ("  - " + $u.table_name) }
  exit 3
}

# ---------------------------------------------------------------------------
# Inventory (dry run + execute both start here)
# ---------------------------------------------------------------------------
Write-Host ("Property: $propNameExact ($propId)")
Write-Host ("Plan: " + $plan.Count + " policy rows across " + (@($plan | Select-Object -ExpandProperty table_name -Unique).Count) + " tables")
Write-Host ""
Write-Host ("{0,-5} {1,-8} {2,-34} {3,10}" -f 'Depth', 'Action', 'Table', 'Rows')

$countMap = [ordered]@{}
foreach ($row in ($plan | Sort-Object -Property @{e={[int]$_.depth}; Descending=$true}, table_name)) {
  if ($row.action -eq 'nullify') {
    Write-Host ("{0,-5} {1,-8} {2,-34} {3,10}" -f $row.depth, $row.action, ($row.table_name + '.' + $row.detail), '-')
    continue
  }
  if (-not $countMap.Contains($row.table_name)) {
    $n = [long](Invoke-Rpc 'property_purge_count' @{ p_property_id = $propId; p_table = $row.table_name })
    $countMap[$row.table_name] = @{ action = $row.action; rows = $n; depth = [int]$row.depth }
    Write-Host ("{0,-5} {1,-8} {2,-34} {3,10}" -f $row.depth, $row.action, $row.table_name, $n)
  }
}

# Storage inventory: objects under p/<propId>/ in every bucket
$storageInv = @()
$storageHeaders = $null
if ($serviceJwt) {
  $storageHeaders = @{ apikey = $serviceJwt; Authorization = "Bearer $serviceJwt" }
  $bucketResp = Invoke-RestMethod -Method Get -Uri "$supaUrl/storage/v1/bucket" -Headers $storageHeaders -UserAgent 'cre-purge/1.0'
  $bucketList = @()
  if ($null -ne $bucketResp) { $bucketList = @($bucketResp) }
  foreach ($bucket in $bucketList) {
    $bname = $bucket.name
    $paths = New-Object System.Collections.Generic.List[string]
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue("p/$propId")
    while ($queue.Count -gt 0) {
      $prefix = $queue.Dequeue()
      $offset = 0
      while ($true) {
        $listBody = @{ prefix = $prefix; limit = 1000; offset = $offset } | ConvertTo-Json -Compress
        $itemsResp = Invoke-RestMethod -Method Post -Uri "$supaUrl/storage/v1/object/list/$bname" -Body $listBody -ContentType 'application/json' -Headers $storageHeaders -UserAgent 'cre-purge/1.0'
        $items = @()
        if ($null -ne $itemsResp) { $items = @($itemsResp) }
        if ($items.Count -eq 0) { break }
        foreach ($it in $items) {
          $full = "$prefix/" + $it.name
          if ($null -eq $it.id) { $queue.Enqueue($full) } else { $paths.Add($full) }
        }
        if ($items.Count -lt 1000) { break }
        $offset += 1000
      }
    }
    $storageInv += @{ bucket = $bname; paths = $paths }
    Write-Host ("{0,-5} {1,-8} {2,-34} {3,10}" -f '-', 'storage', ("bucket " + $bname + " p/" + $propId + "/"), $paths.Count)
  }
} else {
  Write-Warning 'SUPABASE_SERVICE_JWT missing - storage inventory/deletion unavailable this run.'
}

# purge_log row (dry_run and execute both log; Prefer return=representation is required)
$tableCounts = @{}
foreach ($k in $countMap.Keys) { $tableCounts[$k] = $countMap[$k].rows }
$storageSummary = @{}
foreach ($s in $storageInv) { $storageSummary[$s.bucket] = $s.paths.Count }
$logBody = @(@{
  property_id = $propId; property_name = $propNameExact
  mode = $(if ($Execute) { 'execute' } else { 'dry_run' })
  notes = 'purge_property_data.ps1'
  table_counts = $tableCounts; storage_summary = $storageSummary
}) | ConvertTo-Json -Depth 6
$logRow = Invoke-RestMethod -Method Post -Uri "$supaUrl/rest/v1/purge_log" -Body $logBody `
  -ContentType 'application/json' -Headers ($restHeaders + @{ Prefer = 'return=representation' }) -UserAgent 'cre-purge/1.0'
$logId = $logRow[0].id

if (-not $Execute) {
  Write-Host ""
  Write-Host 'DRY RUN complete - nothing was deleted. Logged to purge_log as dry_run.'
  Write-Host 'To execute: export the handover bundle first (export_property_data.ps1),'
  Write-Host ("then re-run with: -Execute -AcknowledgeExported -ConfirmText " + '"PURGE ' + $propNameExact + '"')
  exit 0
}

# ---------------------------------------------------------------------------
# EXECUTE gates
# ---------------------------------------------------------------------------
if (-not $AcknowledgeExported) {
  throw 'Refusing to execute: run export_property_data.ps1 first, then pass -AcknowledgeExported (s.1.03 deliver-before-destroy).'
}
if ($ConfirmText -cne ('PURGE ' + $propNameExact)) {
  throw ('Refusing to execute: -ConfirmText must be exactly "PURGE ' + $propNameExact + '"')
}

# 1) nullify link columns
foreach ($row in @($plan | Where-Object { $_.action -eq 'nullify' })) {
  $res = Invoke-Rpc 'property_purge_execute_table' @{ p_property_id = $propId; p_table = $row.table_name; p_confirm = $ConfirmText }
  Write-Host ("nullify {0}.{1}: {2} rows" -f $row.table_name, $row.detail, $res.nulled)
}

# 2) deletes in FK-topological order (property_purge_order: children before the
#    tables they reference; closure depth alone is NOT safe -- e.g. leases
#    references documents at the same depth), retry passes for true FK cycles
$orderRows = @(Invoke-Rpc 'property_purge_order' @{})
$deleteTables = @($orderRows | Sort-Object { [int]$_.seq } | ForEach-Object { $_.table_name } |
  Where-Object { $countMap.Contains($_) -and $countMap[$_].action -eq 'delete' })
$missing = @($countMap.Keys | Where-Object { $countMap[$_].action -eq 'delete' -and ($deleteTables -notcontains $_) })
if ($missing.Count -gt 0) { $deleteTables = @($deleteTables + $missing) }
$pending = $deleteTables
$results = [ordered]@{}
for ($pass = 1; $pass -le $MaxPasses -and $pending.Count -gt 0; $pass++) {
  $failed = @()
  foreach ($tbl in $pending) {
    try {
      $res = Invoke-Rpc 'property_purge_execute_table' @{ p_property_id = $propId; p_table = $tbl; p_confirm = $ConfirmText }
      $results[$tbl] = [long]$res.deleted
      Write-Host ("pass {0}: {1,-34} deleted {2}" -f $pass, $tbl, $res.deleted)
    } catch {
      $failed += $tbl
      Write-Warning ("pass {0}: {1} failed: {2}" -f $pass, $tbl, (Get-ErrBody $_))
    }
  }
  $pending = $failed
}
if ($pending.Count -gt 0) {
  throw ('Tables still failing after ' + $MaxPasses + ' passes: ' + ($pending -join ', ') + ' - investigate before re-running (re-runs are safe/idempotent).')
}

# 3) orphaned shared masters
$orphans = Invoke-Rpc 'property_purge_orphan_tenants' @{ p_property_id = $propId; p_confirm = $ConfirmText }
Write-Host ("orphan-cleaned tenants: " + $orphans)

# 4) storage objects
$storageDeleted = 0
if (-not $SkipStorage) {
  if (-not $storageHeaders) { throw 'Storage deletion requires SUPABASE_SERVICE_JWT (or pass -SkipStorage and handle storage separately).' }
  foreach ($s in $storageInv) {
    $bname = $s.bucket
    for ($i = 0; $i -lt $s.paths.Count; $i += 100) {
      $hi = [Math]::Min($i + 99, $s.paths.Count - 1)
      $batch = @($s.paths[$i..$hi])
      $delBody = @{ prefixes = $batch } | ConvertTo-Json -Compress -Depth 3
      Invoke-RestMethod -Method Delete -Uri "$supaUrl/storage/v1/object/$bname" -Body $delBody `
        -ContentType 'application/json' -Headers $storageHeaders -UserAgent 'cre-purge/1.0' | Out-Null
      $storageDeleted += $batch.Count
    }
    if ($s.paths.Count -gt 0) { Write-Host ("storage: deleted {0} objects from bucket {1}" -f $s.paths.Count, $bname) }
  }
} else {
  Write-Warning 'Storage deletion SKIPPED (-SkipStorage) - mirrored objects remain.'
}

# 5) matviews + verify + close the log
$mv = Invoke-Rpc 'property_purge_refresh_matviews' @{}
Write-Host ("matviews: " + $mv)

$residual = [ordered]@{}
foreach ($tbl in $deleteTables) {
  $n = [long](Invoke-Rpc 'property_purge_count' @{ p_property_id = $propId; p_table = $tbl })
  if ($n -gt 0) { $residual[$tbl] = $n }
}
if ($residual.Count -gt 0) {
  Write-Warning 'VERIFY: residual rows remain (investigate):'
  foreach ($k in $residual.Keys) { Write-Warning ("  {0}: {1}" -f $k, $residual[$k]) }
} else {
  Write-Host 'VERIFY: all delete-class tables report 0 rows for this property.'
}

$patch = @{ completed_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
            table_counts = $results; storage_summary = @{ deleted_objects = $storageDeleted } } | ConvertTo-Json -Depth 6
Invoke-RestMethod -Method Patch -Uri ("$supaUrl/rest/v1/purge_log?id=eq." + $logId) -Body $patch `
  -ContentType 'application/json' -Headers ($restHeaders + @{ Prefer = 'return=representation' }) -UserAgent 'cre-purge/1.0' | Out-Null

Write-Host ""
Write-Host ("PURGE COMPLETE for " + $propNameExact + " (purge_log " + $logId + ")")
Write-Host 'Reminders: properties row retained by design; K:/V: originals untouched;'
Write-Host 'Supabase backups age out on the retention window; Anthropic Batches API'
Write-Host 'results expire ~29 days after creation.'
