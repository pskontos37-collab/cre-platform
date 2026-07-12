# mirror_deal_docs.ps1 — mirrors each ACTIVE deal's K:\ACQUISITIONS folder into
# Supabase Storage so every file is clickable ("View") in the app's Documents tab
# from anywhere. Browsers block file:// links from https pages and Vercel can't
# reach the LAN — mirroring is the fix.
#
#   DEFAULT = DRY RUN (inventory only, no writes).  -Apply to upload + link.
#
# Rules (user, 2026-07-10):
#  - Year subfolders (e.g. 2015/2026 = prior looks) ALL mirror, but prior-year
#    files get role 'other' + a «YYYY» title prefix; ANALYSIS (OM pick, site-plan
#    extraction) must use only the most recent tree.
#  - Roles inferred from subfolder names (Offering Memorandum→om, Site Plan→
#    site_plan, Argus/Financial→financials, Debt→debt, Teaser→teaser, ...).
# Idempotent: files whose SOURCE path is already linked to the deal are skipped,
# so a monthly re-run only picks up new material. Run AFTER link_deal_folders.ps1.
# NOTE: never name a variable $key here — PS vars are case-insensitive and it
# would clobber $KEY... which is why the API key is $AK.
param(
  [switch]$Apply,
  [string]$DealFilter,          # optional substring filter on deal name
  [int]$MaxFileMB = 50,
  [int]$MaxDepth  = 3,
  # Data-room dumps (e.g. Arlington Highlands: 877 files) would swamp the tab.
  # Key roles always mirror in full; bulk 'other' files cap here (shallowest,
  # current-tree first). The live folder path still exposes the whole set.
  [int]$MaxOtherPerDeal = 60
)
$ErrorActionPreference = "Stop"
$repo = "C:\Users\pskontos\Desktop\Software\cre-platform"
$cfg = @{}; foreach ($ln in (Get-Content "$repo\.env" | Where-Object { $_ -match "=" })) { $a,$b = $ln -split '=',2; $cfg[$a.Trim()]=$b.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $AK = $cfg['SUPABASE_SECRET_KEY']
$enc = New-Object System.Text.UTF8Encoding($false)
$TMP = "$env:TEMP\_mirror_post.json"

$SKIP_NAMES = @('thumbs.db','.ds_store')
$SKIP_EXT   = @('.lnk','.zip','.db','.tmp','.ini')
$CTYPE = @{ '.pdf'='application/pdf'; '.docx'='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  '.doc'='application/msword'; '.xlsx'='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  '.xls'='application/vnd.ms-excel'; '.pptx'='application/vnd.openxmlformats-officedocument.presentationml.presentation';
  '.png'='image/png'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg'; '.txt'='text/plain'; '.csv'='text/csv' }

# role inference from the path RELATIVE to the deal folder (lowercased)
function InferRole([string]$rel){
  $r = $rel.ToLower()
  if($r -match 'site\s*plan'){ return 'site_plan' }
  # OM lives either in an "Offering Memorandum" folder OR as a loose file named
  # "<deal> OM.pdf" / "Offering ..." / "CIM" / "Investment Memorandum|Summary".
  if($r -match 'offering|([^a-z0-9]|^)om([^a-z0-9]|$)|([^a-z0-9]|^)cim([^a-z0-9]|$)|investment (memorandum|summary)'){ return 'om' }
  if($r -match 'teaser'){ return 'teaser' }
  if($r -match 'rent\s*roll'){ return 'rent_roll' }
  if($r -match 'operating|t-?12'){ return 'operating_statement' }
  if($r -match 'argus|financial'){ return 'financials' }
  if($r -match 'debt|loan'){ return 'debt' }
  if($r -match '(^|\\)loi(\\|\s|\.)|letter of intent'){ return 'loi' }
  if($r -match '(^|\\)psa(\\|\s|\.)|purchase and sale|purchase & sale'){ return 'psa' }
  if($r -match 'title|survey'){ return 'title' }
  if($r -match 'environmental|phase i'){ return 'environmental' }
  if($r -match 'estoppel'){ return 'estoppel' }
  return 'other'
}
$DOCTYPE = @{ om='other'; site_plan='site_plan'; teaser='other'; rent_roll='rent_roll';
  operating_statement='operating_statement'; financials='other'; debt='other'; loi='other';
  psa='psa'; title='title'; environmental='other'; estoppel='estoppel'; other='other' }
function SanSeg([string]$s){ return ($s -replace '[^\w.\-]+','_') }

$deals = & curl.exe -s "$BASE/rest/v1/pipeline_deals?select=id,name,folder_path&folder_path=not.is.null&limit=100" -H "apikey: $AK" -H "Authorization: Bearer $AK" | ConvertFrom-Json
if($DealFilter){ $deals = @($deals | Where-Object { $_.name -like "*$DealFilter*" }) }
Write-Output ("Deals with folders: {0}   mode: {1}" -f $deals.Count, $(if($Apply){'APPLY'}else{'DRY RUN'}))

$totFiles=0; $totMB=0.0; $totUp=0; $totSkipBig=0
foreach($d in $deals){
  if(-not (Test-Path -LiteralPath $d.folder_path)){ Write-Output ("  !! folder missing: {0}" -f $d.name); continue }

  # already-mirrored source paths for this deal (idempotency)
  $ex = & curl.exe -s "$BASE/rest/v1/pipeline_deal_documents?deal_id=eq.$($d.id)&select=documents(file_path)" -H "apikey: $AK" -H "Authorization: Bearer $AK" | ConvertFrom-Json
  $have = @{}; foreach($e in $ex){ if($e.documents.file_path){ $have[$e.documents.file_path.ToLower()]=$true } }

  # year subfolders -> most-recent rule
  $yearDirs = @(Get-ChildItem -LiteralPath $d.folder_path -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^(19|20)\d\d$' })
  $curYear = if($yearDirs){ ($yearDirs | ForEach-Object { [int]$_.Name } | Measure-Object -Maximum).Maximum } else { $null }

  $files = @(Get-ChildItem -LiteralPath $d.folder_path -Recurse -File -Depth $MaxDepth -ErrorAction SilentlyContinue |
    Where-Object { $SKIP_NAMES -notcontains $_.Name.ToLower() -and $SKIP_EXT -notcontains $_.Extension.ToLower() -and -not $_.Name.StartsWith('~$') })

  $planned=@(); $mb=0.0; $skipBig=0
  foreach($f in $files){
    $rel = $f.FullName.Substring($d.folder_path.Length).TrimStart('\')
    $top = ($rel -split '\\')[0]
    $prior = $false; $py = $null
    if($curYear -and $top -match '^(19|20)\d\d$' -and [int]$top -ne $curYear){ $prior=$true; $py=$top }
    $sizeMB = [math]::Round($f.Length/1MB,2)
    if($sizeMB -gt $MaxFileMB){ $skipBig++; continue }
    if($have.ContainsKey($f.FullName.ToLower())){ continue }
    $role = if($prior){ 'other' } else { InferRole $rel }
    $ttl = [IO.Path]::GetFileNameWithoutExtension($f.Name)
    if($prior){ $ttl = "«$py» $ttl" }
    $planned += [pscustomobject]@{ file=$f; rel=$rel; role=$role; title=$ttl; prior=$prior; sizeMB=$sizeMB }
    $mb += $sizeMB
  }
  # cap bulk 'other' files (keep current-tree + shallowest first)
  $others = @($planned | Where-Object { $_.role -eq 'other' })
  $dropped = 0
  if($others.Count -gt $MaxOtherPerDeal){
    $keepOthers = $others | Sort-Object @{e={[int]$_.prior}}, @{e={($_.rel -split '\\').Count}}, rel | Select-Object -First $MaxOtherPerDeal
    $keepSet = @{}; foreach($k in $keepOthers){ $keepSet[$k.rel]=$true }
    $dropped = $others.Count - $MaxOtherPerDeal
    $planned = @($planned | Where-Object { $_.role -ne 'other' -or $keepSet.ContainsKey($_.rel) })
    $mb = ($planned | Measure-Object sizeMB -Sum).Sum
  }
  $roleSum = ($planned | Group-Object role | Sort-Object Count -Descending | ForEach-Object { "$($_.Name)=$($_.Count)" }) -join ' '
  Write-Output ("  {0}: {1} new files ({2} MB){3}{4}{5}  [{6}]" -f $d.name, $planned.Count, [math]::Round($mb,1),
    $(if($skipBig){" +$skipBig skipped>$($MaxFileMB)MB"}else{''}),
    $(if($dropped){" +$dropped bulk files not mirrored (see live folder)"}else{''}),
    $(if($curYear){" (current tree=$curYear)"}else{''}), $roleSum)
  $totFiles += $planned.Count; $totMB += $mb; $totSkipBig += $skipBig
  if(-not $Apply){ continue }

  foreach($p in $planned){
    $relSan = (($p.rel -split '\\') | ForEach-Object { SanSeg $_ }) -join '/'
    $spath = "pipeline/$($d.id)/mirror/$relSan"
    $ct = $CTYPE[$p.file.Extension.ToLower()]; if(-not $ct){ $ct='application/octet-stream' }
    # 1. storage upload (x-upsert so re-runs can't collide)
    $ucode = & curl.exe -s -o NUL -w "%{http_code}" -X POST "$BASE/storage/v1/object/documents/$spath" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: $ct" -H "x-upsert: true" --data-binary "@$($p.file.FullName)"
    if([int]$ucode -lt 200 -or [int]$ucode -ge 300){ Write-Output ("    !! upload failed HTTP {0}: {1}" -f $ucode, $p.rel); continue }
    # 2. documents row
    $docBody = @{ title=$p.title; file_name=$p.file.Name; file_path=$p.file.FullName; storage_path=$spath;
      doc_type=$DOCTYPE[$p.role]; file_size_bytes=[long]$p.file.Length; property_id=$null } | ConvertTo-Json
    [System.IO.File]::WriteAllText($TMP,$docBody,$enc)
    $docResp = & curl.exe -s -X POST "$BASE/rest/v1/documents" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" -H "Prefer: return=representation" --data-binary "@$TMP"
    $doc = $null; try { $doc = ($docResp | ConvertFrom-Json) } catch {}
    if(-not $doc -or -not $doc[0].id){ Write-Output ("    !! documents row failed: {0} -> {1}" -f $p.rel, $docResp); continue }
    # 3. link to the deal
    $lnkBody = @{ deal_id=$d.id; document_id=$doc[0].id; role=$p.role } | ConvertTo-Json
    [System.IO.File]::WriteAllText($TMP,$lnkBody,$enc)
    $lcode = & curl.exe -s -o NUL -w "%{http_code}" -X POST "$BASE/rest/v1/pipeline_deal_documents" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" -H "Prefer: return=minimal" --data-binary "@$TMP"
    if([int]$lcode -lt 200 -or [int]$lcode -ge 300){ Write-Output ("    !! link failed HTTP {0}: {1}" -f $lcode, $p.rel); continue }
    $totUp++
  }
}
Write-Output ("TOTAL: {0} files, {1} MB{2}{3}" -f $totFiles, [math]::Round($totMB,1),
  $(if($totSkipBig){", $totSkipBig skipped over ${MaxFileMB}MB"}else{''}),
  $(if($Apply){", $totUp uploaded+linked"}else{' (dry run — nothing written)'}))
