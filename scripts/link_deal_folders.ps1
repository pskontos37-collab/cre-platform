# link_deal_folders.ps1 — matches each pipeline deal to its acquisitions folder
# (K:\ASSTMGMT\ACQUISITIONS\<State>\<Deal>\), snapshots the folder's top-level
# contents, and writes folder_path + folder_files onto the deal. Re-run AFTER
# load_acq_pipeline.ps1 (that clean-replaces deals, so links must be rebuilt).
#
# NOTE the loader gotcha: PowerShell vars are case-insensitive — never name a
# loop var $key (it would clobber the API key). The API key here is $AK.
param([string]$Root = "K:\ASSTMGMT\ACQUISITIONS", [string]$DealFilter)
$ErrorActionPreference = "Stop"
$repo = "C:\Users\pskontos\Desktop\Software\cre-platform"
$cfg = @{}; foreach ($ln in (Get-Content "$repo\.env" | Where-Object { $_ -match "=" })) { $a,$b = $ln -split '=',2; $cfg[$a.Trim()]=$b.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $AK = $cfg['SUPABASE_SECRET_KEY']
$enc = New-Object System.Text.UTF8Encoding($false)
$TMP = "$env:TEMP\_link_patch.json"

$STATE = @{ AL='Alabama';AK='Alaska';AZ='Arizona';AR='Arkansas';CA='California';CO='Colorado';CT='Connecticut';DE='Deleware';DC='DC';FL='Florida';GA='Georgia';HI='Hawaii';ID='Idaho';IL='Illinois';IN='Indiana';IA='Iowa';KS='Kansas';KY='Kentucky';LA='Louisiana';ME='Maine';MD='Maryland';MA='Massachusetts';MI='Michigan';MN='Minnesota';MS='Mississippi';MO='Missouri';MT='Montana';NE='Nebraska';NV='Nevada';NH='New Hampshire';NJ='New Jersey';NM='New Mexico';NY='New York';NC='North Carolina';ND='North Dakota';OH='Ohio';OK='Oklahoma';OR='Oregon';PA='Pennsylvania';PR='Puerto Rico';RI='Rhode Island';SC='South Carolina';SD='South Dakota';TN='Tennessee';TX='Texas';UT='Utah';VT='Vermont';VA='Virginia';WA='Washington';WV='West Virginia';WI='Wisconsin';WY='Wyoming' }

function Norm($s){ if($null -eq $s){return ''}; $t=([string]$s).ToLower() -replace '&',' and '; $t=$t -replace '[^a-z0-9]+',' '; $t=$t.Trim(); if($t.StartsWith('the ')){$t=$t.Substring(4)}; return $t }
$SKIP = @('thumbs.db','.ds_store')

# Hand-mapped overrides for sheet-vs-folder naming drift (deal name, lowercased,
# -> path relative to $Root). Some deals live under CITY folders (e.g. Chicago),
# not the state. Verified 2026-07-10.
$OVERRIDES = @{
  'cortland crossing'           = 'New York\Cortlandt Crossing'
  'pearson properties'          = 'Pennsylvania\Pearson Portfolio'
  'clark & diversy collection'  = 'Chicago\Clark & Diversey'
  'the shops at greenridge'     = 'South Carolina\Shops at Greenridge'
  'the collection at riverpark' = 'California\The Collection Riverpark'
  'lincoln center'              = 'Texas\Lincoln Centre'
  'intl 3'                      = 'Texas\International Plaza III'
  # Verified 2026-07-25 by audit_folder_links.ps1 + document evidence: the sheet's
  # 'The Renaissance' (city listed as the Chicago METRO, 173,000 SF) is Renaissance
  # Place in Highland Park IL - same state, in-metro, GLA matches, and all 32
  # mirrored docs (HFF OM, Landmark Theatres / Dick Blick leases) describe that one
  # property. Pinned so the link is explicit rather than inferred from a prefix.
  'the renaissance'             = 'Illinois\Renaissance Place, Highland Park'
}

# cache state-folder subdirectory listings (one Get-ChildItem per state)
$dirCache = @{}
function StateDirs($full){
  if($dirCache.ContainsKey($full)){ return $dirCache[$full] }
  $p = Join-Path $Root $full
  $list = @()
  if(Test-Path $p){ $list = @(Get-ChildItem -LiteralPath $p -Directory -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ name=$_.Name; norm=(Norm $_.Name); full=$_.FullName } }) }
  $dirCache[$full] = $list; return $list
}

