# load_ret_lumpsums.ps1 - loads the 2025 RET lump-sum billings for KM East (Midway)
# and KM West (Midtown) into cam_reconciliations as rec_type 'ret'.
#   Midway workbook: per-tenant computation tabs ('Taxes Now Due'); 'Revised' tabs
#   supersede originals; the BAF only carries the HomeGoods rebill.
#   Midtown workbook: BAF rows are authoritative (3 tenants).
#   actual_amount = lump-sum share due; estimated_amount = null (the lump sum IS
#   the billing - no on-account deposits). Magnolia's lump sums are NOT loaded
#   here: they are already inside the Magnolia CAM Rec V3 rows (billed TAX).
# Idempotent: deletes property+year+ret rows first.
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$tmp = "$env:TEMP\load_retls"
New-Item -ItemType Directory -Force $tmp | Out-Null

$KME = '00000000-0000-0000-0000-000000000010'
$KMW = '00000000-0000-0000-0000-000000000011'
$YEAR = 2025

function NormName([string]$s) {
  $t = $s.ToLower() -replace '\(.*?\)', '' -replace '&', ' and '
  $t = $t.Normalize([Text.NormalizationForm]::FormD) -replace '\p{Mn}', ''
  return ($t -replace '[^a-z0-9]', '')
}
function LoadMap([string]$propId) {
  $trows = Invoke-RestMethod -Uri "$BASE/rest/v1/leases?select=id,tenant_id,tenants(name,trade_name)&property_id=eq.$propId" -Headers $H -UserAgent $UA -TimeoutSec 60
  $m = @()
  foreach ($r in $trows) {
    foreach ($n in @($r.tenants.name, $r.tenants.trade_name)) { if ($n) { $m += [pscustomobject]@{ norm = (NormName $n); lease_id = $r.id; tenant_id = $r.tenant_id } } }
  }
  return $m
}
function MatchTenant($map, [string]$name) {
  $n = NormName $name
  foreach ($x in $map) { if ($x.norm -eq $n) { return $x } }
  foreach ($x in $map) { if ($x.norm.Length -ge 4 -and $n.Length -ge 4 -and ($x.norm.Contains($n) -or $n.Contains($x.norm))) { return $x } }
  return $null
}

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false; $excel.DisplayAlerts = $false
$rows = @()
try {
  # â”€â”€ Midway (KM East): per-tenant tabs, find 'Taxes Now Due' â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  $wb = $excel.Workbooks.Open('K:\Working Files - Knightdale Marketplace\RET Lump Sum\2025 RET Lump Sums\Midway\2025 RET Lump Sum- Midway.xlsx', 0, $true)
  $tabs = @{ 'Michaels' = 'Michaels'; 'Ross' = 'Ross'; 'Office Max' = 'OfficeMax'; 'Petsmart' = 'PetSmart'
             'Arbys Revised' = "Arby's"; 'Wells Fargo Revised' = 'Wells Fargo'; 'Home Goods' = 'HomeGoods' }
  foreach ($tab in $tabs.Keys) {
    $ws = $wb.Worksheets.Item($tab)
    $ur = $ws.UsedRange; $vals = $ur.Value2
    $amt = $null
    for ($r = 1; $r -le $ur.Rows.Count; $r++) {
      for ($c = 1; $c -le $ur.Columns.Count; $c++) {
        if ($vals[$r, $c] -is [string] -and ([string]$vals[$r, $c]).Trim() -eq 'Taxes Now Due') {
          for ($c2 = $c + 1; $c2 -le $ur.Columns.Count; $c2++) { $v = $vals[$r, $c2]; if ($v -is [double]) { $amt = [math]::Round($v, 2); break } }
        }
      }
    }
    if ($amt -eq $null) { Write-Output "WARN no 'Taxes Now Due' on tab '$tab'"; continue }
    $rows += [pscustomobject]@{ prop = $KME; name = $tabs[$tab]; amt = $amt; src = "Midway tab '$tab'" }
  }
  $wb.Close($false)

  # â”€â”€ Midtown (KM West): BAF rows â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  $wb = $excel.Workbooks.Open('K:\Working Files - Knightdale Marketplace\RET Lump Sum\2025 RET Lump Sums\Midtown\2025 RET Lump Sum- Midtown.xlsx', 0, $true)
  $ws = $wb.Worksheets.Item('BAF')
  $ur = $ws.UsedRange; $vals = $ur.Value2
  $sum = 0.0; $bafTotal = $null
  for ($r = 12; $r -le $ur.Rows.Count; $r++) {
    # UsedRange starts at column B -> local col 1 = B (property #), 2 = tenant, 5 = income cat, 6 = amount
    $cat = $vals[$r, 5]; $name = $vals[$r, 2]; $amt = $vals[$r, 6]
    $lbl = $vals[$r, 4]
    if ($lbl -is [string] -and $lbl -match 'TOTAL BILLABLE' -and $amt -is [double]) { $bafTotal = [math]::Round($amt, 2); continue }
    if ($cat -isnot [string] -or ([string]$cat).Trim() -ne 'RXL') { continue }
    if ($name -eq $null -or $amt -isnot [double] -or $amt -eq 0) { continue }
    $a = [math]::Round($amt, 2); $sum += $a
    $rows += [pscustomobject]@{ prop = $KMW; name = ([string]$name).Trim(); amt = $a; src = 'Midtown BAF' }
  }
  $wb.Close($false)
  Write-Output ("Midtown BAF: parsed sum={0:n2} workbook total={1:n2}" -f $sum, $bafTotal)
} finally { $excel.Quit(); [Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null }

foreach ($x in $rows) { Write-Output ("  {0}  {1}  {2:n2}" -f $(if ($x.prop -eq $KME) { 'KME' } else { 'KMW' }), $x.name, $x.amt) }

$maps = @{ $KME = (LoadMap $KME); $KMW = (LoadMap $KMW) }
foreach ($propId in $KME, $KMW) {
  $del = Invoke-WebRequest -Method Delete -Uri "$BASE/rest/v1/cam_reconciliations?property_id=eq.$propId&period_year=eq.$YEAR&rec_type=eq.ret" -Headers $H -UserAgent $UA -UseBasicParsing -TimeoutSec 120
  Write-Output ("deleted old ret ({0}): {1}" -f $propId.Substring($propId.Length - 2), $del.StatusCode)
}

$ok = 0
foreach ($x in $rows) {
  $row = [ordered]@{
    id = [guid]::NewGuid().ToString()
    property_id = $x.prop
    period_year = $YEAR
    rec_type = 'ret'
    actual_amount = $x.amt
    status = 'in_progress'
    notes = ("2025 RET lump-sum billing | tenant: {0} | {1} | billed as RXL when tax paid (no on-account deposits)" -f $x.name, $x.src)
  }
  $m = MatchTenant $maps[$x.prop] $x.name
  if ($m -ne $null) { $row.lease_id = $m.lease_id; $row.tenant_id = $m.tenant_id }
  $json = ConvertTo-Json $row -Depth 4 -Compress
  $f = "$tmp\row.json"
  [IO.File]::WriteAllText($f, $json, (New-Object Text.UTF8Encoding($false)))
  $resp = & curl.exe -s -o "$tmp\resp.json" -w '%{http_code}' -X POST "$BASE/rest/v1/cam_reconciliations" `
    -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Prefer: return=representation" `
    --data-binary "@$f"
  if ($resp -eq '201') { $ok++ } else { Write-Output "FAIL ($resp) $($x.name): $(Get-Content "$tmp\resp.json" -Raw)" }
}
Write-Output ("loaded {0}/{1} RET lump-sum rows" -f $ok, $rows.Count)

