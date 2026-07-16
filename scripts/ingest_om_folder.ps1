# ingest_om_folder.ps1 - OM drop-folder auto-ingest (Phase 3 sourcing automation).
# Scans a drop folder for NEW offering-memorandum PDFs, uploads each to storage,
# Claude-extracts the deal, dedups against the live pipeline, and auto-creates a
# 'sourced' pipeline deal + om_intake tracking row + Documents-tab link. The team
# then triages the new 'sourced' deals in /pipeline (the buy-box fit badge flags
# off-strategy ones immediately).
#
#   .\ingest_om_folder.ps1 -DropFolder "K:\...\New OMs"          # DRY RUN (lists)
#   .\ingest_om_folder.ps1 -DropFolder "K:\...\New OMs" -Apply   # creates deals
#
# Idempotent: a manifest (scripts\logs\om_ingest_manifest.txt) records processed
# files so re-runs skip them; dedup also skips OMs whose name+city already exist.
# Conventions: ASCII only; straight quotes; NEVER name a local like the $Model
# param; Write-Host (not Write-Output) inside functions.
param(
  [Parameter(Mandatory=$true)][string]$DropFolder,
  [switch]$Apply,
  [string]$Requestor = 'OM inbox',
  [string]$Model = 'claude-sonnet-5'
)
$ErrorActionPreference = "Stop"
$repo = "C:\Users\pskontos\Desktop\Software\cre-platform"
$cfg = @{}; foreach ($ln in (Get-Content "$repo\.env" | Where-Object { $_ -match "=" })) { $a,$b = $ln -split '=',2; $cfg[$a.Trim()]=$b.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $AK = $cfg['SUPABASE_SECRET_KEY']; $ANTH = $cfg['ANTHROPIC_API_KEY']
$enc = New-Object System.Text.UTF8Encoding($false); $TMP = "$env:TEMP\_om_ingest.json"
$MAX_MB = 32.0
if(-not (Test-Path $DropFolder)){ Write-Output "Drop folder not found: $DropFolder"; exit 1 }
$logDir = Join-Path $repo "scripts\logs"; New-Item -ItemType Directory -Force $logDir | Out-Null
$manifest = Join-Path $logDir "om_ingest_manifest.txt"
if(-not (Test-Path $manifest)){ New-Item -ItemType File $manifest | Out-Null }
$seenFiles = @{}; foreach($ln in (Get-Content $manifest)){ if($ln.Trim()){ $seenFiles[$ln.Trim()] = $true } }

function NormName([string]$s){ if(-not $s){ return '' }; return ($s.ToLower() -replace '[^a-z0-9]','') }
function Sign([string]$spath){
  [System.IO.File]::WriteAllText($TMP,'{"expiresIn":3600}',$enc)
  $r = & curl.exe -s -X POST "$BASE/storage/v1/object/sign/documents/$spath" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" --data-binary "@$TMP" | ConvertFrom-Json
  if(-not $r.signedURL){ throw "sign failed for $spath" }
  return "$BASE/storage/v1$($r.signedURL)"
}
$SCHEMA = '{"name":str,"city":str|null,"state":str|null,"submarket":str|null,"asset_type":"retail"|"office"|"mixed"|"industrial"|null,"risk_profile":"core"|"core_plus"|"value_add"|"opportunistic"|null,"sub_type":str|null,"gla_sf":num|null,"year_built":num|null,"occupancy":num|null,"asking_price":num|null,"asking_guidance_text":str|null,"in_place_cap":num|null,"noi":num|null,"major_tenants":[{"name":str,"sf":num|null,"expiration":str|null}],"key_points":[str],"open_questions":[str]}'
function Extract-Om([string]$signedUrl, [string]$fileName){
  $content = @(
    @{ type='document'; source=@{ type='url'; url=$signedUrl } },
    @{ type='text'; text=@"
You are an acquisitions analyst at M&J Wilkow. The attached PDF is an offering memorandum (OM) for a commercial real estate deal (file: $fileName). Extract the deal for the acquisition pipeline.

Rules:
- name = property/deal name. city/state = location; submarket = CBD/Suburban/named submarket if stated.
- asset_type = retail | office | mixed | industrial (best fit). risk_profile = core | core_plus | value_add | opportunistic (infer from the business plan; retail value-add is common).
- gla_sf = total building square feet. occupancy = decimal (0.95 = 95%). asking_price = guidance price in dollars if stated (else null); asking_guidance_text = the guidance phrasing if not a clean number ('Offers due', 'Unpriced', 'Best offer'). in_place_cap = going-in cap rate as a decimal (0.07 = 7%). noi = in-place NOI dollars if stated.
- major_tenants = up to ~8 anchor/major tenants (name, sf, lease expiration if shown). key_points = 3-6 concise investment-thesis bullets. open_questions = items an analyst must verify.
- EXTRACT ONLY what the OM states; null for anything absent. Do NOT invent numbers.
- Call report_om with an object matching exactly (all keys present):
$SCHEMA
"@ }
  )
  $body = @{ model=$Model; max_tokens=3000
    tools=@(@{ name='report_om'; description='Report the extracted deal.'; input_schema=@{ type='object'; additionalProperties=$true } })
    tool_choice=@{ type='tool'; name='report_om' }
    messages=@(@{ role='user'; content=$content }) } | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText($TMP,$body,$enc)
  $resp = & curl.exe -s "https://api.anthropic.com/v1/messages" -H "x-api-key: $ANTH" -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json" --data-binary "@$TMP" | ConvertFrom-Json
  if($resp.error){ $em = if($resp.error.message -is [string]){ $resp.error.message } else { ($resp.error | ConvertTo-Json -Compress -Depth 6) }; throw ("anthropic: " + $em) }
  $tu = $resp.content | Where-Object { $_.type -eq 'tool_use' } | Select-Object -First 1
  if(-not $tu){ throw "no tool_use in response" }
  return $tu.input
}
function NormAsset($a){ if($a -match 'retail'){'retail'}elseif($a -match 'office'){'office'}elseif($a -match 'indus'){'industrial'}elseif($a -match 'mix'){'mixed'}else{'retail'} }
function NormRisk($r){ if($r -match 'oppo'){'opportunistic'}elseif($r -match 'value'){'value_add'}elseif($r -match 'core.?plus|core_plus'){'core_plus'}elseif($r -match 'core'){'core'}else{'value_add'} }

# resolve a non-null created_by (an admin/AM) so the weekly loader never auto-retires ingested deals
$CREATED_BY = $null
$users = & curl.exe -s "$BASE/rest/v1/users?select=id,email,role&or=(role.eq.admin,role.eq.asset_manager)&limit=50" -H "apikey: $AK" -H "Authorization: Bearer $AK" | ConvertFrom-Json
if($users){ $me = @($users | Where-Object { $_.email -eq 'pskontos@wilkow.com' }); $CREATED_BY = if($me.Count){ $me[0].id } else { $users[0].id } }
if($Apply -and -not $CREATED_BY){ Write-Output "No admin/asset_manager user found to attribute ingested deals to; aborting (would risk weekly auto-retirement)."; exit 1 }

# existing deals for dedup
$existing = & curl.exe -s "$BASE/rest/v1/pipeline_deals?select=name,city&limit=2000" -H "apikey: $AK" -H "Authorization: Bearer $AK" | ConvertFrom-Json
$dedup = @{}; foreach($e in $existing){ $dedup[(NormName ($e.name + '|' + $e.city))] = $true }

$pdfs = @(Get-ChildItem -Path $DropFolder -Recurse -File -Filter *.pdf)
Write-Output ("Drop folder: {0}   PDFs: {1}   mode: {2}   attribute-to: {3}" -f $DropFolder, $pdfs.Count, $(if($Apply){'APPLY'}else{'DRY RUN'}), $CREATED_BY)
$done=0; $skipSeen=0; $skipDup=0; $skipBig=0; $fail=0

foreach($pdf in $pdfs){
  $key = "$($pdf.FullName)|$($pdf.Length)|$($pdf.LastWriteTimeUtc.Ticks)"
  if($seenFiles.ContainsKey($key)){ $skipSeen++; continue }
  $mb = [math]::Round($pdf.Length/1MB,1)
  if($pdf.Length/1MB -gt $MAX_MB){ Write-Output ("  {0}: too large ({1}MB > {2}MB) - upload manually" -f $pdf.Name,$mb,$MAX_MB); $skipBig++; continue }
  Write-Output ("  {0} ({1}MB)" -f $pdf.Name, $mb)
  if(-not $Apply){ continue }

  try {
    # 1. upload to storage
    $guid = [guid]::NewGuid().ToString('N')
    $san = ($pdf.Name -replace '[^A-Za-z0-9._-]','_')
    $spath = "pipeline/om/$guid-$san"
    $uc = & curl.exe -s -o NUL -w "%{http_code}" -X POST "$BASE/storage/v1/object/documents/$spath" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/pdf" -H "x-upsert: true" --data-binary "@$($pdf.FullName)"
    if([int]$uc -lt 200 -or [int]$uc -ge 300){ throw "upload HTTP $uc" }
    # 2. documents row
    $docBody = @{ title=$pdf.BaseName; file_name=$pdf.Name; storage_path=$spath; doc_type='other'; file_size_bytes=[long]$pdf.Length; property_id=$null } | ConvertTo-Json
    [System.IO.File]::WriteAllText($TMP,$docBody,$enc)
    $docResp = & curl.exe -s -X POST "$BASE/rest/v1/documents" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" -H "Prefer: return=representation" --data-binary "@$TMP"
    $doc = $null; try { $doc = ($docResp | ConvertFrom-Json) } catch {}
    if(-not $doc -or -not $doc[0].id){ throw "documents row failed: $docResp" }
    $docId = $doc[0].id
    # 3. extract
    $om = Extract-Om (Sign $spath) $pdf.Name
    $nm = if($om.name){ [string]$om.name } else { $pdf.BaseName }
    # 4. dedup
    $dk = NormName ($nm + '|' + $om.city)
    if($dedup.ContainsKey($dk)){ Write-Output ("    -> duplicate of an existing deal ({0}) - skipped" -f $nm); Add-Content $manifest $key; $skipDup++; continue }
    # 5. create 'sourced' deal
    $thesis = $null
    if($om.key_points){ $thesis = (@($om.key_points) | Select-Object -First 4 | ForEach-Object { '- ' + $_ }) -join "`n" }
    $cap = if($null -ne $om.in_place_cap -and [double]$om.in_place_cap -gt 0 -and [double]$om.in_place_cap -lt 0.2){ [double]$om.in_place_cap } else { $null }
    $dealRow = @{ name=$nm; asset_type=(NormAsset ([string]$om.asset_type)); risk_profile=(NormRisk ([string]$om.risk_profile));
      sub_type=$om.sub_type; submarket=$om.submarket; market=(@($om.city,$om.state) | Where-Object { $_ } ) -join ', ';
      city=$om.city; state=$om.state; gla_sf=$om.gla_sf; year_built=$om.year_built;
      ask_price=$om.asking_price; price_text=$om.asking_guidance_text; going_in_cap=$cap; thesis=$thesis;
      stage='sourced'; probability=0.08; deal_source='marketed'; created_by=$CREATED_BY }
    [System.IO.File]::WriteAllText($TMP, ('[' + ($dealRow | ConvertTo-Json -Depth 6) + ']'), $enc)
    $dealResp = & curl.exe -s -X POST "$BASE/rest/v1/pipeline_deals" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" -H "Prefer: return=representation" --data-binary "@$TMP"
    $dl = $null; try { $dl = ($dealResp | ConvertFrom-Json) } catch {}
    if(-not $dl -or -not $dl[0].id){ throw "deal insert failed: $dealResp" }
    $dealId = $dl[0].id
    # 6. om_intake tracking row (extracted payload)
    $omRow = @{ deal_id=$dealId; deal_name=$nm; city=$om.city; state=$om.state; om_received=$true; base_model='none';
      extracted=$om; source_document_id=$docId; created_by=$CREATED_BY; requestor=$Requestor } | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText($TMP,$omRow,$enc)
    & curl.exe -s -o NUL -X POST "$BASE/rest/v1/om_intake" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" -H "Prefer: return=minimal" --data-binary "@$TMP" | Out-Null
    # 7. link the OM into the deal's Documents tab
    $lnk = @{ deal_id=$dealId; document_id=$docId; role='om'; created_by=$CREATED_BY } | ConvertTo-Json
    [System.IO.File]::WriteAllText($TMP,$lnk,$enc)
    & curl.exe -s -o NUL -X POST "$BASE/rest/v1/pipeline_deal_documents" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" -H "Prefer: return=minimal" --data-binary "@$TMP" | Out-Null

    $dedup[$dk] = $true
    Add-Content $manifest $key
    Write-Output ("    -> CREATED sourced deal '{0}' [{1} / {2}]{3}" -f $nm, $dealRow.asset_type, $dealRow.risk_profile, $(if($cap){ " cap $([math]::Round($cap*100,1))%" }else{ '' }))
    $done++
  } catch { Write-Output ("    !! failed: {0}" -f $_.Exception.Message); $fail++; continue }
}
Write-Output ("SUMMARY: {0} created, {1} duplicates skipped, {2} already-processed, {3} too-large, {4} failed." -f $done, $skipDup, $skipSeen, $skipBig, $fail)
