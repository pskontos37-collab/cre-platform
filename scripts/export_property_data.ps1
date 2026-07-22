# export_property_data.ps1  (ASCII only - PS 5.1)
# READ-ONLY export of everything the platform holds for ONE property, in support
# of PMA s.1.03 (termination handover: deliver all books/records/documents) and
# s.9.03 (return of Personal Information). See memory topic
# project_pma_data_compliance and migration 20240122_property_purge_export.sql.
#
# Produces <OutDir>\
#   README.txt              run summary + row counts (delivery cover sheet)
#   counts.csv              per-table row counts
#   tables\<table>.csv      one CSV per table (vector/tsvector columns excluded)
#   pdfs\...                mirrored storage objects (only with -IncludePdfs)
# tables\documents.csv doubles as the document manifest: it carries the original
# file-server path (file_path), the storage mirror path (storage_path), sha256,
# and dates for every document.
#
# MODES
#   Plan-driven (preferred): if migration 20240122 is applied, the table list +
#     predicates come from property_purge_plan() so coverage always matches the
#     live schema. Tables marked keep (firm ledgers) are skipped unless
#     -IncludeKeep.
#   Static fallback: if the migration is NOT applied (current state), an
#     embedded predicate map generated from the FK closure on 2026-07-21 is
#     used. If the schema has grown since, re-generate or apply the migration.
#
# This script performs NO writes: reads go through the Supabase Management API
# (SELECT only) and, for -IncludePdfs, the Storage object endpoints.
#
# Examples
#   .\export_property_data.ps1 -PropertyName "Gateway Port Chester"
#   .\export_property_data.ps1 -PropertyName "Gateway Port Chester" -IncludePdfs -PdfLimit 25

