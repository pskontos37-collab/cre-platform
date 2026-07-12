# extract_service_agreement_files.ps1 - reads the LATEST service-agreement PDF per
# property x recurring service straight from the V: OPERATIONS folders (native-PDF
# Claude extraction) and appends results to scripts\svc_files_extract.jsonl.
# These are the authoritative current contracts (user-designated 2026-07-05);
# extract_service_agreements.ps1 -Load merges this JSONL with the corpus-derived
# one (file rows win on the same file). Resumable: paths already in the JSONL skip.
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$AK = $cfg['ANTHROPIC_API_KEY']
$OUT = "$PSScriptRoot\svc_files_extract.jsonl"
$TODAY = '2026-07-05'
$utf8 = New-Object System.Text.UTF8Encoding($false)

$GW  = 'V:\Gateway (Formerly Port Chester) 2-8-19\OPERATIONS\Service Agreements'
$KME = 'V:\Knightdale Marketplace 7-15-19\KM-East (fka Shoppes at Midway)\OPERATIONS\Service Agreements'
$KMW = 'V:\Knightdale Marketplace 7-15-19\KM-West (fka Midtown Commons)\OPERATIONS\Service Agreements'
$MAG = 'V:\Magnolia Park 11-20-14\OPERATIONS\Service Agreements'
$PID_GW  = 'd5a4ed03-0b60-4168-9208-83822dd24884'
$PID_KME = '00000000-0000-0000-0000-000000000010'
$PID_KMW = '00000000-0000-0000-0000-000000000011'
$PID_MAG = 'd4f08824-2d88-472d-b7aa-a703310c2aaf'

