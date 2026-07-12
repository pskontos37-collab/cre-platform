$ErrorActionPreference = "Stop"
$cfg = @{}; foreach ($l in (Get-Content "C:\Users\pskontos\Desktop\Software\cre-platform\.env" | Where-Object { $_ -match "=" })) { $k,$v = $l -split '=',2; $cfg[$k.Trim()]=$v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$enc = New-Object System.Text.UTF8Encoding($false)
$TMP = "C:\Users\pskontos\AppData\Local\Temp\claude\C--Users-pskontos-Desktop-Software\c9d09617-ceab-4ad8-9e65-cb51a8403010\scratchpad\_gl_post.json"

function Post($table, $rows, $prefer) {
  if ($rows.Count -eq 0) { return }
  for ($i=0; $i -lt $rows.Count; $i += 1000) {
    $chunk = @($rows[$i..([Math]::Min($i+999,$rows.Count-1))])
    $json = $chunk | ConvertTo-Json -Depth 4
    if ($chunk.Count -eq 1) { $json = "[$json]" }
    [System.IO.File]::WriteAllText($TMP, $json, $enc)
    $resp = & curl.exe -s -X POST "$BASE/rest/v1/$table" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Prefer: $prefer" --data-binary "@$TMP"
    if ($resp -match '"message"\s*:' -and $resp -match '"code"') { throw "POST $table failed: $resp" }
  }
}

$PROP = @{ '0532' = '00000000-0000-0000-0000-000000000010'; '0531' = '00000000-0000-0000-0000-000000000011' }
$files = @(
  @{ path = "C:\Users\pskontos\Downloads\KM East GL.XLSX"; entity = '0532' },
  @{ path = "C:\Users\pskontos\Downloads\KM West GL.XLSX"; entity = '0531' }
)
$acctRe = [regex]'^\s*\d{4}-\d{2}\s*$'
$entRe  = [regex]'^\s*\d{3,5}\s*$'

function Cell($v) { if ($null -eq $v) { return $null }; return ([string]$v).Trim() }
function DtSerial($v) { if ($null -eq $v) { return $null }; try { return ([datetime]::FromOADate([double]$v)).ToString('yyyy-MM-dd') } catch { return $null } }
function DNum($v) { if ($null -eq $v) { return $null }; try { return [decimal]$v } catch { return $null } }

$xl = New-Object -ComObject Excel.Application; $xl.Visible=$false; $xl.DisplayAlerts=$false
try {
  foreach ($f in $files) {
    $wb = $xl.Workbooks.Open($f.path, $false, $true)
    $ws = $wb.Sheets.Item(1)
    $data = $ws.UsedRange.Value2
    $nrows = $data.GetLength(0); $ncols = $data.GetLength(1)
    Write-Output ("$($f.entity): sheet rows=$nrows cols=$ncols")

    $curAcct = $null; $curName = $null
    $glRows = @(); $tx = 0; $bf = 0
    for ($r=1; $r -le $nrows; $r++) {
      $a = Cell $data[$r,1]
      if ([string]::IsNullOrWhiteSpace($a)) { continue }
      if ($acctRe.IsMatch($a)) {
        $curAcct = $a
        $curName = if ($ncols -ge 4) { Cell $data[$r,4] } else { $null }
        continue
      }
      if (-not $entRe.IsMatch($a)) { continue }    # skip totals / labels
      # transaction or balance-forward row for an entity
      $desc = if ($ncols -ge 10) { Cell $data[$r,10] } else { $null }
      $debit  = if ($ncols -ge 11) { DNum $data[$r,11] } else { $null }
      $credit = if ($ncols -ge 12) { DNum $data[$r,12] } else { $null }
      $bal    = if ($ncols -ge 13) { DNum $data[$r,13] } else { $null }
      $isBF = ($desc -match 'Balance Forward')
      if ($isBF) { $bf++ } else { $tx++ }
      $per = if ($ncols -ge 2) { Cell $data[$r,2] } else { $null }
      $py = $null; $pm = $null
      if ($per -and $per -match '^(\d{1,2})/(\d{2})$') { $pm=[int]$matches[1]; $py=2000+[int]$matches[2] }
      $entity = $a.PadLeft(4,'0')
      $propId = $PROP[$entity]; if (-not $propId) { $propId = $PROP[$f.entity] }
      $glRows += @{
        property_id = $propId
        entity_code = $entity
        account_code = $curAcct
        account_name = $curName
        period = $per
        period_year = $py
        period_month = $pm
        entry_date = if ($ncols -ge 4) { DtSerial $data[$r,4] } else { $null }
        source_code = if ($ncols -ge 5) { Cell $data[$r,5] } else { $null }
        reference = if ($ncols -ge 6) { Cell $data[$r,6] } else { $null }
        site_id = if ($ncols -ge 7) { Cell $data[$r,7] } else { $null }
        job_code = if ($ncols -ge 8) { Cell $data[$r,8] } else { $null }
        dept = if ($ncols -ge 9) { Cell $data[$r,9] } else { $null }
        description = $desc
        debit = if ($null -eq $debit) { 0 } else { $debit }
        credit = if ($null -eq $credit) { 0 } else { $credit }
        balance = $bal
        is_balance_forward = $isBF
      }
    }
    $wb.Close($false)
    Write-Output ("  parsed transactions=$tx balance_forward=$bf total_rows=$($glRows.Count)")
    # idempotent: clear this property's GL then insert
    & curl.exe -s -X DELETE "$BASE/rest/v1/gl_entries?property_id=eq.$($PROP[$f.entity])" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" | Out-Null
    Post 'gl_entries' $glRows 'return=minimal'
    Write-Output ("  inserted $($glRows.Count) gl_entries for $($f.entity)")
  }
} finally {
  $xl.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl) | Out-Null
}
Write-Output "DONE gl"