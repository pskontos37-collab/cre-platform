$ErrorActionPreference = "Stop"
# Loads MRI_CMROLL rent-roll Excel exports into rent_roll_snapshots + rent_roll_rows.
# One clean MRI_CMROLL export per owned building. Self-validates occupied totals vs the
# file's own "Totals:" row. Idempotent: deletes the snapshot for that property+period first.
$SP = "C:\Users\pskontos\AppData\Local\Temp\claude\C--Users-pskontos-Desktop-Software\2436a928-7d95-4920-bf6c-f02ed67172a9\scratchpad"
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
# KM WEST (Midtown #0531), July 2026. Targets read from the file's own Totals: row at r75
# (138756 sqft / 192413.87 monthly). Same convention as Midway: the file reports "12 Units"
# while the parse finds 15 occupied rows -- the extra 3 are 0-sf pad/ground leases the file
# does not count. Only the MONTHLY figure is enforced (line ~104), and it matches exactly.
# KM West already holds 2025-09 and 2025-10 snapshots; this ADDS 2026-07, deleting neither.
$files=@(
 @{ path="\\192.168.220.121\users\Working Files - Knightdale Marketplace\Monthly Reporting\2026\07-2026\Midtown #0531\Supplemental\07.2026 Rent Roll - Midtown.xlsx";
    pid='00000000-0000-0000-0000-000000000011'; label='KM West - Midtown #0531 (07.2026)';
    expMonthly=192413.87; expUnits=12; expOccSf=138756 }
)

$YEAR=2026; $MONTH=7

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

  $occPct = if($totalSf -gt 0){ [Math]::Round($leasedSf/$totalSf,4) } else { $null }
  $avgPsf = if($leasedSf -gt 0){ [Math]::Round($annualSum/$leasedSf,2) } else { $null }

  if($env:RR_STAGE -eq '1'){
    # STAGED IMPORT (mig 20240127): write the batch for diff-and-approve on /imports
    # instead of replacing the period directly. Apply happens via apply_mri_import
    # after a human reviews the computed diff.
    $batch=@{ kind='rentroll'; property_id=$f.pid; period_year=$YEAR; period_month=$MONTH; label=$f.label;
              source_file=(Split-Path $f.path -Leaf);
              summary=@{ total_sf=$totalSf; leased_sf=$leasedSf; vacant_sf=$vacantSf; occupancy_pct=$occPct;
                         avg_base_rent_psf=$avgPsf; total_base_rent=$annualSum; row_count=$occRows.Count } }
    $bres=Post 'mri_import_batches' @($batch) 'return=representation'
    $bid=$bres[0].id
    if(-not $bid){ throw "$($f.label): no batch id returned" }
    $iRows=@(); $ix=0
    foreach($rw in $rows){ $ix++; $iRows += @{ batch_id=$bid; row_index=$ix; payload=$rw } }
    $null=Post 'mri_import_rows' @($iRows) 'return=minimal'
    # compute + store the diff so /imports renders instantly
    [System.IO.File]::WriteAllText($TMP,(@{ p_batch=$bid }|ConvertTo-Json),$enc)
    $dres = & curl.exe -s -X POST "$BASE/rest/v1/rpc/mri_import_diff" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" --data-binary "@$TMP"
    $d = $dres | ConvertFrom-Json
    Write-Output ("  STAGED batch=$bid rows="+$rows.Count+"  diff: new="+@($d.new_tenants).Count+" changed="+@($d.changed).Count+" departed="+@($d.departed).Count+" unchanged="+$d.unchanged_count+"  -> review on /imports")
  } else {
    # snapshot upsert (delete then insert)
    & curl.exe -s -X DELETE "$BASE/rest/v1/rent_roll_snapshots?property_id=eq.$($f.pid)&period_year=eq.$YEAR&period_month=eq.$MONTH" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" | Out-Null
    $snap=@{ property_id=$f.pid; period_year=$YEAR; period_month=$MONTH; total_sf=$totalSf; leased_sf=$leasedSf;
             vacant_sf=$vacantSf; occupancy_pct=$occPct; avg_base_rent_psf=$avgPsf; total_base_rent=$annualSum; row_count=$occRows.Count }
    $sres=Post 'rent_roll_snapshots' @($snap) 'return=representation'
    $sid=$sres[0].id
    if(-not $sid){ throw "$($f.label): no snapshot id returned" }
    foreach($rw in $rows){ $rw['snapshot_id']=$sid }
    $null=Post 'rent_roll_rows' @($rows) 'return=minimal'
    Write-Output ("  DONE snapshot=$sid  rows inserted="+$rows.Count)
  }
 }
} finally { $xl.Quit(); [System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl)|Out-Null }
