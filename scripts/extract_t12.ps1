# extract_t12.ps1 - auto-derives RECOVERABLE vs NON-RECOVERABLE operating expenses
# from a deal's mirrored T-12 / operating statement and merges them into the
# TENANT-LEVEL underwriting model's opex block. This is what makes NNN cost
# recoveries flow in the Underwriting tab (recovery & income realism, track 3):
# without a recoverable-OpEx figure, the bottoms-up model shows base rent only and
# understates NOI vs the OM (e.g. Pearson model -56% vs OM guidance).
#
#   Only touches deals that ALREADY have a tenant model (opex belongs there).
#   Fills only when recoverable OpEx is still 0/blank (-Force to overwrite).
#   DEFAULT = DRY RUN (lists the statement it would read). -Apply to write.
#
# Conventions (see reference_supabase_loaders / CLAUDE.md):
#  - ASCII only; straight quotes. NEVER name a local $model (collides with the
#    [string]$Model param and gets coerced to a string). Write-Host inside
#    functions (Write-Output there concatenates into the return value).
param([switch]$Apply, [switch]$Force, [string]$DealFilter, [string]$Model = 'claude-sonnet-5')
$ErrorActionPreference = "Stop"
$repo = "C:\Users\pskontos\Desktop\Software\cre-platform"
$cfg = @{}; foreach ($ln in (Get-Content "$repo\.env" | Where-Object { $_ -match "=" })) { $a,$b = $ln -split '=',2; $cfg[$a.Trim()]=$b.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $AK = $cfg['SUPABASE_SECRET_KEY']; $ANTH = $cfg['ANTHROPIC_API_KEY']
$enc = New-Object System.Text.UTF8Encoding($false); $TMP = "$env:TEMP\_t12_post.json"
$today = (Get-Date).ToString('yyyy-MM-dd')
$REC_CEIL = 60.0    # recoverable OpEx (CAM+tax+ins) never exceeds ~$60/SF/yr; above = a mis-parsed total
$NON_CEIL = 30.0    # non-recoverable (mgmt+G&A) ceiling

function Sign([string]$spath){
  [System.IO.File]::WriteAllText($TMP,'{"expiresIn":3600}',$enc)
  $r = & curl.exe -s -X POST "$BASE/storage/v1/object/sign/documents/$spath" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" --data-binary "@$TMP" | ConvertFrom-Json
  if(-not $r.signedURL){ throw "sign failed for $spath" }
  return "$BASE/storage/v1$($r.signedURL)"
}

$SCHEMA = '{"gla_sf":num|null,"recoverable_opex_psf":num|null,"non_recoverable_opex_psf":num|null,"recoverable_opex_total":num|null,"non_recoverable_opex_total":num|null,"total_opex":num|null,"effective_gross_income":num|null,"period":str|null,"confidence":"high"|"medium"|"low"|null,"note":str|null}'

function Extract-T12($doc, $dealName){
  $content = @(
    @{ type='document'; source=@{ type='url'; url=(Sign $doc.storage_path) } },
    @{ type='text'; text=@"
You are an acquisitions analyst at M&J Wilkow. The attached PDF is the T-12 / trailing operating statement for the deal: $dealName. Extract the annual operating expenses split into RECOVERABLE vs NON-RECOVERABLE for a bottoms-up underwrite. Today is $today.

Definitions:
- RECOVERABLE (reimbursable under NNN leases): common area maintenance (CAM), repairs & maintenance, common-area utilities, landscaping, snow, security, parking-lot, management fee IF the leases reimburse it, real estate TAXES, and property INSURANCE. These are the expenses a triple-net tenant pays back.
- NON-RECOVERABLE (landlord's own cost): asset/portfolio management fee not billed to tenants, general & administrative, professional/legal/audit fees, non-reimbursable owner costs, leasing costs. Do NOT include capital expenditures, tenant improvements, leasing commissions, or debt service in either bucket (those are below-NOI or capital).

Rules:
- Report ANNUAL figures for the trailing-12 period. recoverable_opex_total and non_recoverable_opex_total are dollar totals; recoverable_opex_psf and non_recoverable_opex_psf are those totals divided by building GLA ($/SF/yr). If you cannot compute PSF (GLA unknown), give the totals and leave PSF null.
- gla_sf = building square footage if the statement states it (else null). total_opex = all operating expenses (recoverable + non-recoverable, excluding capital). effective_gross_income = total revenue net of vacancy if shown.
- period = the trailing period label (e.g. 'T-12 ending 03/2026') if shown.
- EXTRACT ONLY what the statement shows; use null for anything absent. Do NOT invent. confidence reflects how cleanly the statement separates recoverable from non-recoverable (many statements do not label it - infer from line items and lower confidence).
- note = one short line on how you classified (e.g. 'CAM+tax+ins recoverable; mgmt fee 4% non-recoverable').
- Call report_t12 with an object matching exactly (all keys present):
$SCHEMA
"@ }
  )
  $body = @{ model=$Model; max_tokens=1500
    tools=@(@{ name='report_t12'; description='Report the extracted operating expenses.'; input_schema=@{ type='object'; additionalProperties=$true } })
    tool_choice=@{ type='tool'; name='report_t12' }
    messages=@(@{ role='user'; content=$content }) } | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText($TMP,$body,$enc)
  $resp = & curl.exe -s "https://api.anthropic.com/v1/messages" -H "x-api-key: $ANTH" -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json" --data-binary "@$TMP" | ConvertFrom-Json
  if($resp.error){ $em = if($resp.error.message -is [string]){ $resp.error.message } else { ($resp.error | ConvertTo-Json -Compress -Depth 6) }; throw ("anthropic: " + $em) }
  $tu = $resp.content | Where-Object { $_.type -eq 'tool_use' } | Select-Object -First 1
  if(-not $tu){ throw "no tool_use in response" }
  return $tu.input
}

# Resolve a $/SF figure: prefer the stated PSF when plausible, else total / GLA,
# else fall back to total / GLA if a PSF looks like a mis-parsed dollar total.
function Resolve-Psf($psf, $total, $gla, $ceil){
  $p = $(if($null -ne $psf){[double]$psf}else{0.0})
  $t = $(if($null -ne $total){[double]$total}else{0.0})
  if(($p -le 0 -or $p -gt $ceil) -and $t -gt 0 -and $gla -gt 0){ $p = $t / $gla }  # derive/repair from total
  if($p -lt 0){ $p = 0.0 }
  if($p -gt $ceil){ $p = 0.0 }   # still implausible -> leave for the analyst
  return [math]::Round($p, 2)
}

# tenant-model deals + GLA + current model
$sel = 'id,name,gla_sf,underwriting_model'
$stageFilter = 'stage=in.(sourced,screening,underwriting,loi,under_contract,dd,ic_approval,closing)'
$deals = & curl.exe -s "$BASE/rest/v1/pipeline_deals?select=$sel&$stageFilter&limit=200" -H "apikey: $AK" -H "Authorization: Bearer $AK" | ConvertFrom-Json
if($DealFilter){ $deals = @($deals | Where-Object { $_.name -like "*$DealFilter*" }) }
Write-Output ("Tenant-model deals scanned: {0}   mode: {1}" -f $deals.Count, $(if($Apply){'APPLY'}else{'DRY RUN'}))

$done=0; $skip=0; $noStmt=0; $fail=0; $noModel=0
foreach($d in $deals){
  $uwm = $d.underwriting_model
  if(-not $uwm -or $uwm.mode -ne 'tenant'){ Write-Output ("  {0}: no tenant model (run extract_rent_roll first)" -f $d.name); $noModel++; continue }
  $curRec = $(if($uwm.opex -and $null -ne $uwm.opex.recoverableOpexPsf){[double]$uwm.opex.recoverableOpexPsf}else{0})
  if(-not $Force -and $curRec -gt 0){ Write-Output ("  {0}: recoverable OpEx already set (${1}/sf)" -f $d.name, $curRec); $skip++; continue }

  # prefer a T-12/operating statement; fall back to a financials doc that looks like one
  $os = & curl.exe -s "$BASE/rest/v1/pipeline_deal_documents?deal_id=eq.$($d.id)&role=eq.operating_statement&select=documents(title,file_name,storage_path,file_size_bytes)" -H "apikey: $AK" -H "Authorization: Bearer $AK" | ConvertFrom-Json
  $cand = @($os | Where-Object { $_.documents.file_name -match '\.pdf$' -and $_.documents.storage_path })
  if($cand.Count -eq 0){
    $fin = & curl.exe -s "$BASE/rest/v1/pipeline_deal_documents?deal_id=eq.$($d.id)&role=eq.financials&select=documents(title,file_name,storage_path,file_size_bytes)" -H "apikey: $AK" -H "Authorization: Bearer $AK" | ConvertFrom-Json
    $cand = @($fin | Where-Object { $_.documents.file_name -match '\.pdf$' -and $_.documents.storage_path -and ($_.documents.title + ' ' + $_.documents.file_name) -match '(?i)t-?12|trailing|operating\s*stmt|operating\s*statement|income\s*statement|profit.*loss|p&l|cash\s*flow' })
  }
  $pick = @($cand | Sort-Object { [long]$_.documents.file_size_bytes } -Descending | Select-Object -First 1)
  if($pick.Count -eq 0){ Write-Output ("  {0}: no operating statement in storage" -f $d.name); $noStmt++; continue }
  $doc = $pick[0].documents
  Write-Output ("  {0}: reading statement '{1}'" -f $d.name, $doc.title)
  if(-not $Apply){ continue }

  try { $r = Extract-T12 $doc $d.name } catch { Write-Output ("    !! extraction failed: {0}" -f $_.Exception.Message); $fail++; continue }

  $gla = $(if($null -ne $r.gla_sf -and [double]$r.gla_sf -gt 0){[double]$r.gla_sf}elseif($uwm.glaSf -and [double]$uwm.glaSf -gt 0){[double]$uwm.glaSf}elseif($d.gla_sf){[double]$d.gla_sf}else{0})
  if($gla -le 0){ Write-Output "    -> no GLA known; cannot derive PSF"; $fail++; continue }
  $recPsf = Resolve-Psf $r.recoverable_opex_psf $r.recoverable_opex_total $gla $REC_CEIL
  $nonPsf = Resolve-Psf $r.non_recoverable_opex_psf $r.non_recoverable_opex_total $gla $NON_CEIL
  # if only a single total_opex is given, treat ~85% recoverable / 15% non as a coarse split
  if($recPsf -le 0 -and $null -ne $r.total_opex -and [double]$r.total_opex -gt 0){
    $tot = [double]$r.total_opex / $gla
    if($tot -le $REC_CEIL){ $recPsf = [math]::Round($tot * 0.85, 2); if($nonPsf -le 0){ $nonPsf = [math]::Round($tot * 0.15, 2) } }
  }
  if($recPsf -le 0){ Write-Output ("    -> could not derive a recoverable OpEx figure (confidence {0})" -f $r.confidence); $fail++; continue }

  if($null -eq $uwm.opex){ $uwm | Add-Member -NotePropertyName opex -NotePropertyValue ([pscustomobject]@{ opexGrowthPct=0.03; generalVacancyPct=0; creditLossPct=0.005; capitalReservePsf=0.25; otherIncomePsf=0 }) -Force }
  $uwm.opex | Add-Member -NotePropertyName recoverableOpexPsf -NotePropertyValue $recPsf -Force
  if($nonPsf -gt 0){ $uwm.opex | Add-Member -NotePropertyName nonRecoverableOpexPsf -NotePropertyValue $nonPsf -Force }

  $patch = @{ underwriting_model=$uwm; updated_at=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($TMP,$patch,$enc)
  $pc = & curl.exe -s -o NUL -w "%{http_code}" -X PATCH "$BASE/rest/v1/pipeline_deals?id=eq.$($d.id)" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" -H "Prefer: return=minimal" --data-binary "@$TMP"
  if([int]$pc -lt 200 -or [int]$pc -ge 300){ Write-Output "    !! PATCH failed HTTP $pc"; $fail++; continue }
  $impliedRec = [math]::Round($recPsf * $gla, 0)
  Write-Output ("    -> SET recoverable {0}/sf, non-recov {1}/sf (GLA {2:N0}; ~{3:N0} full-NNN recoveries) [{4}]" -f $recPsf, $nonPsf, $gla, $impliedRec, $r.confidence)
  $done++

  # audit comment (skip if an [AI] T-12 comment already exists for this deal)
  $prior = & curl.exe -s "$BASE/rest/v1/pipeline_deal_comments?deal_id=eq.$($d.id)&body=like.%5BAI%5D%20Recoverable*&select=id&limit=1" -H "apikey: $AK" -H "Authorization: Bearer $AK" | ConvertFrom-Json
  if(-not $prior -or $prior.Count -eq 0){
    $note = $(if($r.note){ ' ' + $r.note } else { '' })
    $bodyTxt = "[AI] Recoverable OpEx derived from T-12 '$($doc.title)'$(if($r.period){' ('+$r.period+')'}): recoverable `$$recPsf/sf, non-recoverable `$$nonPsf/sf (GLA $([math]::Round($gla)) SF; confidence $($r.confidence)).$note NNN recoveries now flow in the Underwriting tab - review before relying."
    $cj = @{ deal_id=$d.id; body=$bodyTxt; author_id=$null } | ConvertTo-Json
    [System.IO.File]::WriteAllText($TMP,$cj,$enc)
    & curl.exe -s -o NUL -X POST "$BASE/rest/v1/pipeline_deal_comments" -H "apikey: $AK" -H "Authorization: Bearer $AK" -H "Content-Type: application/json" -H "Prefer: return=minimal" --data-binary "@$TMP" | Out-Null
  }
}
Write-Output ("SUMMARY: {0} set, {1} already set, {2} no statement, {3} no tenant model, {4} failed." -f $done, $skip, $noStmt, $noModel, $fail)
