# audit_folder_links.ps1 - READ-ONLY audit of every pipeline deal <-> K:\ACQUISITIONS
# folder link, hunting the failure mode that mis-linked deal 'The Village' (Austin, TX)
# to the folder for 'Village at Allen' (a Dallas-suburb property ~200mi away) and
# mirrored 36 wrong-property documents onto it. Writes NOTHING - run it any time,
# especially after load_acq_pipeline.ps1 / link_deal_folders.ps1.
#
#   .\audit_folder_links.ps1            # audit every deal
#   .\audit_folder_links.ps1 -Verbose2  # also print the per-deal evidence table
#
# Per-deal evidence:
#   how        override | exact | prefix-1 | prefix-N   (how the matcher decided)
#   extra      tokens the FOLDER name adds beyond the deal name - a place qualifier
#              here ('at allen') is the smoking gun for a different property
#   cityEvid   deal city found in the folder path / folder name / mirrored doc titles
#   docsFrom   whether the mirrored documents actually came from the linked folder
#   siblings   how many folders in that state would prefix-match this deal name
#
# Flags: AMBIGUOUS (2+ candidate folders), FOLDER-ADDS-PLACE, OTHER-DEAL-CITY
# (same-state only - a same-named city in another state is a coincidence, not a bug),
# DEAL-TOKENS-ABSENT, FOLDER-SHARED-BY-2-DEALS, DOCS-FROM-OTHER-FOLDER,
# SAME-NAME-FOLDERS-IN-STATE.
param([string]$Root = "K:\ASSTMGMT\ACQUISITIONS", [switch]$Verbose2)
$ErrorActionPreference = "Stop"
$repo = "C:\Users\pskontos\Desktop\Software\cre-platform"
$cfg = @{}; foreach ($ln in (Get-Content "$repo\.env" | Where-Object { $_ -match "=" })) { $a,$b = $ln -split '=',2; $cfg[$a.Trim()]=$b.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $AK = $cfg['SUPABASE_SECRET_KEY']

$STATE = @{ AL='Alabama';AK='Alaska';AZ='Arizona';AR='Arkansas';CA='California';CO='Colorado';CT='Connecticut';DE='Deleware';DC='DC';FL='Florida';GA='Georgia';HI='Hawaii';ID='Idaho';IL='Illinois';IN='Indiana';IA='Iowa';KS='Kansas';KY='Kentucky';LA='Louisiana';ME='Maine';MD='Maryland';MA='Massachusetts';MI='Michigan';MN='Minnesota';MS='Mississippi';MO='Missouri';MT='Montana';NE='Nebraska';NV='Nevada';NH='New Hampshire';NJ='New Jersey';NM='New Mexico';NY='New York';NC='North Carolina';ND='North Dakota';OH='Ohio';OK='Oklahoma';OR='Oregon';PA='Pennsylvania';PR='Puerto Rico';RI='Rhode Island';SC='South Carolina';SD='South Dakota';TN='Tennessee';TX='Texas';UT='Utah';VT='Vermont';VA='Virginia';WA='Washington';WV='West Virginia';WI='Wisconsin';WY='Wyoming' }
# keep in step with link_deal_folders.ps1
function Norm($s){ if($null -eq $s){return ''}; $t=([string]$s).ToLower() -replace '&',' and '; $t=$t -replace '[^a-z0-9]+',' '; $t=$t.Trim(); if($t.StartsWith('the ')){$t=$t.Substring(4)}; return $t }
$OVERRIDES = @{
  'cortland crossing'='New York\Cortlandt Crossing'; 'pearson properties'='Pennsylvania\Pearson Portfolio'
  'clark & diversy collection'='Chicago\Clark & Diversey'; 'the shops at greenridge'='South Carolina\Shops at Greenridge'
  'the collection at riverpark'='California\The Collection Riverpark'; 'lincoln center'='Texas\Lincoln Centre'
  'intl 3'='Texas\International Plaza III'; 'the renaissance'='Illinois\Renaissance Place, Highland Park'
}
# generic retail/office words - NOT place qualifiers
$GENERIC = @('center','centre','shopping','plaza','crossing','commons','square','shops','shoppes','marketplace','market',
             'place','park','pointe','point','town','towne','village','collection','portfolio','retail','office','the',
             'at','on','of','and','mall','walk','landing','station','terrace','heights','ranch','creek','oaks','pavilion')

$dirCache = @{}
function StateDirs($full){
  if($dirCache.ContainsKey($full)){ return $dirCache[$full] }
  $p = Join-Path $Root $full; $list = @()
  if(Test-Path $p){ $list = @(Get-ChildItem -LiteralPath $p -Directory -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ name=$_.Name; norm=(Norm $_.Name) } }) }
  $dirCache[$full] = $list; return $list
}
# PS 5.1: ConvertFrom-Json emits a JSON array as ONE pipeline object, so
# @($x | ConvertFrom-Json) yields Count=1. Assign first, THEN wrap.
function FromJson($s){ $p = $null; try { $p = $s | ConvertFrom-Json } catch { return @() }; if($null -eq $p){ return @() }; return @($p) }

