# load_ar_aging.ps1 - loads MRI "Aged Delinquencies" exports into ar_aging
# (tenant rows) + ar_aging_detail (invoice-level lines, migration 20240034).
# Report structure (per tenant block):
#   header row : c1 '<bldg>-<leaseid>', c3 tenant name, c10 delq day
#   second row : c5 suite, c6 occupant status, c9 last-payment date serial, c10 last-payment amt
#   detail rows: c1 date serial (invoice), c2 category, c3 desc, c4 source (CH/NC/OP),
#                c5 amount, c6-10 buckets -> ar_aging_detail (one row per nonzero bucket)
#   cat subtotal: c1 category CODE (string), c3 desc, c5 total, c6-10 buckets - collected to jsonb
#   tenant total: c1 '<name> Total:' with c5 total, c6-10 buckets
#   grand total : c3 'Grand Total:' - used to validate the parsed sum
# Buckets: Amount / Current / 30 / 60 / 90 / 120+ (the header labels the last
# bucket with the max age in days, e.g. '299').
# Usage: put the export XLSX paths + building->property map below; re-runnable
# (deletes property+as_of_date rows first; detail cascades on parent delete).
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$tmp = "$env:TEMP\load_ar"
New-Item -ItemType Directory -Force $tmp | Out-Null

# MRI building code -> property uuid
$PROPS = @{
  '0800' = 'd4f08824-2d88-472d-b7aa-a703310c2aaf'  # Magnolia Park
  '0840' = 'd5a4ed03-0b60-4168-9208-83822dd24884'  # Gateway Port Chester
  '0532' = '00000000-0000-0000-0000-000000000010'  # KM East (Midway)
  '0531' = '00000000-0000-0000-0000-000000000011'  # KM West (Midtown)
}
$FILES = Get-ChildItem "C:\Users\pskontos\Downloads\1577369586__*.XLSX" | Select-Object -ExpandProperty FullName

function NormName([string]$s) {
  $t = $s.ToLower() -replace '\(.*?\)', '' -replace '&', ' and '
  $t = $t.Normalize([Text.NormalizationForm]::FormD) -replace '\p{Mn}', ''
  return ($t -replace '[^a-z0-9]', '')
}
function SerialToDate($v) {
  if ($v -is [double]) { return (Get-Date '1899-12-30').AddDays([math]::Floor($v)).ToString('yyyy-MM-dd') }
  return $null
}
function D($v) { if ($v -is [double]) { [math]::Round($v, 2) } else { 0.0 } }

