# load_cam_recs_mag.ps1 - loads the Magnolia Park 2025 combined reconciliation
# ('2025 Magnolia Park CAM Rec_V3.xlsx', sheet 'B5- PT Summary' = Year 2025 actuals)
# into cam_reconciliations, split into rec_type cam / ret / ins per tenant.
#   actual_amount    = tenant share (CAM incl. OTHERS; TAX -> ret; INS -> ins)
#   estimated_amount = amount previously billed (deposits, sign-flipped)
#   true-up          = tenant amount due (refund) - carried in notes
# Sheet layout: c2 unit, c4 tenant, c5 MRI lease id, c11/13/15/17 shares
# (CAM/TAX/INS/OTHERS), c22-26 billed (neg), c28-32 due. Grand total row
# validates the parse. A-series tabs are the prior (2024) rec - not loaded.
# Idempotent: deletes property+year rows for the three types first.
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$tmp = "$env:TEMP\load_cam_mag"
New-Item -ItemType Directory -Force $tmp | Out-Null

$MAG = 'd4f08824-2d88-472d-b7aa-a703310c2aaf'
$YEAR = 2025
$PATH = 'K:\Working Files - Magnolia\Reconciliations\2025\2025 Magnolia Park CAM Rec_V3.xlsx'

function NormName([string]$s) {
  $t = $s.ToLower() -replace '\(.*?\)', '' -replace '&', ' and '
  $t = $t.Normalize([Text.NormalizationForm]::FormD) -replace '\p{Mn}', ''
  return ($t -replace '[^a-z0-9]', '')
}