# Latest agreement per property x recurring service (picked from folder inventory 2026-07-05)
$FILES = @(
  @{ p = $PID_GW;  hint = 'elevator';           f = "$GW\Elevator\AGR-Champion Elevator-Hydraulic Maintenance (1-24-23).pdf" }
  @{ p = $PID_GW;  hint = 'trash/waste';        f = "$GW\Garbage-Recycling\2024\AGR-Suburban Carting-Trash Removal (7-30-24).pdf" }
  @{ p = $PID_GW;  hint = 'hvac';               f = "$GW\HVAC\2021\AGR-Tempaire (11-18-21).pdf" }
  @{ p = $PID_GW;  hint = 'janitorial';         f = "$GW\Janitorial\AGR-Kencal Maintenance Corp-1 year (4-28-26).pdf" }
  @{ p = $PID_GW;  hint = 'landscaping';        f = "$GW\Landscaping\AGR-Imperial Gardening-Landscaping Srvcs (4-8-26).pdf" }
  @{ p = $PID_GW;  hint = 'landscaping';        f = "$GW\Landscaping\AGR-Imperial Gardening-Seasonal Plantings (4-8-26).pdf" }
  @{ p = $PID_GW;  hint = 'pest control';       f = "$GW\Pest Control\NTC-Orkin-Agreement Termination (8-3-23).pdf" }
  @{ p = $PID_GW;  hint = 'snow removal';       f = "$GW\Snow Removal\AGR-NYCONN Supply-Snow Removal (10-30-25).pdf" }
  @{ p = $PID_GW;  hint = 'sweeping/portering'; f = "$GW\Sweeping-Cleaning (Parking Lot)\AGR-NYCONN Supply Corp-Parking Lot Sweeping Srvcs. (2-12-25).pdf" }
  @{ p = $PID_GW;  hint = 'other';              f = "$GW\Towing\AGR-Fairway Towing and Recovery (11-10-22).pdf" }
  @{ p = $PID_GW;  hint = 'fire/life safety';   f = "$GW\Fire & Safety\AGR-NRL Fire Protection Services-Fire Hydrant Flow Testing (4-5-24).pdf" }

  @{ p = $PID_KME; hint = 'canopy/awning';      f = "$KME\Canopy\AGR-Carolina Canopy Company-Canopy Cleaning (3-19-25).pdf" }
  @{ p = $PID_KME; hint = 'trash/waste';        f = "$KME\Garbage-Recycling\AGR-Corp Srvcs Consultants (4-1-25).pdf" }
  @{ p = $PID_KME; hint = 'other';              f = "$KME\Holiday Decor\AGR-Four Seasons Landscaping (11-4-21).pdf" }
  @{ p = $PID_KME; hint = 'hvac';               f = "$KME\HVAC\AGR-Dual Comfort Heating & Air Conditioning (10-28-25).pdf" }
  @{ p = $PID_KME; hint = 'janitorial';         f = "$KME\Janitorial\AGR-Four Seasons Landscaping Mgmt., Inc.-Day Portering Srvcs. (3-1-25).pdf" }
  @{ p = $PID_KME; hint = 'landscaping';        f = "$KME\Landscaping\AGR-Four Seasons Landscaping Mgmt., Inc.-Landscaping Srvcs. (3-1-25).pdf" }
  @{ p = $PID_KME; hint = 'sweeping/portering'; f = "$KME\Pressure Washing\AGR-Four Seasons Landscaping Mgmt., Inc.-Pressure Washing Srvcs. (3-1-25).pdf" }
  @{ p = $PID_KME; hint = 'roofing';            f = "$KME\Roof\AGR-Baker Roofing-Annual Roof Maintenance (1-9-26).pdf" }
  @{ p = $PID_KME; hint = 'snow removal';       f = "$KME\Snow Removal\AGR-Four Seasons Landscaping (11-4-25).pdf" }
  @{ p = $PID_KME; hint = 'sweeping/portering'; f = "$KME\Sweeping\AGR-King Enterprises of Eastern NC (6-14-24).pdf" }

  @{ p = $PID_KMW; hint = 'canopy/awning';      f = "$KMW\Canopy\AGR-Carolina Canopy Care-Canopy Cleaning (3-19-25).pdf" }
  @{ p = $PID_KMW; hint = 'trash/waste';        f = "$KMW\Garbage-Recycling\AGR-Corporate Services Consultants-Trash Removal (4-1-25).pdf" }
  @{ p = $PID_KMW; hint = 'other';              f = "$KMW\Holiday Decor\AGR-Four Seasons Landscaping (11-4-25).pdf" }
  @{ p = $PID_KMW; hint = 'janitorial';         f = "$KMW\Janitorial\AGR-Four Seasons Landscaping Mgmt., Inc.-Day Portering Srvcs. (3-1-25).pdf" }
  @{ p = $PID_KMW; hint = 'landscaping';        f = "$KMW\Landscaping\AGR-Four Seasons Landscaping Mgmt., Inc.-Landscaping Srvcs. (3-1-25).pdf" }
  @{ p = $PID_KMW; hint = 'lighting/electrical';f = "$KMW\Lighting\AGR-XtraLight Manufacturing (10-6-25).pdf" }
  @{ p = $PID_KMW; hint = 'pond/retention';     f = "$KMW\Maintenance\AGR-Allclear Pond Management-Maintenance (1-1-25).pdf" }
  @{ p = $PID_KMW; hint = 'sweeping/portering'; f = "$KMW\Pressure Washing\AGR-Four Seasons Landscaping Mgmt., Inc.-Power Washing Srvcs. (3-1-25).pdf" }
  @{ p = $PID_KMW; hint = 'roofing';            f = "$KMW\Roof Inspection-Maintenance\AGR-Baker Roofing-Annual Roof Maintenance (1-9-36).pdf" }
  @{ p = $PID_KMW; hint = 'snow removal';       f = "$KMW\Snow Removal\AGR-Four Seasons Landscaping Mgmt (11-4-25).pdf" }
  @{ p = $PID_KMW; hint = 'sweeping/portering'; f = "$KMW\Sweeping\AGR-King Enterprises of Eastern NC (6-14-24).pdf" }

  @{ p = $PID_MAG; hint = 'fire/life safety';   f = "$MAG\Fire Alarm\AGR-Excel--Annual Inspection (1-4-24).pdf" }
  @{ p = $PID_MAG; hint = 'trash/waste';        f = "$MAG\Garbage-Recycling\2024\AGR-Corporate Services Consultant-Waste Removal (11-1-24).pdf" }
  @{ p = $PID_MAG; hint = 'other';              f = "$MAG\Holiday Decorating\AGR-Ambius-Holiday Decor Installation (9-23-25).pdf" }
  @{ p = $PID_MAG; hint = 'other';              f = "$MAG\Holiday Decorating\AGR-Ambius-Storage of Holiday Decorations (7-1-25).pdf" }
  @{ p = $PID_MAG; hint = 'janitorial';         f = "$MAG\Janitorial\AGR-Greenville Maintenance Services (4-8-26).pdf" }
  @{ p = $PID_MAG; hint = 'landscaping';        f = "$MAG\Landscaping\AGR-The Greenery-Landscaping (4-8-26).pdf" }
  @{ p = $PID_MAG; hint = 'pest control';       f = "$MAG\Pest Control\AGR-Rocket Pest Control-Monthly Services (1-1-25).pdf" }
  @{ p = $PID_MAG; hint = 'sweeping/portering'; f = "$MAG\Pressure Washing\AGR-The Greenery-Pressure Washing (4-8-26).pdf" }
  @{ p = $PID_MAG; hint = 'security';           f = "$MAG\Security\AGR-Allied Universal Security Services (12-1-25).pdf" }
  @{ p = $PID_MAG; hint = 'snow removal';       f = "$MAG\Snow Removal\AGR-The Greenery (11-4-25).pdf" }
  @{ p = $PID_MAG; hint = 'pond/retention';     f = "$MAG\Stormwater\Carolina Holdings_Magnolia Park_Maint Contract_020122.pdf" }
  @{ p = $PID_MAG; hint = 'sweeping/portering'; f = "$MAG\Sweeping\AGR-Greenville Maintenance Services (4-8-26).pdf" }
)