$maps = @{}
foreach ($propId in ($PROPS.Values | Select-Object -Unique)) {
  $trows = Invoke-RestMethod -Uri "$BASE/rest/v1/leases?select=id,tenant_id,tenants(name,trade_name)&property_id=eq.$propId" -Headers $H -UserAgent $UA -TimeoutSec 60
  $m = @()
  foreach ($r in $trows) {
    foreach ($n in @($r.tenants.name, $r.tenants.trade_name)) { if ($n) { $m += [pscustomobject]@{ norm = (NormName $n); lease_id = $r.id; tenant_id = $r.tenant_id } } }
  }
  $maps[$propId] = $m
}
function MatchTenant($map, [string]$name) {
  $n = NormName $name
  foreach ($x in $map) { if ($x.norm -eq $n) { return $x } }
  foreach ($x in $map) { if ($x.norm.Length -ge 4 -and $n.Length -ge 4 -and ($x.norm.Contains($n) -or $n.Contains($x.norm))) { return $x } }
  return $null
}

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false; $excel.DisplayAlerts = $false
$allRows = @()
try {
  foreach ($file in $FILES) {
    $wb = $excel.Workbooks.Open($file, 0, $true)
    $ws = $wb.Worksheets.Item(1)
    $ur = $ws.UsedRange; $vals = $ur.Value2
    # as-of date: 'Date:  7/3/2026' text in the header area
    $asOf = $null
    for ($r = 1; $r -le 6; $r++) { for ($c = 1; $c -le 6; $c++) {
      $v = $vals[$r, $c]
      if ($v -is [string] -and $v -match 'Date:\s+(\d{1,2}/\d{1,2}/\d{4})') { $asOf = ([datetime]$Matches[1]).ToString('yyyy-MM-dd') }
    } }
    if ($asOf -eq $null) { throw "no as-of date in $file" }

    $cur = $null; $bldg = $null; $rows = @(); $grand = $null
    for ($r = 7; $r -le $ur.Rows.Count; $r++) {
      $c1 = $vals[$r, 1]; $c3 = $vals[$r, 3]
      if ($c3 -is [string] -and ([string]$c3).Trim() -eq 'Grand Total:') { $grand = D $vals[$r, 5]; break }
      if ($c1 -is [string]) {
        $s1 = ([string]$c1).Trim()
        if ($s1 -match '^(\d{4})-(\S+)$') {
          # tenant block header
          $bldg = $Matches[1]
          $cur = [ordered]@{
            mri = $s1; name = ([string]$c3).Trim(); suite = $null; status = $null
            lpDate = $null; lpAmt = $null; cats = [ordered]@{}; lines = @()
          }
          # second row: suite/status/last payment
          $cur.suite = if ($vals[($r + 1), 5] -ne $null) { ([string]$vals[($r + 1), 5]).Trim() } else { $null }
          $cur.status = if ($vals[($r + 1), 6] -ne $null) { ([string]$vals[($r + 1), 6]).Trim() } else { $null }
          $cur.lpDate = SerialToDate $vals[($r + 1), 9]
          $lp = $vals[($r + 1), 10]
          $cur.lpAmt = if ($lp -is [double]) { [math]::Round($lp, 2) } else { $null }
          continue
        }
        if ($s1 -match 'Total:$' -and $cur -ne $null) {
          $rows += [pscustomobject]@{
            bldg = $bldg; mri = $cur.mri; name = $cur.name; suite = $cur.suite; status = $cur.status
            lpDate = $cur.lpDate; lpAmt = $cur.lpAmt; cats = $cur.cats; lines = $cur.lines
            total = D $vals[$r, 5]; cB = D $vals[$r, 6]; b30 = D $vals[$r, 7]; b60 = D $vals[$r, 8]; b90 = D $vals[$r, 9]; b120 = D $vals[$r, 10]
          }
          $cur = $null
          continue
        }
        # category subtotal inside a block: short uppercase code, no invoice date
        if ($cur -ne $null -and $s1 -match '^[A-Z0-9]{2,4}$' -and $vals[$r, 2] -eq $null) {
          $cur.cats[$s1] = @{ desc = $(if ($c3 -ne $null) { ([string]$c3).Trim() } else { '' }); total = (D $vals[$r, 5]) }
        }
      }
      # invoice detail line: c1 is a date serial, c2 the income category
      if ($cur -ne $null -and $c1 -is [double] -and $vals[$r, 2] -is [string]) {
        $bucketCols = @(@{ c = 6; k = 'current' }, @{ c = 7; k = 'b30' }, @{ c = 8; k = 'b60' }, @{ c = 9; k = 'b90' }, @{ c = 10; k = 'b120' })
        foreach ($bc in $bucketCols) {
          $v = D $vals[$r, $bc.c]
          if ($v -eq 0) { continue }
          $cur.lines += [pscustomobject]@{
            invoice_date = SerialToDate $c1
            category = ([string]$vals[$r, 2]).Trim()
            category_desc = $(if ($c3 -ne $null) { ([string]$c3).Trim() } else { '' })
            source = $(if ($vals[$r, 4] -ne $null) { ([string]$vals[$r, 4]).Trim() } else { $null })
            amount = $v
            bucket = $bc.k
          }
        }
      }
    }
    $sum = ($rows | Measure-Object -Property total -Sum).Sum
    Write-Output ("{0}: {1} tenants, as-of {2}, parsed total={3:n2} grand total={4:n2}" -f (Split-Path $file -Leaf), $rows.Count, $asOf, $sum, $grand)
    if ($grand -ne $null -and [math]::Abs($sum - $grand) -gt 0.05) { throw "parse mismatch vs grand total in $file" }
    $allRows += $rows | ForEach-Object { $_ | Add-Member -NotePropertyName asOf -NotePropertyValue $asOf -PassThru }
    $wb.Close($false)
  }
} finally { $excel.Quit(); [Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null }

# delete + insert per property/date
$combos = $allRows | ForEach-Object { "$($PROPS[$_.bldg])|$($_.asOf)" } | Select-Object -Unique
foreach ($combo in $combos) {
  $propId, $d = $combo -split '\|'
  $del = Invoke-WebRequest -Method Delete -Uri "$BASE/rest/v1/ar_aging?property_id=eq.$propId&as_of_date=eq.$d" -Headers $H -UserAgent $UA -UseBasicParsing -TimeoutSec 120
  Write-Output ("deleted old ({0} {1}): {2}" -f $propId.Substring($propId.Length - 4), $d, $del.StatusCode)
}

$ok = 0; $dok = 0; $dtotal = 0
foreach ($x in $allRows) {
  $propId = $PROPS[$x.bldg]
  if ($propId -eq $null) { Write-Output "WARN unknown building $($x.bldg) - skipped $($x.name)"; continue }
  $rowId = [guid]::NewGuid().ToString()
  $row = [ordered]@{
    id = $rowId
    property_id = $propId
    as_of_date = $x.asOf
    tenant_label = $x.name
    mri_lease_id = $x.mri
    suite = $x.suite
    occupant_status = $x.status
    total = $x.total
    bucket_current = $x.cB; bucket_30 = $x.b30; bucket_60 = $x.b60; bucket_90 = $x.b90; bucket_120 = $x.b120
    last_payment_date = $x.lpDate
    last_payment_amount = $x.lpAmt
    categories = $x.cats
  }
  $m = MatchTenant $maps[$propId] $x.name
  if ($m -ne $null) { $row.lease_id = $m.lease_id; $row.tenant_id = $m.tenant_id }
  $json = ConvertTo-Json $row -Depth 6 -Compress
  $f = "$tmp\row.json"
  [IO.File]::WriteAllText($f, $json, (New-Object Text.UTF8Encoding($false)))
  $resp = & curl.exe -s -o "$tmp\resp.json" -w '%{http_code}' -X POST "$BASE/rest/v1/ar_aging" `
    -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Prefer: return=representation" `
    --data-binary "@$f"
  if ($resp -ne '201') { Write-Output "FAIL ($resp) $($x.name): $(Get-Content "$tmp\resp.json" -Raw)"; continue }
  $ok++

  # invoice-level detail (bulk; identical keys on every object)
  $lines = @($x.lines)
  $dtotal += $lines.Count
  if ($lines.Count -gt 0) {
    $payload = @($lines | ForEach-Object { [ordered]@{
      ar_aging_id = $rowId
      invoice_date = $_.invoice_date
      category = $_.category
      category_desc = $_.category_desc
      source = $_.source
      amount = $_.amount
      bucket = $_.bucket
    } })
    $json = ConvertTo-Json -InputObject $payload -Depth 4 -Compress
    [IO.File]::WriteAllText($f, $json, (New-Object Text.UTF8Encoding($false)))
    $resp = & curl.exe -s -o "$tmp\resp.json" -w '%{http_code}' -X POST "$BASE/rest/v1/ar_aging_detail" `
      -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Prefer: return=representation" `
      --data-binary "@$f"
    if ($resp -eq '201') { $dok += $lines.Count } else { Write-Output "DETAIL FAIL ($resp) $($x.name): $(Get-Content "$tmp\resp.json" -Raw)" }
  }
}
Write-Output ("loaded {0}/{1} ar_aging rows + {2}/{3} detail lines" -f $ok, $allRows.Count, $dok, $dtotal)