$deals = FromJson ((& curl.exe -s "$BASE/rest/v1/pipeline_deals?select=id,name,city,state,gla_sf,stage,folder_path&order=name&limit=2000" -H "apikey: $AK" -H "Authorization: Bearer $AK") -join "")
$linked = @($deals | Where-Object { $_.folder_path })
Write-Output ("Deals: {0}   linked: {1}   unlinked: {2}" -f $deals.Count, $linked.Count, ($deals.Count - $linked.Count))
# city -> states it appears in, so a same-named city in another state is not flagged
$cityStates = @{}
foreach($d in $deals){ $c = Norm $d.city; if($c){ if(-not $cityStates.ContainsKey($c)){ $cityStates[$c] = @() }; $cityStates[$c] += [string]$d.state } }

$folderCounts = @{}
foreach($d in $linked){ $k = ([string]$d.folder_path).ToLower(); $folderCounts[$k] = 1 + [int]$folderCounts[$k] }

$out = @()
foreach($d in $linked){
  $nd = Norm $d.name
  # NB: do NOT name this $base - PowerShell variables are case-insensitive, so it
  # would clobber $BASE (the Supabase URL) and every later curl call would fail
  # silently with an empty body. Same family as the $key/$KEY and $model/$Model
  # collisions documented in reference_supabase_loaders.
  $fLeaf = Split-Path ([string]$d.folder_path) -Leaf
  $nf = Norm $fLeaf
  $st = $STATE[[string]$d.state]
  $isOv = $OVERRIDES.ContainsKey(([string]$d.name).Trim().ToLower())
  $dirs = if($st){ StateDirs $st } else { @() }
  $siblings   = @($dirs | Where-Object { $_.norm.StartsWith($nd) -or $nd.StartsWith($_.norm) }).Count
  $exactDupes = @($dirs | Where-Object { $_.norm -eq $nd }).Count
  $how = if($isOv){'override'} elseif($nf -eq $nd){'exact'} elseif($siblings -le 1){'prefix-1'} else {"prefix-$siblings"}

  $dTok = @($nd -split ' ' | Where-Object { $_ }); $fTok = @($nf -split ' ' | Where-Object { $_ })
  $extra   = @($fTok | Where-Object { $dTok -notcontains $_ })
  $missing = @($dTok | Where-Object { $fTok -notcontains $_ })
  $extraPlace = @($extra | Where-Object { $GENERIC -notcontains $_ -and $_.Length -gt 2 -and $_ -notmatch '^\d+$' })

  $docs = FromJson ((& curl.exe -s "$BASE/rest/v1/pipeline_deal_documents?deal_id=eq.$($d.id)&select=documents(title,file_path)&limit=300" -H "apikey: $AK" -H "Authorization: Bearer $AK") -join "")
  $segs = @(); $titles = @()
  foreach($r in $docs){
    $fp = [string]$r.documents.file_path
    if($fp -match '(?i)ACQUISITIONS\\[^\\]+\\([^\\]+)'){ $segs += $Matches[1] }
    if($r.documents.title){ $titles += [string]$r.documents.title }
  }
  $segs = @($segs | Select-Object -Unique)
  $segMismatch = @($segs | Where-Object { (Norm $_) -ne $nf })

  $city = Norm $d.city
  $hay = ($fLeaf + ' ' + ([string]$d.folder_path) + ' ' + ($titles -join ' ')).ToLower()
  $cityEvid = if(-not $city){'n/a'} elseif($hay -match [regex]::Escape($city)){'yes'} else {'no'}
  # another deal's city named in the folder - only meaningful IN THE SAME STATE
  $otherCity = @($cityStates.Keys | Where-Object {
      $_ -and $_ -ne $city -and $_.Length -gt 3 -and ($nf -match ('\b'+[regex]::Escape($_)+'\b')) -and ($cityStates[$_] -contains [string]$d.state) })

  $flags = @()
  if($how -like 'prefix-*' -and $how -ne 'prefix-1'){ $flags += 'AMBIGUOUS' }
  if($extraPlace.Count -gt 0 -and $how -notin @('override','exact')){ $flags += ('FOLDER-ADDS-PLACE(' + ($extraPlace -join ',') + ')') }
  if($otherCity.Count -gt 0){ $flags += ('OTHER-DEAL-CITY-SAME-STATE(' + ($otherCity -join ',') + ')') }
  if($missing.Count -gt 0 -and $how -ne 'override'){ $flags += ('DEAL-TOKENS-ABSENT(' + ($missing -join ',') + ')') }
  if($folderCounts[([string]$d.folder_path).ToLower()] -gt 1){ $flags += 'FOLDER-SHARED-BY-2-DEALS' }
  if($segMismatch.Count -gt 0){ $flags += ('DOCS-FROM-OTHER-FOLDER(' + (($segMismatch | Select-Object -First 2) -join ',') + ')') }
  if($exactDupes -gt 1){ $flags += "SAME-NAME-FOLDERS-IN-STATE($exactDupes)" }

  $out += [pscustomobject]@{ deal=$d.name; city=$d.city; st=$d.state; folder=$fLeaf; how=$how; docs=$docs.Count
    cityEvid=$cityEvid; docsFrom=$(if($segs.Count -eq 0){'none'}elseif($segMismatch.Count -eq 0){'linked folder'}else{'MISMATCH'}); flags=($flags -join ' ') }
}

