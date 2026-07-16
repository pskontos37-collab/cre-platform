# load_acq_pipeline.ps1 - WEEKLY SYNC of the firm's "Acq. Pipeline Summary" Excel
# book (updated for the weekly acquisitions meeting) into pipeline_deals.
#
# SYNC SEMANTICS (v2 - replaces the original clean-replace, which would have
# wiped per-deal enrichment: mirrored documents, discussion threads, LP funnel,
# underwriting fills):
#   UPDATE  deals matched by normalized name: only SHEET-OWNED fields (stage per
#           section, pricing/cap/SF/city/state/market, lead/analyst, type/profile)
#           and only when the sheet cell is non-blank. In-app enrichment is never
#           touched. If the in-app stage is a FINER stage in the same board bucket
#           (e.g. 'dd' inside Under Contract), it is kept.
#   INSERT  sheet deals with no match.
#   RETIRE  loader-origin deals (created_by IS NULL) that were active but no
#           longer appear in the sheet -> stage 'passed' + lost_reason. Deals
#           created IN-APP (created_by set) are never auto-retired.
#   Probability resets to the stage default only when the stage actually changes.
#
# The "Property Tracking" section (past deals) is SKIPPED by default;
# -IncludeTracking loads/syncs it as stage='tracking'.
#
# Usage:  .\load_acq_pipeline.ps1 [-Path <xlsx>] [-IncludeTracking]
#         (omit -Path to auto-discover the newest summary in the meeting folder)
param(
  [string]$Path,
  [switch]$IncludeTracking
)
$ErrorActionPreference = "Stop"
$repo = "C:\Users\pskontos\Desktop\Software\cre-platform"
$cfg = @{}; foreach ($ln in (Get-Content "$repo\.env" | Where-Object { $_ -match "=" })) { $a,$b = $ln -split '=',2; $cfg[$a.Trim()]=$b.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $AK = $cfg['SUPABASE_SECRET_KEY']
$enc = New-Object System.Text.UTF8Encoding($false)
$TMP = "$env:TEMP\_acq_post.json"

# auto-discover the newest weekly summary when -Path not given
if(-not $Path){
  $root = "K:\ASSTMGMT\Asset Management Meetings\Asset Management Meetings\Deal Tracking - Acq. Pipeline"
  $newest = Get-ChildItem -LiteralPath $root -Recurse -Filter "Acq. Pipeline Summary*.xlsx" -ErrorAction SilentlyContinue |
    Where-Object { -not $_.Name.StartsWith('~$') } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if(-not $newest){ throw "no Acq. Pipeline Summary*.xlsx found under $root" }
  $Path = $newest.FullName
}
Write-Output ("Source book: {0}" -f $Path)

function Cell($v){ if($null -eq $v){return $null}; $s=([string]$v).Trim(); if($s -eq '' -or $s -eq '-'){return $null}; return $s }
function DNum($v){ $c=Cell $v; if($null -eq $c){return $null}; try{return [decimal]$c}catch{return $null} }
function NormName($s){ if($null -eq $s){return ''}; $t=([string]$s).ToLower() -replace '&',' and '; return ($t -replace '[^a-z0-9]+','').Trim() }

# roster: first-name -> member id
$roster = & curl.exe -s "$BASE/rest/v1/deal_team_members?select=id,initials,full_name" -H "apikey: $AK" -H "Authorization: Bearer $AK" | ConvertFrom-Json
$byName = @{}
foreach($m in $roster){ $fn = ($m.full_name -split '\s+')[0].ToLower(); $byName[$fn] = $m.id }
function MemberId($cellv){ $c=Cell $cellv; if($null -eq $c){return $null}; $k=($c -split '\s+')[0].ToLower(); if($byName.ContainsKey($k)){return $byName[$k]}; return $null }

function MapAsset($t){ $c=Cell $t; if($null -eq $c){return $null}; $l=$c.ToLower(); if($l -match 'office'){'office'}elseif($l -match 'mixed'){'mixed'}elseif($l -match 'industr'){'industrial'}else{'retail'} }
function MapRisk($p){ $c=Cell $p; if($null -eq $c){return $null}; $l=($c.ToLower() -replace '-',' '); if($l -match 'opportun'){'opportunistic'}elseif($l -match 'value'){'value_add'}elseif($l -match 'core plus'){'core_plus'}elseif($l -match 'core'){'core'}else{'core_plus'} }

$SECTIONS = @{ 'UNDER CONTRACT'='under_contract'; 'LETTER OF INTENT'='loi'; 'PROSPECTS / PIPELINE'='underwriting'; 'PROPERTY TRACKING'='tracking' }
$PROB     = @{ 'under_contract'=0.75; 'loi'=0.5; 'underwriting'=0.25; 'tracking'=0.0; 'sourced'=0.08 }
# board bucket: keep a finer in-app stage when it lives in the same bucket
$BUCKET = @{ sourced='sourced'; screening='underwriting'; underwriting='underwriting'; loi='loi';
  under_contract='under_contract'; dd='under_contract'; ic_approval='under_contract'; closing='under_contract' }

# ── parse the workbook ──
$xl=New-Object -ComObject Excel.Application; $xl.Visible=$false; $xl.DisplayAlerts=$false
$sheetDeals=@(); $seen=@{}
try{
  $wb=$xl.Workbooks.Open($Path,$false,$true)
  $ws=$wb.Worksheets.Item("Aquisition Pipeline")
  $n=$ws.UsedRange.Rows.Count; if($n -gt 600){$n=600}
  $d=$ws.Range($ws.Cells(1,1),$ws.Cells($n,12)).Value2
  $stage=$null
  for($r=1;$r -le $n;$r++){
    $c2=Cell $d[$r,2]; $prop=Cell $d[$r,4]
    if($c2){ $u=$c2.ToUpper(); if($SECTIONS.ContainsKey($u)){
      $stage=$SECTIONS[$u]
      if($stage -eq 'tracking' -and -not $IncludeTracking){ $stage=$null }
      continue
    } }
    if($null -eq $stage -or $null -eq $prop){ continue }
    if($c2 -eq 'Deal Lead'){ continue }
    $dkey = NormName $prop
    if($dkey -eq '' -or $seen.ContainsKey($dkey)){ continue }; $seen[$dkey]=$true
    $sheetDeals += [pscustomobject]@{
      norm=$dkey; name=$prop; stage=$stage
      city=(Cell $d[$r,5]); state=(Cell $d[$r,6]); market=(Cell $d[$r,7])
      gla_sf=(DNum $d[$r,8]); ask_price=(DNum $d[$r,9]); price_text=$(if($null -eq (DNum $d[$r,9])){ Cell $d[$r,9] }else{ $null })
      going_in_cap=(DNum $d[$r,10])
      asset_type=(MapAsset $d[$r,11]); risk_profile=(MapRisk $d[$r,12])
      lead=(MemberId $d[$r,2]); analyst=(MemberId $d[$r,3])
    }
  }
  $wb.Close($false)
} finally { $xl.Quit(); [System.Runtime.Interopservices.Marshal]::ReleaseComObject($xl)|Out-Null }
Write-Output ("Parsed {0} deals from the sheet." -f $sheetDeals.Count)

# ── existing deals ──
$existing = & curl.exe -s "$BASE/rest/v1/pipeline_deals?select=id,name,stage,probability,created_by,city,state,market,gla_sf,ask_price,price_text,going_in_cap,asset_type,risk_profile,lead_member_id,analyst_member_id&limit=2000" -H "apikey: $AK" -H "Authorization: Bearer $AK" | ConvertFrom-Json
$byNorm=@{}; foreach($e in $existing){ $nk=NormName $e.name; if(-not $byNorm.ContainsKey($nk)){ $byNorm[$nk]=$e } }

function Patch($dealId,$obj){
  $obj['updated_at'] = (Get-Date).ToUniversalTime().ToString('o')
  $json = $obj | ConvertTo-Json
  [System.IO.File]::WriteAllText($TMP,$json,$enc)
  $code = & curl.exe -s -o NUL -w "%{http_code}" -X PATCH "$BASE/rest/v1/pipeline_deals?id=eq.$dealId" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" -H "Prefer: return=minimal" --data-binary "@$TMP"
  if([int]$code -lt 200 -or [int]$code -ge 300){ throw "PATCH failed HTTP $code" }
}

$ins=0; $upd=0; $same=0; $retired=0
foreach($s in $sheetDeals){
  $e = $byNorm[$s.norm]
  if(-not $e){
    # INSERT new deal
    $row = @{ name=$s.name; stage=$s.stage; probability=[decimal]$PROB[$s.stage]
      city=$s.city; state=$s.state; market=$s.market; gla_sf=$s.gla_sf
      ask_price=$s.ask_price; price_text=$s.price_text; going_in_cap=$s.going_in_cap
      asset_type=$(if($s.asset_type){$s.asset_type}else{'retail'})
      risk_profile=$(if($s.risk_profile){$s.risk_profile}else{'core_plus'})
      lead_member_id=$s.lead; analyst_member_id=$s.analyst }
    $json = $row | ConvertTo-Json; [System.IO.File]::WriteAllText($TMP,"[$json]",$enc)
    $code = & curl.exe -s -o NUL -w "%{http_code}" -X POST "$BASE/rest/v1/pipeline_deals" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" -H "Prefer: return=minimal" --data-binary "@$TMP"
    if([int]$code -lt 200 -or [int]$code -ge 300){ throw "INSERT $($s.name) failed HTTP $code" }
    Write-Output ("  + new: {0} [{1}]" -f $s.name, $s.stage); $ins++
    continue
  }
  # UPDATE sheet-owned fields (non-blank only); keep finer same-bucket stage
  $p=@{}
  $curBucket = $BUCKET[[string]$e.stage]
  if($curBucket -ne $s.stage){          # different bucket -> sheet stage wins
    if([string]$e.stage -ne $s.stage){ $p['stage']=$s.stage; $p['probability']=[decimal]$PROB[$s.stage]; $p['stage_changed_at']=(Get-Date).ToUniversalTime().ToString('o') }
  }
  foreach($f in @('city','state','market')){ if($s.$f -and [string]$e.$f -ne [string]$s.$f){ $p[$f]=$s.$f } }
  function _d($v){ if($null -eq $v){ return [decimal]0 }; return [decimal]$v }
  if($null -ne $s.gla_sf -and (_d $e.gla_sf) -ne $s.gla_sf){ $p['gla_sf']=$s.gla_sf }
  if($null -ne $s.going_in_cap -and (_d $e.going_in_cap) -ne $s.going_in_cap){ $p['going_in_cap']=$s.going_in_cap }
  if($null -ne $s.ask_price){
    if((_d $e.ask_price) -ne $s.ask_price){ $p['ask_price']=$s.ask_price; $p['price_text']=$null }
  } elseif($s.price_text -and [string]$e.price_text -ne $s.price_text){ $p['price_text']=$s.price_text }
  if($s.asset_type -and [string]$e.asset_type -ne $s.asset_type){ $p['asset_type']=$s.asset_type }
  if($s.risk_profile -and [string]$e.risk_profile -ne $s.risk_profile){ $p['risk_profile']=$s.risk_profile }
  if($s.lead -and [string]$e.lead_member_id -ne [string]$s.lead){ $p['lead_member_id']=$s.lead }
  if($s.analyst -and [string]$e.analyst_member_id -ne [string]$s.analyst){ $p['analyst_member_id']=$s.analyst }
  if($p.Count -gt 0){ Patch $e.id $p; Write-Output ("  ~ updated: {0} ({1})" -f $s.name, (($p.Keys | Where-Object { $_ -ne 'updated_at' }) -join ',')); $upd++ }
  else { $same++ }
}

# ── RETIRE loader-origin actives that dropped off the sheet ──
$ACTIVE = @('sourced','screening','underwriting','loi','under_contract','dd','ic_approval','closing')
foreach($e in $existing){
  $nk = NormName $e.name
  if($seen.ContainsKey($nk)){ continue }
  if($e.created_by){ continue }                       # in-app deals are never auto-retired
  if($ACTIVE -notcontains [string]$e.stage){ continue }
  Patch $e.id @{ stage='passed'; probability=0; stage_changed_at=(Get-Date).ToUniversalTime().ToString('o'); lost_reason=("Dropped from the weekly pipeline summary (" + [IO.Path]::GetFileName($Path) + ")") }
  Write-Output ("  - retired (passed): {0}" -f $e.name); $retired++
}

Write-Output ("SYNC: {0} new, {1} updated, {2} unchanged, {3} retired." -f $ins, $upd, $same, $retired)