$trows = Invoke-RestMethod -Uri "$BASE/rest/v1/leases?select=id,tenant_id,tenants(name,trade_name)&property_id=eq.$MAG" -Headers $H -UserAgent $UA -TimeoutSec 60
$map = @()
foreach ($r in $trows) {
  foreach ($n in @($r.tenants.name, $r.tenants.trade_name)) { if ($n) { $map += [pscustomobject]@{ norm = (NormName $n); lease_id = $r.id; tenant_id = $r.tenant_id } } }
}
function MatchTenant([string]$name) {
  $n = NormName $name
  foreach ($x in $map) { if ($x.norm -eq $n) { return $x } }
  foreach ($x in $map) { if ($x.norm.Length -ge 4 -and $n.Length -ge 4 -and ($x.norm.Contains($n) -or $n.Contains($x.norm))) { return $x } }
  return $null
}
function D($v) { if ($v -is [double]) { [math]::Round($v, 2) } else { 0.0 } }

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false; $excel.DisplayAlerts = $false
$tenants = @()
$anchor = $null
try {
  $wb = $excel.Workbooks.Open($PATH, 0, $true)
  $ws = $wb.Worksheets.Item('B5- PT Summary')
  $ur = $ws.UsedRange; $vals = $ur.Value2
  for ($r = 8; $r -le $ur.Rows.Count; $r++) {
    $name = if ($vals[$r, 4] -ne $null) { ([string]$vals[$r, 4]).Trim() } else { '' }
    $billedTotal = D $vals[$r, 26]
    if (-not $name -or $name -match 'TOTAL') {
      # grand total row ('NET TOTAL:')
      if ($anchor -eq $null -and [math]::Abs($billedTotal) -gt 100000) {
        $anchor = [pscustomobject]@{
          camB = [math]::Abs((D $vals[$r, 22])) + [math]::Abs((D $vals[$r, 25]))
          retB = [math]::Abs((D $vals[$r, 23])); insB = [math]::Abs((D $vals[$r, 24]))
          camD = (D $vals[$r, 28]) + (D $vals[$r, 31]); retD = D $vals[$r, 29]; insD = D $vals[$r, 30]
        }
      }
      continue
    }
    if ($name -match '^(Available|Vacant)') { continue }
    $tenants += [pscustomobject]@{
      unit = $(if ($vals[$r, 2] -ne $null) { ([string]$vals[$r, 2]).Trim() } else { '' })
      name = $name
      mri  = $(if ($vals[$r, 5] -ne $null) { ([string]$vals[$r, 5]).Trim() } else { '' })
      camS = (D $vals[$r, 11]) + (D $vals[$r, 17]); camB = [math]::Abs((D $vals[$r, 22])) + [math]::Abs((D $vals[$r, 25])); camD = (D $vals[$r, 28]) + (D $vals[$r, 31])
      retS = D $vals[$r, 13]; retB = [math]::Abs((D $vals[$r, 23])); retD = D $vals[$r, 29]
      insS = D $vals[$r, 15]; insB = [math]::Abs((D $vals[$r, 24])); insD = D $vals[$r, 30]
    }
  }
  $wb.Close($false)
} finally { $excel.Quit(); [Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null }

Write-Output ("parsed {0} tenant rows: {1}" -f $tenants.Count, (($tenants | ForEach-Object { $_.name }) -join '; '))
foreach ($t in 'camB', 'retB', 'insB', 'camD', 'retD', 'insD') {
  $sum = ($tenants | Measure-Object -Property $t -Sum).Sum
  $a = if ($anchor -ne $null) { $anchor.$t } else { 'n/a' }
  Write-Output ("  {0}: parsed={1:n2} workbook-total={2:n2}" -f $t, $sum, $a)
}

$rows = @()
foreach ($t in $tenants) {
  foreach ($kind in @(
      @{ rt = 'cam'; s = $t.camS; b = $t.camB; d = $t.camD },
      @{ rt = 'ret'; s = $t.retS; b = $t.retB; d = $t.retD },
      @{ rt = 'ins'; s = $t.insS; b = $t.insB; d = $t.insD })) {
    if ($kind.s -eq 0 -and $kind.b -eq 0 -and $kind.d -eq 0) { continue }
    $noteParts = @(("2025 {0} reconciliation (Magnolia CAM Rec V3)" -f $kind.rt.ToUpper()), "tenant: $($t.name)")
    if ($t.unit) { $noteParts += "suite: $($t.unit)" }
    if ($t.mri) { $noteParts += "mri-lease: $($t.mri)" }
    $noteParts += ("true-up: {0}" -f $kind.d)
    $rows += [pscustomobject]@{ name = $t.name; rec_type = $kind.rt
      estimated = $(if ($kind.b -ne 0) { $kind.b } else { $null }); actual = $kind.s; notes = ($noteParts -join ' | ') }
  }
}
Write-Output ("{0} rec rows to load" -f $rows.Count)

foreach ($rt in 'cam', 'ins', 'ret') {
  $del = Invoke-WebRequest -Method Delete -Uri "$BASE/rest/v1/cam_reconciliations?property_id=eq.$MAG&period_year=eq.$YEAR&rec_type=eq.$rt" -Headers $H -UserAgent $UA -UseBasicParsing -TimeoutSec 120
  Write-Output ("deleted old {0}: {1}" -f $rt, $del.StatusCode)
}

$ok = 0
foreach ($x in $rows) {
  $row = [ordered]@{
    id = [guid]::NewGuid().ToString()
    property_id = $MAG
    period_year = $YEAR
    rec_type = $x.rec_type
    estimated_amount = $x.estimated
    actual_amount = $x.actual
    status = 'in_progress'
    notes = $x.notes
  }
  $m = MatchTenant $x.name
  if ($m -ne $null) { $row.lease_id = $m.lease_id; $row.tenant_id = $m.tenant_id }
  $json = ConvertTo-Json $row -Depth 4 -Compress
  $f = "$tmp\row.json"
  [IO.File]::WriteAllText($f, $json, (New-Object Text.UTF8Encoding($false)))
  $resp = & curl.exe -s -o "$tmp\resp.json" -w '%{http_code}' -X POST "$BASE/rest/v1/cam_reconciliations" `
    -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Prefer: return=representation" `
    --data-binary "@$f"
  if ($resp -eq '201') { $ok++ } else { Write-Output "FAIL ($resp) $($x.rec_type) $($x.name): $(Get-Content "$tmp\resp.json" -Raw)" }
}
Write-Output ("loaded {0}/{1} rec rows for Magnolia {2}" -f $ok, $rows.Count, $YEAR)