param(
  [Parameter(Mandatory = $true)][string]$PropertyName,
  [string]$OutDir = '',
  [switch]$IncludePdfs,
  [int]$PdfLimit = 0,          # 0 = no cap
  [switch]$IncludeKeep,
  [int]$PageSize = 5000
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Environment (.env at repo root)
# ---------------------------------------------------------------------------
$envPath = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
if (-not (Test-Path $envPath)) { throw ".env not found at $envPath" }
$envMap = @{}
foreach ($line in [IO.File]::ReadAllLines($envPath)) {
  if ($line -match '^\s*([A-Z_0-9]+)\s*=\s*(.*)$') { $envMap[$Matches[1]] = $Matches[2].Trim() }
}
$projectRef  = $envMap['SUPABASE_PROJECT_REF']
$accessToken = $envMap['SUPABASE_ACCESS_TOKEN']
$secretKey   = $envMap['SUPABASE_SECRET_KEY']
$serviceJwt  = $envMap['SUPABASE_SERVICE_JWT']
$supaUrl     = $envMap['VITE_SUPABASE_URL']
if (-not $projectRef -or -not $accessToken) { throw 'SUPABASE_PROJECT_REF / SUPABASE_ACCESS_TOKEN missing from .env' }

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Invoke-MgmtSql([string]$sql) {
  # Management API runs read-only SELECTs here; returns parsed JSON rows.
  # PS 5.1 gotcha: IRM emits a JSON array as ONE pipeline object; assigning to a
  # variable and returning THAT enumerates it, so callers can safely @( ) us.
  $body = @{ query = $sql } | ConvertTo-Json -Compress -Depth 4
  $uri = "https://api.supabase.com/v1/projects/$projectRef/database/query"
  $resp = Invoke-RestMethod -Method Post -Uri $uri -Body $body -ContentType 'application/json' `
    -Headers @{ Authorization = "Bearer $accessToken" } -UserAgent 'cre-export/1.0'
  if ($null -eq $resp) { return @() }
  return $resp
}

function Invoke-Rpc([string]$fn, [hashtable]$rpcBody) {
  $uri = "$supaUrl/rest/v1/rpc/$fn"
  $json = $rpcBody | ConvertTo-Json -Compress -Depth 4
  $resp = Invoke-RestMethod -Method Post -Uri $uri -Body $json -ContentType 'application/json' `
    -Headers @{ apikey = $secretKey; Authorization = "Bearer $secretKey" } -UserAgent 'cre-export/1.0'
  if ($null -eq $resp) { return @() }
  return $resp
}

function Sql-Quote([string]$s) { return "'" + ($s -replace "'", "''") + "'" }

function Flatten-Value($v) {
  if ($null -eq $v) { return $null }
  if ($v -is [System.Management.Automation.PSCustomObject] -or $v -is [System.Array]) {
    return ($v | ConvertTo-Json -Compress -Depth 20)
  }
  return $v
}

# ---------------------------------------------------------------------------
# Resolve property
# ---------------------------------------------------------------------------
$propRows = Invoke-MgmtSql ("select id, name from properties where name = " + (Sql-Quote $PropertyName))
if (-not $propRows -or $propRows.Count -eq 0) { throw "No property named '$PropertyName' (must match public.properties.name exactly)" }
$propId = $propRows[0].id
$propNameExact = $propRows[0].name
Write-Host "Property: $propNameExact ($propId)"

if (-not $OutDir) {
  $stamp = Get-Date -Format 'yyyyMMdd_HHmm'
  $safe = ($propNameExact -replace '[^A-Za-z0-9]+', '_').Trim('_')
  $OutDir = Join-Path $PSScriptRoot ("exports\" + $safe + "_" + $stamp)
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $OutDir 'tables') | Out-Null

# ---------------------------------------------------------------------------
# Build table -> predicate list (plan-driven if migration 20240122 is applied)
# ---------------------------------------------------------------------------
$planRows = $null
try {
  $planRows = Invoke-Rpc 'property_purge_plan' @{ p_property_id = $propId }
  Write-Host 'Using plan-driven table list (migration 20240122 detected).'
} catch {
  Write-Host 'Migration 20240122 not applied - using embedded static table map (generated 2026-07-21).'
}

$targets = @()   # array of @{ Table=..; Predicate=.. }
if ($planRows) {
  $unclassified = @($planRows | Where-Object { $_.status -ne 'ok' })
  if ($unclassified.Count -gt 0) {
    Write-Warning ("PLAN HAS UNCLASSIFIED TABLES (purge would refuse to run): " + (($unclassified | ForEach-Object { $_.table_name }) -join ', '))
  }
  foreach ($r in $planRows) {
    if ($r.action -eq 'nullify') { continue }
    if ($r.action -eq 'keep' -and -not $IncludeKeep) { continue }
    if ($r.action -eq 'UNCLASSIFIED' -and -not $r.predicate) { continue }
    if ($r.predicate) { $targets += @{ Table = $r.table_name; Predicate = $r.predicate } }
  }
} else {
  # Static map from the validated FK closure (2026-07-21). {PID} is replaced below.
  $docsIn = "(select id from documents where property_id = '{PID}')"
  $staticMap = [ordered]@{
    # depth 1: property_id direct
    'documents'                      = "property_id = '{PID}'"
    'document_chunks'                = "property_id = '{PID}'"
    'leases'                         = "property_id = '{PID}'"
    'units'                          = "property_id = '{PID}'"
    'gl_entries'                     = "property_id = '{PID}'"
    'financial_periods'              = "property_id = '{PID}'"
    'invoices'                       = "property_id = '{PID}'"
    'invoice_distributions'          = "property_id = '{PID}'"
    'invoice_dup_dismissals'         = "property_id = '{PID}'"
    'ar_aging'                       = "property_id = '{PID}'"
    'ar_followups'                   = "property_id = '{PID}'"
    'ar_notes'                       = "property_id = '{PID}'"
    'budget_lines'                   = "property_id = '{PID}'"
    'cam_reconciliations'            = "property_id = '{PID}'"
    'lease_abstracts'                = "property_id = '{PID}'"
    'lease_payments'                 = "property_id = '{PID}'"
    'lease_rm_matrix'                = "property_id = '{PID}'"
    'critical_dates'                 = "property_id = '{PID}'"
    'critical_events'                = "property_id = '{PID}'"
    'termination_rights'             = "property_id = '{PID}'"
    'property_exclusives'            = "property_id = '{PID}'"
    'co_tenancy_flags'               = "property_id = '{PID}'"
    'rea_agreements'                 = "property_id = '{PID}'"
    'management_agreements'          = "property_id = '{PID}'"
    'management_agreement_deadlines' = "property_id = '{PID}'"
    'brokerage_agreements'           = "property_id = '{PID}'"
    'service_agreements'             = "property_id = '{PID}'"
    'generated_service_agreements'   = "property_id = '{PID}'"
    'insurance_requirements'         = "property_id = '{PID}'"
    'coi_certificates'               = "property_id = '{PID}'"
    'coi_requests'                   = "property_id = '{PID}'"
    'work_orders'                    = "property_id = '{PID}'"
    'work_order_portal_users'        = "property_id = '{PID}'"
    'tenant_contacts'                = "property_id = '{PID}'"
    'tenant_announcements'           = "property_id = '{PID}'"
    'tasks'                          = "property_id = '{PID}'"
    'inspections'                    = "property_id = '{PID}'"
    'emergency_manuals'              = "property_id = '{PID}'"
    'entitlements'                   = "property_id = '{PID}'"
    'market_reports'                 = "property_id = '{PID}'"
    'monthly_reports'                = "property_id = '{PID}'"
    'mri_recon_status'               = "property_id = '{PID}'"
    'rent_roll_rows'                 = "property_id = '{PID}'"
    'rent_roll_snapshots'            = "property_id = '{PID}'"
    'drive_file_catalog'             = "property_id = '{PID}'"
    'import_jobs'                    = "property_id = '{PID}'"
    'loans'                          = "property_id = '{PID}'"
    'pct_rent_records'               = "property_id = '{PID}'"
    'site_plan_regions'              = "property_id = '{PID}'"
    'doc_abstracts'                  = "property_id = '{PID}'"
    'doc_briefs'                     = "property_id = '{PID}'"
    'abstract_jobs'                  = "property_id = '{PID}'"
    'abstract_refresh_log'           = "property_id = '{PID}'"
    'capital_flow_gl_map'            = "property_id = '{PID}'"
    'transaction_properties'         = "property_id = '{PID}'"
    'transactions'                   = "primary_property_id = '{PID}'"
    'coi_review_queue'               = "suggested_property_id = '{PID}' or document_id in $docsIn"
    # depth 2+ (via parent)
    'ar_aging_detail'                = "ar_aging_id in (select id from ar_aging where property_id = '{PID}')"
    'co_tenancy_clauses'             = "lease_id in (select id from leases where property_id = '{PID}') or source_abstract_id in (select id from lease_abstracts where property_id = '{PID}')"
    'co_tenancy_named_tenants'       = "clause_id in (select id from co_tenancy_clauses where lease_id in (select id from leases where property_id = '{PID}'))"
    'coi_coverages'                  = "certificate_id in (select id from coi_certificates where property_id = '{PID}')"
    'insurance_requirement_coverages'= "requirement_id in (select id from insurance_requirements where property_id = '{PID}')"
    'lease_cam_terms'                = "lease_id in (select id from leases where property_id = '{PID}')"
    'lease_options'                  = "lease_id in (select id from leases where property_id = '{PID}')"
    'lease_rent_schedule'            = "lease_id in (select id from leases where property_id = '{PID}')"
    'loan_covenant_checks'           = "loan_id in (select id from loans where property_id = '{PID}')"
    'operating_line_items'           = "financial_period_id in (select id from financial_periods where property_id = '{PID}') or unit_id in (select id from units where property_id = '{PID}')"
    'task_checklist_items'           = "task_id in (select id from tasks where property_id = '{PID}')"
    'tenant_announcement_recipients' = "announcement_id in (select id from tenant_announcements where property_id = '{PID}')"
    'work_order_comments'            = "work_order_id in (select id from work_orders where property_id = '{PID}')"
    'work_order_photos'              = "work_order_id in (select id from work_orders where property_id = '{PID}')"
    'abstract_item_resolutions'      = "abstract_id in (select id from lease_abstracts where property_id = '{PID}') or task_id in (select id from tasks where property_id = '{PID}')"
    'document_relationships'         = "from_document_id in $docsIn or to_document_id in $docsIn"
    'om_intake'                      = "source_document_id in $docsIn"
    'pipeline_deal_documents'        = "document_id in $docsIn"
    'transaction_documents'          = "transaction_id in (select id from transactions where primary_property_id = '{PID}') or document_id in $docsIn"
    'transaction_figures'            = "transaction_id in (select id from transactions where primary_property_id = '{PID}') or document_id in $docsIn"
    # shared master: tenants referenced by this property (exported, purge only orphan-cleans)
    'tenants'                        = "id in (select tenant_id from leases where property_id = '{PID}' and tenant_id is not null) or id in (select tenant_id from documents where property_id = '{PID}' and tenant_id is not null)"
  }
  foreach ($k in $staticMap.Keys) { $targets += @{ Table = $k; Predicate = $staticMap[$k] } }
}

# ---------------------------------------------------------------------------
# Export each table (vector/tsvector columns excluded; jsonb flattened)
# ---------------------------------------------------------------------------
$counts = [ordered]@{}
foreach ($t in $targets) {
  $tbl = $t.Table
  $pred = $t.Predicate -replace '\{PID\}', $propId

  $cntRows = Invoke-MgmtSql "select count(*)::int as n from $tbl where $pred"
  $n = [int]$cntRows[0].n
  $counts[$tbl] = $n
  if ($n -eq 0) { Write-Host ("  {0,-34} 0 rows (skipped)" -f $tbl); continue }

  $colRows = Invoke-MgmtSql ("select column_name, udt_name from information_schema.columns where table_schema='public' and table_name=" + (Sql-Quote $tbl) + " order by ordinal_position")
  $cols = @($colRows | Where-Object { $_.udt_name -ne 'vector' -and $_.udt_name -ne 'tsvector' } | ForEach-Object { '"' + $_.column_name + '"' })
  $colList = $cols -join ', '

  $outCsv = Join-Path $OutDir ("tables\" + $tbl + '.csv')
  if (Test-Path $outCsv) { Remove-Item $outCsv -Force -Confirm:$false }
  $lastId = ''
  $fetched = 0
  while ($true) {
    $keyset = ''
    if ($lastId) { $keyset = " and id > '$lastId'" }
    $sql = "select $colList from $tbl where ($pred)$keyset order by id limit $PageSize"
    $rows = @(Invoke-MgmtSql $sql)
    if ($rows.Count -eq 0) { break }
    $flat = foreach ($r in $rows) {
      $o = [ordered]@{}
      foreach ($p in $r.PSObject.Properties) { $o[$p.Name] = Flatten-Value $p.Value }
      [pscustomobject]$o
    }
    $flat | Export-Csv -Path $outCsv -Append -NoTypeInformation -Encoding UTF8
    $fetched += $rows.Count
    $lastId = $rows[-1].id
    if ($rows.Count -lt $PageSize) { break }
  }
  if ($fetched -ne $n) {
    Write-Warning ("  {0}: fetched {1} rows but count(*) said {2} - verify before relying on this CSV" -f $tbl, $fetched, $n)
  }
  Write-Host ("  {0,-34} {1} rows -> {2}" -f $tbl, $fetched, (Split-Path $outCsv -Leaf))
}

# ---------------------------------------------------------------------------
# Storage mirror (optional)
# ---------------------------------------------------------------------------
$pdfCount = 0
$pdfBytes = [long]0
if ($IncludePdfs) {
  if (-not $serviceJwt) { throw '-IncludePdfs requires SUPABASE_SERVICE_JWT in .env (storage rejects sb_secret keys)' }
  $storageHeaders = @{ apikey = $serviceJwt; Authorization = "Bearer $serviceJwt" }
  New-Item -ItemType Directory -Force -Path (Join-Path $OutDir 'pdfs') | Out-Null

  $bucketList = Invoke-RestMethod -Method Get -Uri "$supaUrl/storage/v1/bucket" -Headers $storageHeaders -UserAgent 'cre-export/1.0'
  foreach ($bucket in $bucketList) {
    $bname = $bucket.name
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue("p/$propId")
    while ($queue.Count -gt 0) {
      $prefix = $queue.Dequeue()
      $offset = 0
      while ($true) {
        $listBody = @{ prefix = $prefix; limit = 1000; offset = $offset } | ConvertTo-Json -Compress
        $itemsResp = Invoke-RestMethod -Method Post -Uri "$supaUrl/storage/v1/object/list/$bname" -Body $listBody -ContentType 'application/json' -Headers $storageHeaders -UserAgent 'cre-export/1.0'
        $items = @()
        if ($null -ne $itemsResp) { $items = @($itemsResp) }
        if ($items.Count -eq 0) { break }
        foreach ($it in $items) {
          $full = "$prefix/" + $it.name
          if ($null -eq $it.id) { $queue.Enqueue($full); continue }   # folder
          if ($PdfLimit -gt 0 -and $pdfCount -ge $PdfLimit) { continue }
          $rel = $full.Substring(("p/$propId").Length).TrimStart('/')
          $dest = Join-Path (Join-Path $OutDir 'pdfs') ($bname + '\' + ($rel -replace '/', '\'))
          New-Item -ItemType Directory -Force -Path (Split-Path $dest -Parent) | Out-Null
          Invoke-RestMethod -Method Get -Uri "$supaUrl/storage/v1/object/$bname/$full" -Headers $storageHeaders -UserAgent 'cre-export/1.0' -OutFile $dest
          $pdfCount++
          if ($it.metadata -and $it.metadata.size) { $pdfBytes += [long]$it.metadata.size }
        }
        if ($items.Count -lt 1000) { break }
        $offset += 1000
      }
    }
  }
  Write-Host ("  storage: downloaded {0} objects ({1:N1} MB)" -f $pdfCount, ($pdfBytes / 1MB))
}

# ---------------------------------------------------------------------------
# README + counts
# ---------------------------------------------------------------------------
$counts.GetEnumerator() | ForEach-Object { [pscustomobject]@{ table = $_.Key; rows = $_.Value } } |
  Export-Csv -Path (Join-Path $OutDir 'counts.csv') -NoTypeInformation -Encoding UTF8

$readme = @()
$readme += "PROPERTY DATA EXPORT (PMA s.1.03 handover support)"
$readme += "Property : $propNameExact"
$readme += "Property id : $propId"
$readme += "Generated : " + (Get-Date -Format 'yyyy-MM-dd HH:mm') + " by export_property_data.ps1"
$readme += "Mode : " + $(if ($planRows) { 'plan-driven (migration 20240122)' } else { 'static map (2026-07-21 closure)' })
$readme += ""
$readme += "tables\documents.csv is the document manifest: file_path = original on the"
$readme += "K:/V: file servers, storage_path = cloud mirror object, content_sha256,"
$readme += "doc_type and dates per document."
$readme += ""
$readme += "Row counts per table are in counts.csv. Vector embeddings and full-text"
$readme += "index columns are derived data and are excluded from CSVs."
if ($IncludePdfs) { $readme += ("pdfs\ contains {0} mirrored storage objects ({1:N1} MB)." -f $pdfCount, ($pdfBytes / 1MB)) }
else { $readme += "Storage PDFs NOT included (re-run with -IncludePdfs; originals remain on K:/V:)." }
$readme += ""
$readme += "NOT included by design: firm-level records (investor/capital ledgers,"
$readme += "waterfall models, acquisition pipeline) - these are M&J Wilkow records,"
$readme += "not Owner Project books. Use -IncludeKeep to add them."
[IO.File]::WriteAllLines((Join-Path $OutDir 'README.txt'), $readme)

$total = 0; foreach ($v in $counts.Values) { $total += $v }
Write-Host ""
Write-Host ("EXPORT COMPLETE -> $OutDir")
Write-Host ("  tables: {0}   total rows: {1}   pdfs: {2}" -f $counts.Count, $total, $pdfCount)
