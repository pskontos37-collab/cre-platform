# load_budget.ps1 - loads the 2026 approved operating budgets into budget_lines.
# Sources (account x month grids):
#   Gateway + Magnolia: MRI BF_PROFORMD proforma (rows "NNNNNN  Account Name",
#     months in cols 2-13; "- tenant (RBO) ..." detail rows are skipped).
#   Knightdale: 'Summary- KM East' / 'Summary- KM West' tabs (name col 1,
#     code col 2 as NNNN-NN, months cols 4-15). #N/A errors arrive as big
#     negative ints from Value2 - only clean doubles are loaded.
# Idempotent: deletes property+year rows, bulk-inserts via curl.
param([int]$Year = 2026)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$tmp = "$env:TEMP\load_budget"
New-Item -ItemType Directory -Force $tmp | Out-Null

$GW  = 'd5a4ed03-0b60-4168-9208-83822dd24884'
$MAG = 'd4f08824-2d88-472d-b7aa-a703310c2aaf'
$KME = '00000000-0000-0000-0000-000000000010'
$KMW = '00000000-0000-0000-0000-000000000011'

$books = @(
  @{ prop = $GW;  fmt = 'proformd'; sheet = 'BF_PROFORMD';      path = 'K:\Working Files - Gateway Port Chester\BUDGET\2026 Budget\2026 Business Plan\FINAL BP from Don 11.7.25\01.08.2025 2026 Monthly Proforma.xlsx' },
  @{ prop = $MAG; fmt = 'proformd'; sheet = 'BF_PROFORMD';      path = 'K:\Working Files - Magnolia\BUDGET\2026 Budget- Magnolia Park\2026 Budget- Magnolia FINAL 1.30.26.XLSX' },
  @{ prop = $KME; fmt = 'summary';  sheet = 'Summary- KM East'; path = 'K:\Working Files - Knightdale Marketplace\Budget\2026\2026 Knightdale Marketplace_Budget_FINAL.xlsx' },
  @{ prop = $KMW; fmt = 'summary';  sheet = 'Summary- KM West'; path = 'K:\Working Files - Knightdale Marketplace\Budget\2026\2026 Knightdale Marketplace_Budget_FINAL.xlsx' }
)

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false; $excel.DisplayAlerts = $false
$byProp = @{}
try {
  foreach ($b in $books) {
    $wb = $excel.Workbooks.Open($b.path, 0, $true)
    $ws = $wb.Worksheets.Item($b.sheet)
    $ur = $ws.UsedRange; $vals = $ur.Value2
    $rows = New-Object System.Collections.Generic.List[object]
    for ($r = 1; $r -le $ur.Rows.Count; $r++) {
      $code = $null; $name = $null; $mcol0 = 0
      if ($b.fmt -eq 'proformd') {
        $c1 = $vals[$r, 1]
        if ($c1 -eq $null) { continue }
        $s = ([string]$c1).Trim()
        if ($s -notmatch '^(\d{6})\s+(.+)$') { continue }
        $code = $Matches[1]; $name = $Matches[2].Trim(); $mcol0 = 1   # months at cols 2..13
      } else {
        $c2 = $vals[$r, 2]
        if ($c2 -eq $null) { continue }
        $s = ([string]$c2).Trim()
        if ($s -notmatch '^(\d{4}-\d{2})\.?$') { continue }
        $code = $Matches[1]
        $n1 = $vals[$r, 1]
        $name = if ($n1 -ne $null) { ([string]$n1).Trim() } else { '' }
        if (-not $name) { continue }
        $mcol0 = 3   # months at cols 4..15
      }
      for ($m = 1; $m -le 12; $m++) {
        $v = $vals[$r, ($mcol0 + $m)]
        if ($v -is [double] -and [math]::Abs($v) -gt 0.005 -and [math]::Abs($v) -lt 1e9) {
          $rows.Add([pscustomobject]@{ code = $code; name = $name; month = $m; amount = [math]::Round($v, 2) })
        }
      }
    }
    $wb.Close($false)
    if (-not $byProp.ContainsKey($b.prop)) { $byProp[$b.prop] = New-Object System.Collections.Generic.List[object] }
    foreach ($x in $rows) { $byProp[$b.prop].Add([pscustomobject]@{ x = $x; src = (Split-Path $b.path -Leaf) }) }
    Write-Output ("parsed {0} [{1}]: {2} cells" -f (Split-Path $b.path -Leaf), $b.sheet, $rows.Count)
  }
} finally { $excel.Quit(); [Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null }

foreach ($prop in $byProp.Keys) {
  $payload = @()
  foreach ($e in $byProp[$prop]) {
    $payload += [ordered]@{
      id = [guid]::NewGuid().ToString()
      property_id = $prop; budget_year = $Year; period_month = $e.x.month
      account_code = $e.x.code; account_name = $e.x.name
      amount = $e.x.amount; source = $e.src
    }
  }
  $del = Invoke-WebRequest -Method Delete -Uri "$BASE/rest/v1/budget_lines?property_id=eq.$prop&budget_year=eq.$Year" -Headers $H -UserAgent $UA -UseBasicParsing -TimeoutSec 120
  Write-Output ("deleted old for {0}: {1}" -f $prop, $del.StatusCode)
  for ($i = 0; $i -lt $payload.Count; $i += 500) {
    $batch = $payload[$i..([math]::Min($i + 499, $payload.Count - 1))]
    $json = ConvertTo-Json @($batch) -Depth 4 -Compress
    $f = "$tmp\batch.json"
    [IO.File]::WriteAllText($f, $json, (New-Object Text.UTF8Encoding($false)))
    $resp = & curl.exe -s -o "$tmp\resp.json" -w '%{http_code}' -X POST "$BASE/rest/v1/budget_lines" `
      -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Prefer: return=representation" `
      --data-binary "@$f"
    if ($resp -ne '201') { throw "insert failed ($resp): $(Get-Content "$tmp\resp.json" -Raw)" }
  }
  Write-Output ("loaded {0} budget cells for {1}" -f $payload.Count, $prop)
}
Write-Output 'done'
