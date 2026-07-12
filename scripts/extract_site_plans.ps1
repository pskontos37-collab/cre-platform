# extract_site_plans.ps1 - the acquisition team wants a SITE PLAN on every deal.
# For each active deal: if the mirror produced no standalone site-plan file, find
# the deal's (most-recent) Offering Memorandum, ask Claude which page(s) show the
# site plan, clip those pages with qpdf, upload as "Site Plan (from OM)" and link
# it role='site_plan' so it renders as a clickable file (and the drawer's 🗺
# quick link). Run AFTER mirror_deal_docs.ps1 -Apply.
#
#   DEFAULT = DRY RUN (reports which deals have/need/can't).  -Apply to extract.
param(
  [switch]$Apply,
  [string]$DealFilter,
  [string]$Model = 'claude-sonnet-5'
)
$ErrorActionPreference = "Stop"
$repo = "C:\Users\pskontos\Desktop\Software\cre-platform"
$cfg = @{}; foreach ($ln in (Get-Content "$repo\.env" | Where-Object { $_ -match "=" })) { $a,$b = $ln -split '=',2; $cfg[$a.Trim()]=$b.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $AK = $cfg['SUPABASE_SECRET_KEY']; $ANTH = $cfg['ANTHROPIC_API_KEY']
$enc = New-Object System.Text.UTF8Encoding($false)
$SP = "$env:TEMP\siteplan_work"; New-Item -ItemType Directory -Force $SP | Out-Null
$TMP = "$SP\_post.json"

# ── qpdf (portable) ──
function Get-Qpdf {
  $found = Get-ChildItem "$SP" -Recurse -Filter qpdf.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if($found){ return $found.FullName }
  # Write-Host, NOT Write-Output: function output streams become the RETURN value
  Write-Host "  downloading portable qpdf..."
  $rel = Invoke-RestMethod "https://api.github.com/repos/qpdf/qpdf/releases/latest" -UseBasicParsing
  $asset = $rel.assets | Where-Object { $_.name -match 'msvc64\.zip$' } | Select-Object -First 1
  if(-not $asset){ $asset = $rel.assets | Where-Object { $_.name -match 'mingw64\.zip$' } | Select-Object -First 1 }
  if(-not $asset){ throw "no qpdf windows zip found in latest release" }
  $zip = "$SP\qpdf.zip"
  Invoke-WebRequest $asset.browser_download_url -OutFile $zip -UseBasicParsing
  Expand-Archive $zip -DestinationPath $SP -Force
  $found = Get-ChildItem "$SP" -Recurse -Filter qpdf.exe | Select-Object -First 1
  if(-not $found){ throw "qpdf.exe not found after extract" }
  return $found.FullName
}

# ── Claude: which pages show the site plan? (forced tool -> parsed JSON) ──
function Find-SitePlanPages([string]$signedUrl){
  $body = @{
    model = $Model; max_tokens = 500
    tools = @(@{ name='report_pages'; description='Report the site plan pages.'
      input_schema = @{ type='object'; properties=@{
        found=@{type='boolean'}; pages=@{type='array'; items=@{type='integer'}}
        note=@{type='string'} }; required=@('found','pages') } })
    tool_choice = @{ type='tool'; name='report_pages' }
    messages = @(@{ role='user'; content=@(
      @{ type='document'; source=@{ type='url'; url=$signedUrl } },
      @{ type='text'; text="This is a commercial real estate Offering Memorandum. Identify the page number(s) (1-based, within THIS document) that show the property's SITE PLAN - the schematic leasing plan / suite-layout map of the shopping center or office property (typically a labeled plan of buildings, suites, tenants and parking). NOT location/aerial maps, NOT stacking plans, NOT photos. If a site plan spans consecutive pages, list them all. If none exists, found=false." }
    )})
  } | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($TMP,$body,$enc)
  $resp = & curl.exe -s "https://api.anthropic.com/v1/messages" -H "x-api-key: $ANTH" -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json" --data-binary "@$TMP" | ConvertFrom-Json
  if($resp.error){ throw ("anthropic: " + $resp.error.message) }
  $tu = $resp.content | Where-Object { $_.type -eq 'tool_use' } | Select-Object -First 1
  if(-not $tu){ throw "no tool_use in response" }
  return $tu.input
}

function Sign([string]$spath){
  $b = '{"expiresIn":3600}'
  [System.IO.File]::WriteAllText($TMP,$b,$enc)
  $r = & curl.exe -s -X POST "$BASE/storage/v1/object/sign/documents/$spath" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" --data-binary "@$TMP" | ConvertFrom-Json
  if(-not $r.signedURL){ throw "sign failed for $spath" }
  return "$BASE/storage/v1$($r.signedURL)"
}

$deals = & curl.exe -s "$BASE/rest/v1/pipeline_deals?select=id,name&folder_path=not.is.null&limit=100" -H "apikey: $AK" -H "Authorization: Bearer $AK" | ConvertFrom-Json
if($DealFilter){ $deals = @($deals | Where-Object { $_.name -like "*$DealFilter*" }) }
$qpdf = $null
$done=0; $need=0; $noOm=0

foreach($d in $deals){
  $links = & curl.exe -s "$BASE/rest/v1/pipeline_deal_documents?deal_id=eq.$($d.id)&select=role,documents(id,title,file_path,storage_path,file_size_bytes)" -H "apikey: $AK" -H "Authorization: Bearer $AK" | ConvertFrom-Json
  if(@($links | Where-Object { $_.role -eq 'site_plan' }).Count -gt 0){
    Write-Output ("  {0}: site plan PRESENT" -f $d.name); $done++; continue
  }
  # current-tree OM = role 'om', not a «prior-year» title; largest file wins
  $oms = @($links | Where-Object { $_.role -eq 'om' -and $_.documents.title -notmatch '^\xAB' -and $_.documents.file_path -match '\.pdf$' }) |
    Sort-Object { [long]$_.documents.file_size_bytes } -Descending
  if(-not $oms -or $oms.Count -eq 0){
    Write-Output ("  {0}: NO OM mirrored - cannot extract" -f $d.name); $noOm++; continue
  }
  $om = $oms[0].documents
  Write-Output ("  {0}: NEEDS extraction from OM '{1}' ({2} MB)" -f $d.name, $om.title, [math]::Round([long]$om.file_size_bytes/1MB,1))
  $need++
  if(-not $Apply){ continue }

  if(-not $qpdf){ $qpdf = Get-Qpdf; Write-Output ("  qpdf: {0}" -f $qpdf) }
  $src = $om.file_path
  if(-not (Test-Path -LiteralPath $src)){ Write-Output "    !! source OM not reachable on K:"; continue }

  # per-deal guard: one oversized/odd OM must never kill the batch
  $result = $null; $offset = 0
  try {
    $npages = [int](& $qpdf --show-npages $src)
    $fileMB = [double]$om.file_size_bytes / 1MB
    # Claude's URL fetch caps ~32MB and 100 pages. Chunk when EITHER is exceeded,
    # sizing chunks by bytes-per-page so each stays under ~26MB.
    if($npages -le 95 -and $fileMB -le 26){
      $result = Find-SitePlanPages (Sign $om.storage_path)
    } else {
      $per = 90
      if($fileMB -gt 26){ $per = [Math]::Max(8, [int][Math]::Floor($npages * 24.0 / $fileMB)) }
      if($per -gt 90){ $per = 90 }
      for($c=0; $c -lt 4 -and -not ($result -and $result.found); $c++){
        $a = $c*$per+1; if($a -gt $npages){ break }
        $b = [Math]::Min(($c+1)*$per, $npages)
        $chunk = "$SP\chunk.pdf"
        & $qpdf $src --pages . "$a-$b" -- $chunk
        $tmpPath = "pipeline/$($d.id)/mirror/_tmp_chunk.pdf"
        & curl.exe -s -o NUL -X POST "$BASE/storage/v1/object/documents/$tmpPath" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/pdf" -H "x-upsert: true" --data-binary "@$chunk" | Out-Null
        $result = Find-SitePlanPages (Sign $tmpPath)
        if($result.found){ $offset = $a-1 }
        & curl.exe -s -o NUL -X DELETE "$BASE/storage/v1/object/documents/$tmpPath" -H "apikey: $AK" -H "Authorization: Bearer $AK" | Out-Null
      }
    }
  } catch { Write-Output ("    !! extraction error, skipping deal: {0}" -f $_.Exception.Message); continue }
  if(-not $result -or -not $result.found -or -not $result.pages){ Write-Output "    -> no site plan found in OM"; continue }
  $pg = @($result.pages | ForEach-Object { [int]$_ + $offset } | Sort-Object -Unique)
  $range = ($pg | ForEach-Object { "$_" }) -join ','
  Write-Output ("    -> site plan on OM page(s) {0}" -f $range)

  # clip + upload + register
  $out = "$SP\siteplan.pdf"
  & $qpdf $src --pages . $range -- $out
  $spath = "pipeline/$($d.id)/mirror/_extracted/Site_Plan_from_OM.pdf"
  $uc = & curl.exe -s -o NUL -w "%{http_code}" -X POST "$BASE/storage/v1/object/documents/$spath" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/pdf" -H "x-upsert: true" --data-binary "@$out"
  if([int]$uc -lt 200 -or [int]$uc -ge 300){ Write-Output "    !! upload failed HTTP $uc"; continue }
  $docBody = @{ title="Site Plan (from OM, p.$range)"; file_name="Site_Plan_from_OM.pdf"; file_path=$src;
    storage_path=$spath; doc_type='site_plan'; file_size_bytes=[long](Get-Item $out).Length; property_id=$null } | ConvertTo-Json
  [System.IO.File]::WriteAllText($TMP,$docBody,$enc)
  $docResp = & curl.exe -s -X POST "$BASE/rest/v1/documents" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" -H "Prefer: return=representation" --data-binary "@$TMP" | ConvertFrom-Json
  if(-not $docResp -or -not $docResp[0].id){ Write-Output "    !! documents row failed"; continue }
  $lnk = @{ deal_id=$d.id; document_id=$docResp[0].id; role='site_plan' } | ConvertTo-Json
  [System.IO.File]::WriteAllText($TMP,$lnk,$enc)
  & curl.exe -s -o NUL -X POST "$BASE/rest/v1/pipeline_deal_documents" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" -H "Prefer: return=minimal" --data-binary "@$TMP" | Out-Null
  Write-Output "    -> extracted + linked OK"
}
Write-Output ("SUMMARY: {0} have site plans, {1} need extraction, {2} lack an OM." -f $done, $need, $noOm)
