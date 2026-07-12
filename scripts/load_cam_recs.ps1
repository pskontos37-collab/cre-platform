# load_cam_recs.ps1 - loads the Gateway 2025 CAM reconciliation (tenant true-up
# grid on the 'CAM Rec' sheet) into cam_reconciliations.
#   estimated_amount = what was billed during the year (Less Billed, sign-flipped)
#   actual_amount    = the rec's computed 2025 total
#   status           = in_progress (workbook is "VP Comments" review draft)
# Idempotent: deletes property+year rows first.
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$tmp = "$env:TEMP\load_cam"
New-Item -ItemType Directory -Force $tmp | Out-Null

$GW = 'd5a4ed03-0b60-4168-9208-83822dd24884'
$YEAR = 2025
$PATH = 'K:\Working Files - Gateway Port Chester\Accounting\Reconciliations\2025\CAM\2025 Port Chester CAM Reconciliation 02.23.26 VP Comments.xlsb'

function NormName([string]$s) {
  $t = $s.ToLower() -replace '\(.*?\)', '' -replace '&', ' and '
  $t = $t.Normalize([Text.NormalizationForm]::FormD) -replace '\p{Mn}', ''
  return ($t -replace '[^a-z0-9]', '')
}

# tenants for matching (nullable on the table; best effort)
$trows = Invoke-RestMethod -Uri "$BASE/rest/v1/leases?select=id,tenant_id,tenants(name,trade_name)&property_id=eq.$GW" -Headers $H -UserAgent $UA -TimeoutSec 60
$map = @()
foreach ($r in $trows) {
  foreach ($n in @($r.tenants.name, $r.tenants.trade_name)) { if ($n) { $map += [pscustomobject]@{ norm = (NormName $n); lease_id = $r.id; tenant_id = $r.tenant_id } } }
}

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false; $excel.DisplayAlerts = $false
$rows = @()
try {
  $wb = $excel.Workbooks.Open($PATH, 0, $true)
  $ws = $wb.Worksheets.Item('CAM Rec')
  $ur = $ws.UsedRange; $vals = $ur.Value2
  for ($r = 8; $r -le $ur.Rows.Count; $r++) {
    $occ = $vals[$r, 5]; $dba = $vals[$r, 6]; $suite = $vals[$r, 4]
    $total = $vals[$r, 18]; $billed = $vals[$r, 19]; $rec = $vals[$r, 20]
    $name = if ($occ -ne $null) { ([string]$occ).Trim() } else { '' }
    if (-not $name -or $name -eq 'VACANT') { continue }
    if (-not ($total -is [double])) { continue }
    $billedAmt = if ($billed -is [double]) { [math]::Round([math]::Abs($billed), 2) } else { $null }
    $trueUp = if ($rec -is [double]) { [math]::Round($rec, 2) } else { $null }
    $m = $null
    $n = NormName $name
    foreach ($x in $map) { if ($x.norm -eq $n) { $m = $x; break } }
    if ($m -eq $null) { foreach ($x in $map) { if ($x.norm.Length -ge 4 -and $n.Length -ge 4 -and ($x.norm.Contains($n) -or $n.Contains($x.norm))) { $m = $x; break } } }
    $noteParts = @("2025 CAM reconciliation (VP review draft)", "tenant: $name")
    if ($dba) { $noteParts += "dba: $(([string]$dba).Trim())" }
    if ($suite) { $noteParts += "suite: $suite" }
    if ($trueUp -ne $null) { $noteParts += ("true-up: {0}" -f $trueUp) }
    $row = [ordered]@{
      id = [guid]::NewGuid().ToString()
      property_id = $GW
      period_year = $YEAR
      estimated_amount = $billedAmt
      actual_amount = [math]::Round($total, 2)
      status = 'in_progress'
      notes = ($noteParts -join ' | ')
    }
    if ($m -ne $null) { $row.lease_id = $m.lease_id; $row.tenant_id = $m.tenant_id }
    $rows += $row
  }
  $wb.Close($false)
} finally { $excel.Quit(); [Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null }

Write-Output ("parsed {0} tenant rec rows" -f $rows.Count)
$del = Invoke-WebRequest -Method Delete -Uri "$BASE/rest/v1/cam_reconciliations?property_id=eq.$GW&period_year=eq.$YEAR" -Headers $H -UserAgent $UA -UseBasicParsing -TimeoutSec 120
Write-Output ("deleted old: {0}" -f $del.StatusCode)

# one-object posts (rows have non-identical keys when tenant match is missing)
$ok = 0
foreach ($row in $rows) {
  $json = ConvertTo-Json $row -Depth 4 -Compress
  $f = "$tmp\row.json"
  [IO.File]::WriteAllText($f, $json, (New-Object Text.UTF8Encoding($false)))
  $resp = & curl.exe -s -o "$tmp\resp.json" -w '%{http_code}' -X POST "$BASE/rest/v1/cam_reconciliations" `
    -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Prefer: return=representation" `
    --data-binary "@$f"
  if ($resp -eq '201') { $ok++ } else { Write-Output "FAIL ($resp): $(Get-Content "$tmp\resp.json" -Raw)" }
}
Write-Output ("loaded {0}/{1} CAM rec rows for Gateway {2}" -f $ok, $rows.Count, $YEAR)
