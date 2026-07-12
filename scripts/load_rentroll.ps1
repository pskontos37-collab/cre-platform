$ErrorActionPreference = "Stop"
# Loads MRI_CMROLL rent-roll Excel exports into rent_roll_snapshots + rent_roll_rows.
# One clean MRI_CMROLL export per owned building. Self-validates occupied totals vs the
# file's own "Totals:" row. Idempotent: deletes the snapshot for that property+period first.
$SP = "C:\Users\pskontos\AppData\Local\Temp\claude\C--Users-pskontos-Desktop-Software\4813eb50-3027-4b15-81ea-2a63a5f0357b\scratchpad"
$cfg = @{}; foreach ($l in (Get-Content "C:\Users\pskontos\Desktop\Software\cre-platform\.env" | Where-Object { $_ -match "=" })) { $k,$v = $l -split '=',2; $cfg[$k.Trim()]=$v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$enc = New-Object System.Text.UTF8Encoding($false)
$TMP = "$SP\_rr_post.json"

function Cell($v){ if($null -eq $v){return $null}; $s=([string]$v).Trim(); if($s -eq ''){return $null}; return $s }
function DNum($v){ if($null -eq $v){return $null}; try{return [decimal]$v}catch{return $null} }
function DtSerial($v){ if($null -eq $v){return $null}; try{return ([datetime]::FromOADate([double]$v)).ToString('yyyy-MM-dd')}catch{return $null} }
function Post($table,$rows,$prefer){
  $out=@()
  for ($i=0;$i -lt $rows.Count;$i+=500){
    $chunk=@($rows[$i..([Math]::Min($i+499,$rows.Count-1))])
    $json=$chunk|ConvertTo-Json -Depth 5; if($chunk.Count -eq 1){$json="[$json]"}
    [System.IO.File]::WriteAllText($TMP,$json,$enc)
    $resp = & curl.exe -s -X POST "$BASE/rest/v1/$table" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Prefer: $prefer" --data-binary "@$TMP"
    if ($resp -match '"code"' -and $resp -match '"message"') { throw "POST $table failed: $resp" }
    if ($prefer -match 'representation' -and $resp){ $p=$resp|ConvertFrom-Json; if($p){$out+=$p} }
  }
  return $out
}

$bldRe=[regex]'^\d{4}$'
$files=@(
 @{ path="C:\Users\pskontos\Downloads\1569102229__df9c3b1a844044828e9579b95c06f605_1.XLSX"; pid='d5a4ed03-0b60-4168-9208-83822dd24884'; label='Gateway Port Chester (0840)';
    expMonthly=935054.70; expUnits=25; expOccSf=409574 },   # validation targets (occSf overwritten below per file)
 @{ path="C:\Users\pskontos\Downloads\Magnolia RR2.XLSX";   pid='d4f08824-2d88-472d-b7aa-a703310c2aaf'; label='Magnolia Park (0800)';
    expMonthly=710264.07; expUnits=32; expOccSf=409574 }
)
# correct Gateway occupied SF target
$files[0].expOccSf=428882

$YEAR=2026; $MONTH=6

$xl=New-Object -ComObject Excel.Application; $xl.Visible=$false; $xl.DisplayAlerts=$false
try{
 foreach($f in $files){
  $wb=$xl.Workbooks.Open($f.path,$false,$true); $ws=$wb.Sheets.Item(1); $d=$ws.UsedRange.Value2
  $n=$d.GetLength(0); $nc=$d.GetLength(1)
  # locate header row (Bldg Id / Suit Id)
  $hdr=0; for($r=1;$r -le [Math]::Min(15,$n);$r++){ if((Cell $d[$r,1]) -eq 'Bldg Id' -and (Cell $d[$r,2]) -eq 'Suit Id'){$hdr=$r;break} }
  if($hdr -eq 0){ throw "$($f.label): header row not found" }

  $section=$null; $rows=@()
  for($r=$hdr+1;$r -le $n;$r++){
    $c1=Cell $d[$r,1]
    if($null -eq $c1){
      # continuation row: include "Additional Space" (a no-rent SF-only suite the file counts
      # as its own occupied unit); skip future-rent-increase + Total subrows.
      $c3a=Cell $d[$r,3]
      if($section -eq 'occupied' -and $c3a -and $c3a -match 'Additional Space'){
        $rows += @{
          property_id=$f.pid; suite=(Cell $d[$r,2]); tenant_name=$c3a; sqft=(DNum $d[$r,6]);
          lease_start=(DtSerial $d[$r,4]); lease_end=(DtSerial $d[$r,5]);
          monthly_base_rent=$null; annual_base_rent=$null; base_rent_psf=$null; is_occupied=$true;
          raw_data=@{ section='occupied'; additional_space=$true }
        }
      }
      continue
    }
    if(-not $bldRe.IsMatch($c1)){                       # a label row -> set section
      if($c1 -match 'New Leases'){ $section='new' }
      elseif($c1 -match 'Vacant'){ $section='vacant' }
      elseif($c1 -match 'Occupied'){ $section='occupied' }
      elseif($c1 -match 'Total'){ break }               # Totals:/Grand Total: -> done
      continue
    }
    $suite=Cell $d[$r,2]; if($null -eq $suite){ continue }
    $tenant=Cell $d[$r,3]
    $sqft=DNum $d[$r,6]
    $occ = ($section -eq 'occupied')
    $monthly = if($occ){ DNum $d[$r,7] } else { $null }
    $psf = if($occ){ DNum $d[$r,8] } else { $null }
    $annual = if($null -ne $monthly){ [Math]::Round($monthly*12,2) } else { $null }
    $rows += @{
      property_id=$f.pid; suite=$suite; tenant_name=$tenant; sqft=$sqft;
      lease_start=(DtSerial $d[$r,4]); lease_end=(DtSerial $d[$r,5]);
      monthly_base_rent=$monthly; annual_base_rent=$annual; base_rent_psf=$psf;
      is_occupied=$occ;
      raw_data=@{ section=$section; entity=$c1; cost_recovery=(DNum $d[$r,9]); other_income=(DNum $d[$r,11]) }
    }
  }
  $wb.Close($false)

  $occRows=@($rows | Where-Object { $_.is_occupied })
  $vacRows=@($rows | Where-Object { -not $_.is_occupied -and $_.raw_data.section -eq 'vacant' })
  $leasedSf=($occRows | ForEach-Object { [decimal]($_.sqft) } | Measure-Object -Sum).Sum
  $vacantSf=($vacRows | ForEach-Object { [decimal]($_.sqft) } | Measure-Object -Sum).Sum
  $monthlySum=($occRows | Where-Object { $null -ne $_.monthly_base_rent } | ForEach-Object { $_.monthly_base_rent } | Measure-Object -Sum).Sum
  $annualSum=[Math]::Round($monthlySum*12,2)
  $totalSf=$leasedSf+$vacantSf
  $occUnits=($occRows | Where-Object { $_.tenant_name -and $_.tenant_name -ne 'Vacant' }).Count
  $avgPsfDisp = if($leasedSf -gt 0){ [Math]::Round($annualSum/$leasedSf,2) } else { 0 }

  Write-Output ("==== "+$f.label)
  Write-Output ("  parsed rows="+$rows.Count+"  occupied="+$occRows.Count+" (units w/tenant="+$occUnits+")  vacant="+$vacRows.Count)
  Write-Output ("  occ monthly base = {0:N2}  (target {1:N2}  diff {2:N2})" -f $monthlySum,$f.expMonthly,($monthlySum-$f.expMonthly))
  Write-Output ("  occ sqft = {0}  (target {1})   vacant sqft = {2}   total sqft = {3}" -f $leasedSf,$f.expOccSf,$vacantSf,$totalSf)
  Write-Output ("  occ units = {0}  (target {1})   annual base = {2:N2}  avg psf = {3:N2}" -f $occUnits,$f.expUnits,$annualSum,$avgPsfDisp)
  if([Math]::Abs($monthlySum-$f.expMonthly) -gt 1){ throw "$($f.label): monthly base mismatch -> ABORT (no DB write)" }

  # snapshot upsert (delete then insert)
  & curl.exe -s -X DELETE "$BASE/rest/v1/rent_roll_snapshots?property_id=eq.$($f.pid)&period_year=eq.$YEAR&period_month=eq.$MONTH" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" | Out-Null
  $occPct = if($totalSf -gt 0){ [Math]::Round($leasedSf/$totalSf,4) } else { $null }
  $avgPsf = if($leasedSf -gt 0){ [Math]::Round($annualSum/$leasedSf,2) } else { $null }
  $snap=@{ property_id=$f.pid; period_year=$YEAR; period_month=$MONTH; total_sf=$totalSf; leased_sf=$leasedSf;
           vacant_sf=$vacantSf; occupancy_pct=$occPct; avg_base_rent_psf=$avgPsf; total_base_rent=$annualSum; row_count=$occRows.Count }
  $sres=Post 'rent_roll_snapshots' @($snap) 'return=representation'
  $sid=$sres[0].id
  if(-not $sid){ throw "$($f.label): no snapshot id returned" }
  foreach($rw in $rows){ $rw['snapshot_id']=$sid }
  $null=Post 'rent_roll_rows' @($rows) 'return=minimal'
  Write-Output ("  DONE snapshot=$sid  rows inserted="+$rows.Count)
 }
} finally { $xl.Quit(); [System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl)|Out-Null }
