# Extract JV/promote/waterfall economics from entity governance PDFs via the Anthropic API (native PDF).
# Env: ENTITY_LIST (file of PDF paths), OUT_DIR. Writes <name>.md per doc.
$ErrorActionPreference = "Stop"
$repo="C:\Users\pskontos\Desktop\Software\cre-platform"
$cfg=@{}; foreach($l in (Get-Content "$repo\.env" | Where-Object {$_ -match "="})){ $k,$v=$l -split '=',2; $cfg[$k.Trim()]=$v.Trim() }
$AK=$cfg['ANTHROPIC_API_KEY']
$list = Get-Content -LiteralPath $env:ENTITY_LIST | Where-Object { $_ }
$out = $env:OUT_DIR
$ctx = if($env:ENTITY_CONTEXT){ $env:ENTITY_CONTEXT } else { 'GATEWAY / Port Chester shopping center' }
$prompt = @"
You are a commercial real estate JV / fund analyst. This PDF (or page-segment) is an entity governance
document for the $ctx ownership structure. Extract and explain the
ECONOMIC and CONTROL terms that define the JV promote structure, splits, and investor economics.

Cover every item that appears (quote specific numbers, %, $ and cite section numbers):
1. Entity name, its role in the structure, and its MEMBERS (names + percentage/ownership interests + class).
2. Capital contributions / commitments (amounts; identify preferred vs common vs priority capital).
3. Preferred return / pref rate, compounding, and on what balance.
4. The FULL DISTRIBUTION WATERFALL, tier by tier (operating cash AND capital proceeds if separate):
   return of capital, preferred return, IRR/hurdle thresholds, GP catch-up, and the PROMOTE / carried-interest
   splits at each tier and TO WHOM (sponsor/MJW vs the institutional/preferred partner vs investors).
5. Promote / carried interest percentages and the sponsor entitled to them.
6. Management & control: managing member, major/approval decisions, removal rights.
7. Fees (asset management, property management, acquisition, disposition, financing, guaranty).
8. Capital calls, dilution, and default/failure-to-fund remedies.
9. Transfers, buy/sell, rights of first refusal/offer.

If this is only a segment of a larger agreement, report exactly what THIS segment contains. Be precise;
do not invent terms not present. Output clean markdown.
"@
# Optional: override the whole prompt from a file (e.g. a PMA-specific extraction prompt).
if($env:EXTRACT_PROMPT_FILE -and (Test-Path -LiteralPath $env:EXTRACT_PROMPT_FILE)){ $prompt = [System.IO.File]::ReadAllText($env:EXTRACT_PROMPT_FILE) }
$maxtok = if($env:EXTRACT_MAXTOK){ [int]$env:EXTRACT_MAXTOK } else { 4000 }
foreach($p in $list){
  if(-not (Test-Path -LiteralPath $p)){ Write-Output "MISSING $p"; continue }
  $name = ([System.IO.Path]::GetFileNameWithoutExtension($p)) -replace '[^\w\-]','_'
  $b64=[System.Convert]::ToBase64String([System.IO.File]::ReadAllBytes($p))
  $body=@{ model='claude-opus-4-8'; max_tokens=$maxtok; messages=@(@{role='user';content=@(
    @{type='document';source=@{type='base64';media_type='application/pdf';data=$b64}},
    @{type='text';text=$prompt})})} | ConvertTo-Json -Depth 12
  try{
    $r=Invoke-RestMethod -Method Post -Uri "https://api.anthropic.com/v1/messages" -Headers @{ "x-api-key"=$AK; "anthropic-version"="2023-06-01" } -ContentType "application/json" -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 400
    $txt=($r.content | Where-Object {$_.type -eq 'text'} | Select-Object -First 1).text
    [System.IO.File]::WriteAllText("$out\$name.md",$txt,(New-Object System.Text.UTF8Encoding($false)))
    Write-Output ("OK $name  (in {0}/out {1} tok)" -f $r.usage.input_tokens,$r.usage.output_tokens)
  }catch{
    $e=if($_.ErrorDetails.Message){$_.ErrorDetails.Message}else{$_.Exception.Message}
    Write-Output ("FAIL $name :: " + $e.Substring(0,[Math]::Min(200,$e.Length)))
  }
}
Write-Output "DONE entity extraction"
