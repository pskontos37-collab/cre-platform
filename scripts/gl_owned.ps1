$ErrorActionPreference = "Stop"
$SP = "C:\Users\pskontos\AppData\Local\Temp\claude\C--Users-pskontos-Desktop-Software\c9d09617-ceab-4ad8-9e65-cb51a8403010\scratchpad"
$log = "$SP\gl_owned.log"
"start $(Get-Date -Format HH:mm:ss)" | Out-File $log
$cfg = @{}; foreach ($l in (Get-Content "C:\Users\pskontos\Desktop\Software\cre-platform\.env" | Where-Object { $_ -match "=" })) { $k,$v = $l -split '=',2; $cfg[$k.Trim()]=$v.Trim() }
$BASE=$cfg['VITE_SUPABASE_URL']; $KEY=$cfg['SUPABASE_SECRET_KEY']
$enc = New-Object System.Text.UTF8Encoding($false)
$TMP = "$SP\_gl_owned_post.json"

function Post($table,$rows,$prefer){
  for ($i=0;$i -lt $rows.Count;$i+=1000){
    $chunk=@($rows[$i..([Math]::Min($i+999,$rows.Count-1))])
    $json=$chunk|ConvertTo-Json -Depth 4; if($chunk.Count -eq 1){$json="[$json]"}
    [System.IO.File]::WriteAllText($TMP,$json,$enc)
    $resp = & curl.exe -s -X POST "$BASE/rest/v1/$table" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Prefer: $prefer" --data-binary "@$TMP"
    if ($resp -match '"code"' -and $resp -match '"message"') { throw "POST $($table) failed: $resp" }
  }
}
function Cell($v){ if($null -eq $v){return $null}; return ([string]$v).Trim() }
function DtSerial($v){ if($null -eq $v){return $null}; try{return ([datetime]::FromOADate([double]$v)).ToString('yyyy-MM-dd')}catch{return $null} }
function DNum($v){ if($null -eq $v){return $null}; try{return [decimal]$v}catch{return $null} }

$acctRe=[regex]'^\s*\d{4}-?\d{2}\s*$'   # matches 1001-00 AND 100600
$entRe =[regex]'^\s*\d{4}\s*$'          # entity = 4 digits (0800/0840)

$files=@(
 @{ path="C:\Users\pskontos\Downloads\1569102229__363fa810de3a498e9b3844016259745b_1.XLSX"; pid='d4f08824-2d88-472d-b7aa-a703310c2aaf'; label='Magnolia Park (0800)' },
 @{ path="C:\Users\pskontos\Downloads\1569102229__7c08e8eaf56c461d8bf5c1f96d9d3889_1.XLSX"; pid='d5a4ed03-0b60-4168-9208-83822dd24884'; label='Gateway Port Chester (0840)' }
)
$xl=New-Object -ComObject Excel.Application; $xl.Visible=$false; $xl.DisplayAlerts=$false
try {
 foreach($f in $files){
  $wb=$xl.Workbooks.Open($f.path,$false,$true); $ws=$wb.Sheets.Item(1); $data=$ws.UsedRange.Value2
  $n=$data.GetLength(0); $nc=$data.GetLength(1)
  "$(Get-Date -Format HH:mm:ss) $($f.label): sheet rows=$n" | Out-File $log -Append
  $curAcct=$null; $curName=$null; $rows=@(); $tx=0
  for($r=1;$r -le $n;$r++){
    $a=Cell $data[$r,1]; if([string]::IsNullOrWhiteSpace($a)){continue}
    if($acctRe.IsMatch($a)){ $curAcct=$a; $curName=if($nc -ge 4){Cell $data[$r,4]}else{$null}; continue }
    if(-not $entRe.IsMatch($a)){ continue }
    $desc=if($nc -ge 10){Cell $data[$r,10]}else{$null}
    $debit=if($nc -ge 11){DNum $data[$r,11]}else{$null}
    $credit=if($nc -ge 12){DNum $data[$r,12]}else{$null}
    $bal=if($nc -ge 13){DNum $data[$r,13]}else{$null}
    $isBF=($desc -match 'Balance Forward'); if(-not $isBF){$tx++}
    $per=if($nc -ge 2){Cell $data[$r,2]}else{$null}; $py=$null;$pm=$null
    if($per -and $per -match '^(\d{1,2})/(\d{2})$'){ $pm=[int]$matches[1]; $py=2000+[int]$matches[2] }
    $rows+=@{ property_id=$f.pid; entity_code=$a; account_code=$curAcct; account_name=$curName;
      period=$per; period_year=$py; period_month=$pm;
      entry_date=if($nc -ge 4){DtSerial $data[$r,4]}else{$null};
      source_code=if($nc -ge 5){Cell $data[$r,5]}else{$null}; reference=if($nc -ge 6){Cell $data[$r,6]}else{$null};
      site_id=if($nc -ge 7){Cell $data[$r,7]}else{$null}; job_code=if($nc -ge 8){Cell $data[$r,8]}else{$null};
      dept=if($nc -ge 9){Cell $data[$r,9]}else{$null}; description=$desc;
      debit=if($null -eq $debit){0}else{$debit}; credit=if($null -eq $credit){0}else{$credit}; balance=$bal; is_balance_forward=$isBF }
  }
  $wb.Close($false)
  "$(Get-Date -Format HH:mm:ss) $($f.label): parsed tx=$tx total=$($rows.Count); deleting+inserting" | Out-File $log -Append
  & curl.exe -s -X DELETE "$BASE/rest/v1/gl_entries?property_id=eq.$($f.pid)" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" | Out-Null
  Post 'gl_entries' $rows 'return=minimal'
  "$(Get-Date -Format HH:mm:ss) $($f.label): DONE inserted $($rows.Count)" | Out-File $log -Append
 }
} finally { $xl.Quit(); [System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl)|Out-Null }
"done $(Get-Date -Format HH:mm:ss)" | Out-File $log -Append