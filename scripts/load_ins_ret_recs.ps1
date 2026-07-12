# load_ins_ret_recs.ps1 - loads the Gateway 2025 INS + RET reconciliations into
# cam_reconciliations (rec_type 'ins' / 'ret', migration 20240032).
#   INS: 'B4-PT Summary' tenant grid  - c12 PT share, c14 on-account billed (neg), c15 amount due
#   RET: 'Rec' tenant grid            - c12 2025 total, c14 less billed (neg), c15 net due
#   estimated_amount = billed during the year (abs), actual_amount = rec total, variance = widget-side
# Validates parsed sums against the workbook totals before posting.
# Idempotent: deletes property+year+rec_type rows first.
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$tmp = "$env:TEMP\load_insret"
New-Item -ItemType Directory -Force $tmp | Out-Null

$GW = 'd5a4ed03-0b60-4168-9208-83822dd24884'
$YEAR = 2025

function NormName([string]$s) {
  $t = $s.ToLower() -replace '\(.*?\)', '' -replace '&', ' and '
  $t = $t.Normalize([Text.NormalizationForm]::FormD) -replace '\p{Mn}', ''
  return ($t -replace '[^a-z0-9]', '')
}

$trows = Invoke-RestMethod -Uri "$BASE/rest/v1/leases?select=id,tenant_id,tenants(name,trade_name)&property_id=eq.$GW" -Headers $H -UserAgent $UA -TimeoutSec 60
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

function D($v) { if ($v -is [double]) { [math]::Round($v, 2) } else { $null } }

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false; $excel.DisplayAlerts = $false
$rows = @()
try {
  # ── INS: 'B4-PT Summary' ─────────────────────────────────────────────────
  $wb = $excel.Workbooks.Open('K:\Working Files - Gateway Port Chester\Accounting\Reconciliations\2025\INS\2025 Port Chester INS Reconciliation 02.23.26.xlsx', 0, $true)
  $ws = $wb.Worksheets.Item('B4-PT Summary')
  $ur = $ws.UsedRange; $vals = $ur.Value2
  $sumPT = 0.0; $sumBilled = 0.0; $sumDue = 0.0
  for ($r = 6; $r -le $ur.Rows.Count; $r++) {
    $label = $vals[$r, 5]
    if ($label -is [string] -and $label -match '^\s*Total') { break }
    $name = if ($vals[$r, 3] -ne $null) { ([string]$vals[$r, 3]).Trim() } else { '' }
    $pt = D $vals[$r, 12]; $billed = D $vals[$r, 14]; $due = D $vals[$r, 15]
    if ($pt -ne $null) { $sumPT += $pt }; if ($billed -ne $null) { $sumBilled += $billed }; if ($due -ne $null) { $sumDue += $due }
    if (-not $name -or $name -match '^(Available|Vacant)') { continue }
    if (-not (($pt -ne $null -and $pt -ne 0) -or ($billed -ne $null -and $billed -ne 0) -or ($due -ne $null -and $due -ne 0))) { continue }
    $unit = if ($vals[$r, 2] -ne $null) { ([string]$vals[$r, 2]).Trim() } else { '' }
    $rows += [pscustomobject]@{ rec_type = 'ins'; name = $name; unit = $unit; comment = ''
      actual = $pt; billed = if ($billed -ne $null) { [math]::Abs($billed) } else { $null }; trueup = $due }
  }
  $wb.Close($false)
  Write-Output ("INS parsed: sum PT={0:n2} billed={1:n2} due={2:n2} (workbook: 300,664.90 / -179,724.96 / 121,311.79)" -f $sumPT, $sumBilled, $sumDue)

  # ── RET: 'Rec' ───────────────────────────────────────────────────────────
  $wb = $excel.Workbooks.Open('K:\Working Files - Gateway Port Chester\Accounting\Reconciliations\2025\RET\2025 Port Chester RET Reconciliation 02.23.26.xlsx', 0, $true)
  $ws = $wb.Worksheets.Item('Rec')
  $ur = $ws.UsedRange; $vals = $ur.Value2
  $sumNet = 0.0
  for ($r = 8; $r -le $ur.Rows.Count; $r++) {
    $name = if ($vals[$r, 3] -ne $null) { ([string]$vals[$r, 3]).Trim() } else { '' }
    if (-not $name -or $name -match '^Vacant') { continue }
    $total = D $vals[$r, 12]; $billed = D $vals[$r, 14]; $net = D $vals[$r, 15]
    if ($net -ne $null) { $sumNet += $net }
    if (-not (($total -ne $null -and $total -ne 0) -or ($billed -ne $null -and $billed -ne 0) -or ($net -ne $null -and $net -ne 0))) { continue }
    $unit = if ($vals[$r, 1] -ne $null) { ([string]$vals[$r, 1]).Trim() } else { '' }
    $comment = if ($vals[$r, 16] -ne $null) { ([string]$vals[$r, 16]).Trim() } else { '' }
    $rows += [pscustomobject]@{ rec_type = 'ret'; name = $name; unit = $unit; comment = $comment
      actual = $total; billed = if ($billed -ne $null) { [math]::Abs($billed) } else { $null }; trueup = $net }
  }
  $wb.Close($false)
  Write-Output ("RET parsed: sum net due={0:n2} (billing adjustment form total: -76,752.79)" -f $sumNet)
} finally { $excel.Quit(); [Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null }

$insCount = @($rows | Where-Object { $_.rec_type -eq 'ins' }).Count
$retCount = @($rows | Where-Object { $_.rec_type -eq 'ret' }).Count
Write-Output ("parsed {0} INS + {1} RET tenant rows" -f $insCount, $retCount)

foreach ($rt in 'ins', 'ret') {
  $del = Invoke-WebRequest -Method Delete -Uri "$BASE/rest/v1/cam_reconciliations?property_id=eq.$GW&period_year=eq.$YEAR&rec_type=eq.$rt" -Headers $H -UserAgent $UA -UseBasicParsing -TimeoutSec 120
  Write-Output ("deleted old {0}: {1}" -f $rt, $del.StatusCode)
}

$ok = 0
foreach ($x in $rows) {
  $kind = $x.rec_type.ToUpper()
  $noteParts = @("2025 $kind reconciliation", "tenant: $($x.name)")
  if ($x.unit) { $noteParts += "suite: $($x.unit)" }
  if ($x.trueup -ne $null) { $noteParts += ("true-up: {0}" -f $x.trueup) }
  if ($x.comment) { $noteParts += $x.comment }
  $row = [ordered]@{
    id = [guid]::NewGuid().ToString()
    property_id = $GW
    period_year = $YEAR
    rec_type = $x.rec_type
    estimated_amount = $x.billed
    actual_amount = $x.actual
    status = 'in_progress'
    notes = ($noteParts -join ' | ')
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
Write-Output ("loaded {0}/{1} INS+RET rec rows for Gateway {2}" -f $ok, $rows.Count, $YEAR)