if($Verbose2){
  Write-Output "`n=== ALL LINKS:"
  $out | Sort-Object how, deal | ForEach-Object {
    Write-Output ("  {0,-11} city={1,-4} docs={2,-4} from={3,-14} {4,-30} -> {5}" -f $_.how, $_.cityEvid, $_.docs, $_.docsFrom, $_.deal, $_.folder)
  }
}
Write-Output "`n=== FLAGGED FOR REVIEW:"
$fl = @($out | Where-Object { $_.flags })
if($fl.Count -eq 0){ Write-Output "  (none - every link's folder agrees with its deal)" }
else { $fl | Sort-Object deal | ForEach-Object {
    Write-Output ("  '{0}' ({1}, {2}) -> '{3}' [{4}, {5} docs]" -f $_.deal, $_.city, $_.st, $_.folder, $_.how, $_.docs)
    Write-Output ("      {0}" -f $_.flags) } }

Write-Output "`n=== UNLINKED deals (no folder; expected for new/renamed deals):"
foreach($d in @($deals | Where-Object { -not $_.folder_path })){
  $st = $STATE[[string]$d.state]
  $why = if(-not $st){'no state on deal'} else {
    $nd = Norm $d.name; $c = @((StateDirs $st) | Where-Object { $_.norm.StartsWith($nd) -or $nd.StartsWith($_.norm) })
    if($c.Count -gt 1){ 'AMBIGUOUS: ' + (($c | ForEach-Object { $_.name }) -join ' | ') } elseif($c.Count -eq 1){ 'single candidate - rerun the linker' } else { 'no folder on the file server' } }
  Write-Output ("  {0,-30} ({1}, {2}): {3}" -f $d.name, $d.city, $d.state, $why)
}
Write-Output "`n=== summary:"
$out | Group-Object how | Sort-Object Count -Descending | ForEach-Object { Write-Output ("  {0,-11} {1}" -f $_.Name, $_.Count) }
Write-Output ("  docs traced to the linked folder: {0} of {1} linked deals that have documents" -f @($out | Where-Object { $_.docsFrom -eq 'linked folder' }).Count, @($out | Where-Object { $_.docs -gt 0 }).Count)
Write-Output ("  FLAGGED: {0}" -f $fl.Count)
