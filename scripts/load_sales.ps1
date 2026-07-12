# load_sales.ps1 - loads tenant gross-sales reports into pct_rent_records.
# Source: the K: "Sales Report" workbooks (tenant blocks: col A index, col B name,
# col C year, cols D-O Jan-Dec). The KM workbook covers BOTH KM-West (#0531) and
# KM-East (#0532) split by section header rows. Idempotent: deletes the target
# property's rows for the loaded years, then bulk-inserts via curl.
# Loads years >= 2024. Skips empty cells and exact-zero placeholders.
param([int]$MinYear = 2024)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$tmp = "$env:TEMP\load_sales"
New-Item -ItemType Directory -Force $tmp | Out-Null

$GW  = 'd5a4ed03-0b60-4168-9208-83822dd24884'
$MAG = 'd4f08824-2d88-472d-b7aa-a703310c2aaf'
$KME = '00000000-0000-0000-0000-000000000010'
$KMW = '00000000-0000-0000-0000-000000000011'

$books = @(
  @{ path = 'K:\RETAIL\PROPERTY INFORMATION\Gateway Port Chester\Sales & Percentage Rent\Gateway Port Chester Sales Report - 2026 v1 - Copy.xlsx'; sheet = 1; prop = $GW;  sections = $null },
  @{ path = 'K:\RETAIL\PROPERTY INFORMATION\Magnolia Park\Sales & Percentage Rent\Magnolia Park Sales Report - 2026 v1.xlsx';                     sheet = 1; prop = $MAG; sections = $null },
  @{ path = 'K:\RETAIL\PROPERTY INFORMATION\Knightdale Marketplace\Sales & Percentage Rent\Knightdale Marketplace Sales Report - 2025 v1.xlsx';   sheet = 1; prop = $null; sections = @{ '0531' = $KMW; 'KM-West' = $KMW; 'Midtown' = $KMW; '0532' = $KME; 'KM-East' = $KME; 'Midway' = $KME } }
)

function NormName([string]$s) {
  $t = $s.ToLower() -replace '\(.*?\)', '' -replace '&', ' and '
  # strip diacritics (Cafe/Café)
  $t = $t.Normalize([Text.NormalizationForm]::FormD) -replace '\p{Mn}', ''
  return ($t -replace '[^a-z0-9]', '')
}

# leases + tenants per property for matching (service key; curl UA rule)
function Get-LeaseMap([string]$prop) {
  $rows = Invoke-RestMethod -Uri "$BASE/rest/v1/leases?select=id,tenant_id,tenants(name,trade_name)&property_id=eq.$prop" -Headers $H -UserAgent $UA -TimeoutSec 60
  $map = @()
  foreach ($r in $rows) {
    $names = @($r.tenants.name, $r.tenants.trade_name) | Where-Object { $_ }
    foreach ($n in $names) { $map += [pscustomobject]@{ norm = (NormName $n); lease_id = $r.id; tenant_id = $r.tenant_id } }
  }
  return $map
}
function Match-Lease($map, [string]$tenant) {
  $n = NormName ($tenant -replace '#\S+', '')
  if ($n.Length -lt 3) { return $null }
  foreach ($m in $map) { if ($m.norm -eq $n) { return $m } }
  foreach ($m in $map) { if ($m.norm.Length -ge 4 -and $n.Length -ge 4 -and ($m.norm.StartsWith($n) -or $n.StartsWith($m.norm) -or $m.norm.Contains($n) -or $n.Contains($m.norm))) { return $m } }
  return $null
}

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false; $excel.DisplayAlerts = $false
$all = @{}   # prop -> list of rows
$missLog = @()
try {
  foreach ($b in $books) {
    $wb = $excel.Workbooks.Open($b.path, 0, $true)
    $ws = $wb.Worksheets.Item($b.sheet)
    $ur = $ws.UsedRange; $vals = $ur.Value2
    $nRows = $ur.Rows.Count
    $prop = $b.prop
    $tenant = $null
    for ($r = 1; $r -le $nRows; $r++) {
      $a = $vals[$r, 1]; $bcol = $vals[$r, 2]; $c = $vals[$r, 3]
      $bstr = if ($bcol -ne $null) { ([string]$bcol).Trim() } else { '' }
      # section headers (KM only)
      if ($b.sections -and $bstr) {
        foreach ($k in $b.sections.Keys) { if ($bstr -like "*$k*") { $prop = $b.sections[$k]; break } }
      }
      # a tenant block starts where col A is a number and col B has the name
      if ($a -is [double] -and $bstr -and $bstr -notmatch '^(Sales Report|Percentage Rent|Lease Year|Breakpoint|\()') {
        $tenant = $bstr
      }
      # year rows carry col C = 2000..2030
      if ($tenant -and $prop -and $c -is [double] -and $c -ge $MinYear -and $c -le 2030) {
        for ($m = 1; $m -le 12; $m++) {
          $v = $vals[$r, (3 + $m)]
          if ($v -is [double] -and [math]::Abs($v) -gt 0) {
            if (-not $all.ContainsKey($prop)) { $all[$prop] = New-Object System.Collections.Generic.List[object] }
            $all[$prop].Add([pscustomobject]@{ tenant = $tenant; year = [int]$c; month = $m; sales = [math]::Round($v, 2) })
          }
        }
      }
    }
    $wb.Close($false)
    Write-Output ("parsed {0}" -f (Split-Path $b.path -Leaf))
  }
} finally { $excel.Quit(); [Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null }

foreach ($prop in $all.Keys) {
  $map = Get-LeaseMap $prop
  $rows = @()
  $misses = @{}
  foreach ($x in $all[$prop]) {
    $m = Match-Lease $map $x.tenant
    if ($m -eq $null) { $misses[$x.tenant] = $true; continue }
    $rows += [ordered]@{
      id = [guid]::NewGuid().ToString()
      lease_id = $m.lease_id; property_id = $prop; tenant_id = $m.tenant_id
      period_year = $x.year; period_month = $x.month
      reported_sales = $x.sales; is_annual_reconciliation = $false
      notes = ('sales report: ' + $x.tenant)
    }
  }
  foreach ($t in $misses.Keys) { $missLog += "MISS [$prop]: $t" }
  if (-not $rows.Count) { Write-Output "no matched rows for $prop"; continue }

  # idempotent per property+years
  $del = Invoke-WebRequest -Method Delete -Uri "$BASE/rest/v1/pct_rent_records?property_id=eq.$prop&period_year=gte.$MinYear" -Headers $H -UserAgent $UA -UseBasicParsing -TimeoutSec 120
  Write-Output ("deleted old rows for {0}: {1}" -f $prop, $del.StatusCode)

  for ($i = 0; $i -lt $rows.Count; $i += 200) {
    $batch = $rows[$i..([math]::Min($i + 199, $rows.Count - 1))]
    $json = ConvertTo-Json @($batch) -Depth 4 -Compress
    $f = "$tmp\batch.json"
    [IO.File]::WriteAllText($f, $json, (New-Object Text.UTF8Encoding($false)))
    $resp = & curl.exe -s -o "$tmp\resp.json" -w '%{http_code}' -X POST "$BASE/rest/v1/pct_rent_records" `
      -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Prefer: return=representation" `
      --data-binary "@$f"
    if ($resp -ne '201') { throw "insert failed ($resp): $(Get-Content "$tmp\resp.json" -Raw)" }
  }
  Write-Output ("loaded {0} rows for {1}" -f $rows.Count, $prop)
}
$missLog | ForEach-Object { Write-Output $_ }
Write-Output 'done'