$CATEGORIES = @('landscaping','snow removal','sweeping/portering','janitorial','trash/waste','hvac','roofing','paving/parking lot','painting','signage','lighting/electrical','fire/life safety','security','elevator','pest control','pond/retention','canopy/awning','plumbing','general maintenance','professional services','other')

$tool = @{
  name = 'submit_extraction'
  description = 'Submit the structured abstraction of a vendor service agreement.'
  input_schema = @{
    type = 'object'
    properties = @{
      is_service_agreement = @{ type = 'boolean'; description = 'true for an actual executed vendor service contract; false for notices/terminations/etc' }
      vendor = @{ type = 'string' }
      service_category = @{ type = 'string'; enum = $CATEGORIES }
      description = @{ type = 'string'; description = 'one sentence: scope of work and frequency, max 200 chars' }
      agreement_date = @{ type = @('string', 'null') }
      start_date = @{ type = @('string', 'null') }
      end_date = @{ type = @('string', 'null'); description = 'expiration yyyy-mm-dd, ONLY if stated or exactly derivable' }
      term_summary = @{ type = @('string', 'null') }
      auto_renews = @{ type = @('boolean', 'null') }
      cancel_notice_days = @{ type = @('integer', 'null') }
      annual_value = @{ type = @('number', 'null') }
      pricing_summary = @{ type = @('string', 'null') }
      notes = @{ type = @('string', 'null'); description = 'anything a manager should know: renewal mechanics, termination-for-convenience, scope caveats, or (for a termination notice) what was terminated and when' }
    }
    required = @('is_service_agreement')
  }
}

$done = @{}
if (Test-Path -LiteralPath $OUT) {
  foreach ($line in [IO.File]::ReadAllLines($OUT, $utf8)) {
    if ($line) { $done[(($line | ConvertFrom-Json).file_path)] = $true }
  }
}

$n = 0; $ok = 0; $fail = 0
foreach ($item in $FILES) {
  $n++
  $path = $item.f
  if ($done.ContainsKey($path)) { continue }
  if (-not (Test-Path -LiteralPath $path)) { Write-Output "MISSING $path"; $fail++; continue }
  $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($path))
  $prompt = @"
You are abstracting a vendor service contract for a commercial retail property management team.
Today is $TODAY. The attached PDF was filed under the '$($item.hint)' service folder and is believed
to be the LATEST agreement for that service at this property. Read it and extract the contract terms.
Rules: dates yyyy-mm-dd; end_date only when stated or exactly derivable (a one-year term commencing
2025-03-01 ends 2026-02-28); if it runs until terminated or renews automatically, leave end_date null
and set auto_renews with the renewal mechanics in term_summary; annual_value = approximate USD per year
from the stated pricing (seasonal contracts: the seasonal total). If this document is a termination
notice or not an executed service contract, set is_service_agreement=false and describe it in notes.
Call submit_extraction with your result.
"@
  $req = @{
    model = 'claude-sonnet-5'
    max_tokens = 900
    tools = @($tool)
    tool_choice = @{ type = 'tool'; name = 'submit_extraction' }
    messages = @(@{ role = 'user'; content = @(
      @{ type = 'document'; source = @{ type = 'base64'; media_type = 'application/pdf'; data = $b64 } },
      @{ type = 'text'; text = $prompt }) })
  } | ConvertTo-Json -Depth 14
  $x = $null
  for ($try = 1; $try -le 3; $try++) {
    try {
      $r = Invoke-RestMethod -Method Post -Uri 'https://api.anthropic.com/v1/messages' -Headers @{ 'x-api-key' = $AK; 'anthropic-version' = '2023-06-01' } -ContentType 'application/json' -Body ($utf8.GetBytes($req)) -TimeoutSec 400
      $tu = $r.content | Where-Object { $_.type -eq 'tool_use' } | Select-Object -First 1
      $x = $tu.input
      break
    } catch {
      $e = if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
      if ($try -lt 3 -and ($e -match '429|529|overloaded')) { Start-Sleep -Seconds (20 * $try); continue }
      Write-Output ("FAIL {0} :: {1}" -f (Split-Path $path -Leaf), $e.Substring(0, [Math]::Min(160, $e.Length)))
      $fail++
      break
    }
  }
  if ($null -eq $x) { continue }
  $rec = [ordered]@{
    document_id = $null
    property_id = $item.p
    title       = (Split-Path $path -Leaf)
    file_path   = $path
    hint        = $item.hint
    extraction  = $x
  }
  [IO.File]::AppendAllText($OUT, (($rec | ConvertTo-Json -Depth 10 -Compress) + "`n"), $utf8)
  $ok++
  Write-Output ("OK {0}/{1} {2} -> {3} end={4}" -f $n, $FILES.Count, (Split-Path $path -Leaf), $x.vendor, $x.end_date)
}
Write-Output ("DONE files  ok {0}  failed {1}" -f $ok, $fail)