$deals = & curl.exe -s "$BASE/rest/v1/pipeline_deals?select=id,name,state&limit=2000" -H "apikey: $AK" -H "Authorization: Bearer $AK" | ConvertFrom-Json
if($DealFilter){ $deals = @($deals | Where-Object { $_.name -like "*$DealFilter*" }) }
Write-Output ("Deals: {0}" -f $deals.Count)

$matched=0; $i=0; $ambiguous=0
foreach($d in $deals){
  $i++
  $hit = $null
  # 1. explicit override wins
  $ov = $OVERRIDES[([string]$d.name).Trim().ToLower()]
  if($ov){
    $op = Join-Path $Root $ov
    if(Test-Path -LiteralPath $op){ $hit = [pscustomobject]@{ full=$op } }
  }
  if(-not $hit){
    $st = $STATE[[string]$d.state]
    if(-not $st){ continue }
    $nd = Norm $d.name
    if($nd -eq ''){ continue }
    $dirs = StateDirs $st
    # exact norm match wins outright
    $hit = $dirs | Where-Object { $_.norm -eq $nd } | Select-Object -First 1
    if(-not $hit){
      # Fall back to a prefix match, but ONLY when it is UNAMBIGUOUS. A generic
      # deal name is a prefix of several unrelated properties: deal 'The Village'
      # (Austin) normalizes to 'village', which prefix-matched THREE Texas
      # folders - Village at Allen | Village at Fairview | Village on the Parkway
      # - and the old shortest-name-wins tiebreak silently linked it to Village
      # at Allen (a Dallas suburb ~200mi away), then mirrored 36 wrong-property
      # documents onto the deal. When several folders match, refuse to guess and
      # say so; pin the right one with an $OVERRIDES entry above.
      $cand = @($dirs | Where-Object { $_.norm.StartsWith($nd) -or $nd.StartsWith($_.norm) })
      if($cand.Count -eq 1){ $hit = $cand[0] }
      elseif($cand.Count -gt 1){
        Write-Output ("  AMBIGUOUS - NOT linking '{0}': {1} folders match ({2}). Add an OVERRIDES entry to pin the right one." -f $d.name, $cand.Count, (($cand | ForEach-Object { $_.name }) -join ' | '))
        $ambiguous++
      }
    }
  }
  if(-not $hit){ continue }

  $files = @(Get-ChildItem -LiteralPath $hit.full -ErrorAction SilentlyContinue |
    Where-Object { $SKIP -notcontains $_.Name.ToLower() -and -not $_.Name.StartsWith('~$') } |
    Select-Object -First 60 | ForEach-Object { @{ name=$_.Name; dir=[bool]$_.PSIsContainer } })

  $patch = @{ folder_path = $hit.full; folder_files = @($files) } | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText($TMP,$patch,$enc)
  $code = & curl.exe -s -o NUL -w "%{http_code}" -X PATCH "$BASE/rest/v1/pipeline_deals?id=eq.$($d.id)" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" -H "Prefer: return=minimal" --data-binary "@$TMP"
  if([int]$code -lt 200 -or [int]$code -ge 300){ throw "PATCH $($d.name) failed HTTP $code" }
  $matched++
}
Write-Output ("Linked {0} of {1} deals to acquisitions folders.{2}" -f $matched, $deals.Count, $(if($ambiguous){" $ambiguous skipped as AMBIGUOUS (see above)."}else{''}))
