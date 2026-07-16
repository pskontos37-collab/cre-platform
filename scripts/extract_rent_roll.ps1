# extract_rent_roll.ps1 - auto-populates a deal's TENANT-LEVEL underwriting model
# from its mirrored rent-roll PDF. Claude reads the rent roll and returns per-tenant
# lease lines (SF, base rent $/SF, escalation, term remaining, recovery type); this
# writes them into pipeline_deals.underwriting_model (mode='tenant') so the
# Underwriting tab opens pre-filled. Returns are computed IN-APP on open/save.
#
#   Fills only deals WITHOUT a tenant model yet (-Force to overwrite).
#   DEFAULT = DRY RUN (lists the rent roll it would read). -Apply to write.
param([switch]$Apply, [switch]$Force, [string]$DealFilter, [string]$Model = 'claude-sonnet-5')
$ErrorActionPreference = "Stop"
$repo = "C:\Users\pskontos\Desktop\Software\cre-platform"
$cfg = @{}; foreach ($ln in (Get-Content "$repo\.env" | Where-Object { $_ -match "=" })) { $a,$b = $ln -split '=',2; $cfg[$a.Trim()]=$b.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $AK = $cfg['SUPABASE_SECRET_KEY']; $ANTH = $cfg['ANTHROPIC_API_KEY']
$enc = New-Object System.Text.UTF8Encoding($false); $TMP = "$env:TEMP\_rr_post.json"
$today = (Get-Date).ToString('yyyy-MM-dd')

function Sign([string]$spath){
  [System.IO.File]::WriteAllText($TMP,'{"expiresIn":3600}',$enc)
  $r = & curl.exe -s -X POST "$BASE/storage/v1/object/sign/documents/$spath" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" --data-binary "@$TMP" | ConvertFrom-Json
  if(-not $r.signedURL){ throw "sign failed for $spath" }
  return "$BASE/storage/v1$($r.signedURL)"
}

$SCHEMA = '{"gla_sf":num|null,"recoverable_opex_psf":num|null,"non_recoverable_opex_psf":num|null,"market_rent_psf":num|null,"leases":[{"name":str,"sf":num,"base_rent_psf":num,"annual_bump_pct":num|null,"term_remaining_years":num|null,"recovery":"nnn"|"gross"|"base_year"|null}]}'

function Extract-RentRoll($doc, $dealName){
  $content = @(
    @{ type='document'; source=@{ type='url'; url=(Sign $doc.storage_path) } },
    @{ type='text'; text=@"
You are an acquisitions analyst at M&J Wilkow. The attached PDF is the RENT ROLL for the deal: $dealName. Extract a tenant-level lease schedule for underwriting. Today is $today.

Rules:
- One row per tenant/suite. name = tenant name; sf = leased square feet.
- base_rent_psf = CURRENT annual base rent per SF (if the rent roll shows monthly rent or annual $ total, convert to annual $/SF using SF). Exclude recoveries/CAM from base rent.
- annual_bump_pct = contractual annual escalation as a decimal (3% -> 0.03); if fixed steps, approximate the average annual rate; null if flat/unknown.
- term_remaining_years = years from TODAY ($today) to lease expiration (decimal ok); month-to-month -> 0.5; null if unknown.
- recovery: 'nnn' if tenant reimburses CAM/tax/insurance (triple net), 'gross' if full-service/gross, 'base_year' if base-year stop. Retail is usually nnn.
- gla_sf = total building GLA if stated. recoverable_opex_psf / non_recoverable_opex_psf = annual $/SF if the rent roll or notes state operating expenses (else null). market_rent_psf = stated market/asking rent if shown.
- EXTRACT ONLY what the rent roll shows; use null for anything absent. Do NOT invent rents.
- Call report_rent_roll with an object matching exactly (all keys present):
$SCHEMA
"@ }
  )
  $body = @{ model=$Model; max_tokens=4000
    tools=@(@{ name='report_rent_roll'; description='Report the extracted rent roll.'; input_schema=@{ type='object'; additionalProperties=$true } })
    tool_choice=@{ type='tool'; name='report_rent_roll' }
    messages=@(@{ role='user'; content=$content }) } | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText($TMP,$body,$enc)
  $resp = & curl.exe -s "https://api.anthropic.com/v1/messages" -H "x-api-key: $ANTH" -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json" --data-binary "@$TMP" | ConvertFrom-Json
  if($resp.error){ throw ("anthropic: " + $resp.error.message) }
  $tu = $resp.content | Where-Object { $_.type -eq 'tool_use' } | Select-Object -First 1
  if(-not $tu){ throw "no tool_use in response" }
  return $tu.input
}

function Norm-Recovery($r){ if($r -match 'nnn|triple|net'){'nnn'}elseif($r -match 'base'){'base_year'}elseif($r -match 'gross|full'){'gross'}else{'nnn'} }

# active deals + their current model + sheet fields for financing seed
$sel = 'id,name,ask_price,going_in_cap,gla_sf,underwriting_model'
$stageFilter = 'stage=in.(sourced,screening,underwriting,loi,under_contract,dd,ic_approval,closing)'
$deals = & curl.exe -s "$BASE/rest/v1/pipeline_deals?select=$sel&$stageFilter&limit=200" -H "apikey: $AK" -H "Authorization: Bearer $AK" | ConvertFrom-Json
if($DealFilter){ $deals = @($deals | Where-Object { $_.name -like "*$DealFilter*" }) }
Write-Output ("Active deals: {0}   mode: {1}" -f $deals.Count, $(if($Apply){'APPLY'}else{'DRY RUN'}))

$done=0; $skip=0; $noRr=0; $fail=0
foreach($d in $deals){
  if(-not $Force -and $d.underwriting_model -and $d.underwriting_model.mode -eq 'tenant'){ Write-Output ("  {0}: already has a tenant model" -f $d.name); $skip++; continue }
  $links = & curl.exe -s "$BASE/rest/v1/pipeline_deal_documents?deal_id=eq.$($d.id)&role=eq.rent_roll&select=documents(title,file_name,storage_path,file_size_bytes)" -H "apikey: $AK" -H "Authorization: Bearer $AK" | ConvertFrom-Json
  $rr = @($links | Where-Object { $_.documents.file_name -match '\.pdf$' -and $_.documents.storage_path } | Sort-Object { [long]$_.documents.file_size_bytes } -Descending | Select-Object -First 1)
  if($rr.Count -eq 0){ Write-Output ("  {0}: no rent-roll PDF in storage" -f $d.name); $noRr++; continue }
  $doc = $rr[0].documents
  Write-Output ("  {0}: reading rent roll '{1}'" -f $d.name, $doc.title)
  if(-not $Apply){ continue }

  try { $r = Extract-RentRoll $doc $d.name } catch { Write-Output ("    !! extraction failed: {0}" -f $_.Exception.Message); $fail++; continue }
  $leases = @()
  foreach($t in @($r.leases)){
    if(-not $t.name -or $null -eq $t.sf){ continue }
    $leases += @{ name=[string]$t.name; sf=[double]$t.sf; baseRentPsf=[double]($t.base_rent_psf); annualBumpPct=[double]($(if($null -ne $t.annual_bump_pct){$t.annual_bump_pct}else{0.03})); termRemainingYears=[double]($(if($null -ne $t.term_remaining_years){$t.term_remaining_years}else{5})); recovery=(Norm-Recovery ([string]$t.recovery)) }
  }
  if($leases.Count -eq 0){ Write-Output "    -> no lease lines extracted"; continue }

  $gla = $(if($null -ne $r.gla_sf -and [double]$r.gla_sf -gt 0){[double]$r.gla_sf}elseif($null -ne $d.gla_sf){[double]$d.gla_sf}else{ ($leases | Measure-Object -Property sf -Sum).Sum })
  $avgInPlace = if($leases.Count){ (($leases | ForEach-Object { $_.baseRentPsf }) | Measure-Object -Average).Average }else{0}
  $mkt = $(if($null -ne $r.market_rent_psf -and [double]$r.market_rent_psf -gt 0){[double]$r.market_rent_psf}else{[math]::Round($avgInPlace,2)})
  $recOpex = $(if($null -ne $r.recoverable_opex_psf){[double]$r.recoverable_opex_psf}else{0})
  $nonRec = $(if($null -ne $r.non_recoverable_opex_psf){[double]$r.non_recoverable_opex_psf}else{0})

  $model = @{
    purchasePrice=[double]($(if($d.ask_price){$d.ask_price}else{0})); acqCostsPct=0.02; capexUpfront=0; inPlaceNoi=0; noiGrowthPct=0.03;
    holdYears=5; exitCapPct=[double]($(if($d.going_in_cap){$d.going_in_cap}else{0.065})); sellingCostsPct=0.02;
    ltvPct=0.6; loanRatePct=0.065; amortYears=30; mode='tenant'; glaSf=[double]$gla; leases=$leases;
    rollover=@{ renewalProbPct=0.7; marketRentPsf=$mkt; marketRentGrowthPct=0.03; downtimeMonths=6; tiNewPsf=30; tiRenewPsf=10; lcNewPsf=15; lcRenewPsf=5; freeRentMonthsNew=3 };
    opex=@{ recoverableOpexPsf=$recOpex; nonRecoverableOpexPsf=$nonRec; opexGrowthPct=0.03; generalVacancyPct=0; creditLossPct=0.005; capitalReservePsf=0.25; otherIncomePsf=0 }
  }
  $patch = @{ underwriting_model=$model; updated_at=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText($TMP,$patch,$enc)
  $pc = & curl.exe -s -o NUL -w "%{http_code}" -X PATCH "$BASE/rest/v1/pipeline_deals?id=eq.$($d.id)" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" -H "Prefer: return=minimal" --data-binary "@$TMP"
  if([int]$pc -ge 200 -and [int]$pc -lt 300){ Write-Output ("    -> POPULATED {0} tenants (GLA {1:N0}, mkt ${2}/sf)" -f $leases.Count, $gla, $mkt); $done++ }
  else { Write-Output "    !! PATCH failed HTTP $pc"; $fail++ }
}
Write-Output ("SUMMARY: {0} populated, {1} already had a model, {2} no rent roll, {3} failed." -f $done, $skip, $noRr, $fail)
