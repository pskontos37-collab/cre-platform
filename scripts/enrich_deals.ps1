# enrich_deals.ps1 - fills each active deal's PROPERTY first-look (year built,
# submarket, GLA, occupancy, in-place cap, pricing, seller, broker, a key-points
# investment thesis, and the major-tenant roster) by having Claude READ the
# deal's own mirrored Offering Memorandum. This is the property-facts complement
# to extract_underwriting.ps1 (which does the return metrics).
#
# Discipline:
#  - EXTRACT ONLY what the OM states; nulls for anything absent (never invent).
#  - NEVER CLOBBER: only NULL columns on pipeline_deals are filled (-Force overrides).
#    asset_type / risk_profile are sheet-owned and are left untouched.
#  - Tenants + occupancy + the full extraction are stored on an om_intake row
#    (extracted jsonb) so the app + meeting deck can render tenancy.
#
#   DEFAULT = DRY RUN (lists the OM it would read per deal). -Apply to write.
param(
  [switch]$Apply,
  [switch]$Force,
  [string]$DealFilter,
  [string]$Model = 'claude-sonnet-5'
)
$ErrorActionPreference = "Stop"
$repo = "C:\Users\pskontos\Desktop\Software\cre-platform"
$cfg = @{}; foreach ($ln in (Get-Content "$repo\.env" | Where-Object { $_ -match "=" })) { $a,$b = $ln -split '=',2; $cfg[$a.Trim()]=$b.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $AK = $cfg['SUPABASE_SECRET_KEY']; $ANTH = $cfg['ANTHROPIC_API_KEY']
$enc = New-Object System.Text.UTF8Encoding($false)
$TMP = "$env:TEMP\_enrich_post.json"
$MAXPDF = 32MB   # Claude native-PDF URL practical ceiling

function Sign([string]$spath){
  [System.IO.File]::WriteAllText($TMP,'{"expiresIn":3600}',$enc)
  $r = & curl.exe -s -X POST "$BASE/storage/v1/object/sign/documents/$spath" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" --data-binary "@$TMP" | ConvertFrom-Json
  if(-not $r.signedURL){ throw "sign failed for $spath" }
  return "$BASE/storage/v1$($r.signedURL)"
}

$SCHEMA = '{"found":bool,"year_built":num|null,"submarket":"CBD"|"Suburban"|"Urban"|null,"gla_sf":num|null,"occupancy":num|null,"in_place_cap":num|null,"asking_price":num|null,"asking_guidance_text":str|null,"seller":str|null,"broker":str|null,"major_tenants":[{"name":str,"sf":num|null,"expiration":str|null}],"key_points":[str],"confidence":"high"|"medium"|"low"|null,"source_page":int|null,"note":str|null}'

function Extract-OM($doc, $dealName){
  $content = @(
    @{ type='document'; source=@{ type='url'; url=(Sign $doc.storage_path) } },
    @{ type='text'; text=@"
You are an acquisitions analyst at M&J Wilkow (a GP that buys retail and office assets and raises institutional LP capital). The attached PDF is the Offering Memorandum for the deal: $dealName. Extract a first-look for the deal pipeline.

Rules:
- GROUNDING: extract only what the OM states. If a value is not present, use null; never invent a number. When pricing is a range / PSF / "call for offers", put it in asking_guidance_text and leave asking_price null.
- occupancy / in_place_cap as decimals (92% -> 0.92; 6.5% -> 0.065). year_built as a 4-digit number (if a range, the original build year). gla_sf as plain number.
- submarket: classify CBD / Suburban / Urban if determinable, else null.
- seller: the current owner / disposition party if named. broker: the listing brokerage / advisory team if named.
- major_tenants: up to 12 largest tenants with SF and lease expiration if stated.
- key_points: 4-6 crisp, decision-useful highlights for a weekly acquisitions meeting (anchor & credit tenancy, WALT / rollover, basis vs. replacement cost, submarket dynamics, the value-add angle, debt assumability).
- Call the report_om tool with an object matching exactly (all keys present):
$SCHEMA
"@ }
  )
  $body = @{ model=$Model; max_tokens=1500
    tools=@(@{ name='report_om'; description='Report the extracted OM first-look.'; input_schema=@{ type='object'; additionalProperties=$true } })
    tool_choice=@{ type='tool'; name='report_om' }
    messages=@(@{ role='user'; content=$content }) } | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText($TMP,$body,$enc)
  $resp = & curl.exe -s "https://api.anthropic.com/v1/messages" -H "x-api-key: $ANTH" -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json" --data-binary "@$TMP" | ConvertFrom-Json
  if($resp.error){ throw ("anthropic: " + $resp.error.message) }
  $tu = $resp.content | Where-Object { $_.type -eq 'tool_use' } | Select-Object -First 1
  if(-not $tu){ throw "no tool_use in response" }
  return $tu.input
}

# active deals + the columns we may fill
$sel = 'id,name,stage,year_built,submarket,gla_sf,going_in_cap,ask_price,price_text,seller,broker,thesis'
$stageFilter = 'stage=in.(sourced,screening,underwriting,loi,under_contract,dd,ic_approval,closing)'
$deals = & curl.exe -s "$BASE/rest/v1/pipeline_deals?select=$sel&$stageFilter&limit=200" -H "apikey: $AK" -H "Authorization: Bearer $AK" | ConvertFrom-Json
if($DealFilter){ $deals = @($deals | Where-Object { $_.name -like "*$DealFilter*" }) }
Write-Output ("Active deals: {0}   mode: {1}" -f $deals.Count, $(if($Apply){'APPLY'}else{'DRY RUN'}))

$filled=0; $tenantsWritten=0; $noOm=0; $skipTooBig=0; $failed=0
foreach($d in $deals){
  $links = & curl.exe -s "$BASE/rest/v1/pipeline_deal_documents?deal_id=eq.$($d.id)&role=eq.om&select=documents(title,file_name,storage_path,file_size_bytes)" -H "apikey: $AK" -H "Authorization: Bearer $AK" | ConvertFrom-Json
  $oms = @($links | Where-Object { $_.documents.file_name -match '\.pdf$' -and $_.documents.storage_path })
  if($oms.Count -eq 0){ Write-Output ("  {0}: no OM in storage" -f $d.name); $noOm++; continue }
  # prefer the largest OM within the size cap (the main book, not a teaser)
  $ok = @($oms | Where-Object { [long]$_.documents.file_size_bytes -le $MAXPDF } | Sort-Object { [long]$_.documents.file_size_bytes } -Descending)
  if($ok.Count -eq 0){ Write-Output ("  {0}: OM exceeds {1}MB native cap - skipped" -f $d.name, [int]($MAXPDF/1MB)); $skipTooBig++; continue }
  $om = $ok[0].documents
  Write-Output ("  {0}: reading OM '{1}' ({2:N1}MB)" -f $d.name, $om.title, ([long]$om.file_size_bytes/1MB))
  if(-not $Apply){ continue }

  try { $r = Extract-OM $om $d.name } catch { Write-Output ("    !! extraction failed: {0}" -f $_.Exception.Message); $failed++; continue }
  if(-not $r -or -not $r.found){ Write-Output "    -> OM yielded no first-look"; continue }

  # ---- fill NULL scalar columns on pipeline_deals ----
  $patch = @{}
  $set = @{
    year_built   = $r.year_built
    submarket    = $r.submarket
    gla_sf       = $r.gla_sf
    going_in_cap = $r.in_place_cap
    ask_price    = $r.asking_price
    seller       = $r.seller
    broker       = $r.broker
  }
  foreach($k in $set.Keys){
    $v = $set[$k]
    if($null -eq $v){ continue }
    if($Force -or $null -eq $d.$k){ $patch[$k] = $v }
  }
  # price_text only when there is no numeric ask
  if($r.asking_guidance_text -and ($Force -or (-not $d.price_text -and -not $d.ask_price -and -not $patch.ContainsKey('ask_price')))){
    $patch['price_text'] = $r.asking_guidance_text
  }
  # thesis from key points (bulleted, LF-joined -> the deck/UI split on newlines)
  if(@($r.key_points).Count -gt 0 -and ($Force -or -not $d.thesis)){
    $patch['thesis'] = (@($r.key_points | ForEach-Object { '- ' + $_ }) -join "`n")
  }

  if($patch.Count -gt 0){
    $patch['updated_at'] = (Get-Date).ToUniversalTime().ToString('o')
    [System.IO.File]::WriteAllText($TMP, ($patch | ConvertTo-Json), $enc)
    $pc = & curl.exe -s -o NUL -w "%{http_code}" -X PATCH "$BASE/rest/v1/pipeline_deals?id=eq.$($d.id)" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" -H "Prefer: return=minimal" --data-binary "@$TMP"
    if([int]$pc -ge 200 -and [int]$pc -lt 300){ $filled++ } else { Write-Output "    !! PATCH pipeline_deals HTTP $pc" }
  }

  # ---- store tenants + occupancy + full extraction on an om_intake row ----
  $exObj = @{
    year_built=$r.year_built; submarket=$r.submarket; gla_sf=$r.gla_sf; occupancy=$r.occupancy;
    in_place_cap=$r.in_place_cap; asking_price=$r.asking_price; asking_guidance_text=$r.asking_guidance_text;
    seller=$r.seller; broker=$r.broker; major_tenants=$r.major_tenants; key_points=$r.key_points;
    source='OM enrich'; source_page=$r.source_page; confidence=$r.confidence
  }
  $existing = & curl.exe -s "$BASE/rest/v1/om_intake?deal_id=eq.$($d.id)&select=id&limit=1" -H "apikey: $AK" -H "Authorization: Bearer $AK" | ConvertFrom-Json
  if(@($existing).Count -gt 0){
    [System.IO.File]::WriteAllText($TMP, (@{ extracted=$exObj; updated_at=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Depth 10), $enc)
    & curl.exe -s -o NUL -X PATCH "$BASE/rest/v1/om_intake?id=eq.$($existing[0].id)" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" -H "Prefer: return=minimal" --data-binary "@$TMP" | Out-Null
  } else {
    [System.IO.File]::WriteAllText($TMP, (@{ deal_id=$d.id; deal_name=$d.name; om_received=$true; base_model='none'; extracted=$exObj } | ConvertTo-Json -Depth 10), $enc)
    & curl.exe -s -o NUL -X POST "$BASE/rest/v1/om_intake" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" -H "Prefer: return=minimal" --data-binary "@$TMP" | Out-Null
  }
  if(@($r.major_tenants).Count -gt 0){ $tenantsWritten++ }

  $tn = @($r.major_tenants).Count
  Write-Output ("    -> FILLED [{0}] {1}; {2} tenants; conf {3}" -f (($patch.Keys | Where-Object { $_ -ne 'updated_at' } | Sort-Object) -join ','), $(if($patch.Count -gt 1){''}else{'(nothing new)'}), $tn, $r.confidence)
}
Write-Output ("SUMMARY: {0} deals filled, {1} with tenant rosters, {2} no OM, {3} OM too big, {4} failed." -f $filled, $tenantsWritten, $noOm, $skipTooBig, $failed)
