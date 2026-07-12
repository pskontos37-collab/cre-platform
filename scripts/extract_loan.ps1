param([string]$Path, [string]$Prompt = "Extract the loan terms from this commercial mortgage / loan document.")
$ErrorActionPreference = "Stop"
$key = (Get-Content "C:\Users\pskontos\AppData\Local\Temp\claude\C--Users-pskontos-Desktop-Software\c9d09617-ceab-4ad8-9e65-cb51a8403010\scratchpad\secret.json" | ConvertFrom-Json)[0].value
$bytes = [System.IO.File]::ReadAllBytes($Path)
$b64 = [System.Convert]::ToBase64String($bytes)
Write-Output ("file: {0}  ({1:N0} KB)" -f (Split-Path $Path -Leaf), ($bytes.Length/1KB))

$fields = @'
{
  "lender": string|null, "borrower": string|null, "loan_amount": number|null,
  "rate_type": "fixed"|"floating"|null, "interest_rate": number|null (decimal, e.g. 0.0625),
  "rate_index": string|null (e.g. "1-month Term SOFR"), "spread_bps": number|null,
  "interest_rate_cap": string|null, "origination_date": "yyyy-mm-dd"|null, "maturity_date": "yyyy-mm-dd"|null,
  "term_months": number|null, "amortization": string|null (e.g. "Interest-only" or "30-year"),
  "io_period_months": number|null, "monthly_payment": number|null, "annual_debt_service": number|null,
  "dscr_covenant": number|null, "debt_yield_covenant": number|null, "ltv_covenant": number|null,
  "prepayment": string|null, "reserves": string|null, "recourse": string|null, "notes": string
}
'@
$prompt = "$Prompt`nRespond with ONLY a single JSON object (no markdown, no prose) with EXACTLY these keys:`n$fields`nUse null for anything not stated in THIS document. Rates as decimals (6.25% => 0.0625). Dates as yyyy-mm-dd. Put anything notable (cash-management/lockbox triggers, extension options, swap/cap details, who the guarantor is) in notes."

$body = @{
  model = "claude-opus-4-8"; max_tokens = 2048
  messages = @(@{ role = "user"; content = @(
    @{ type = "document"; source = @{ type = "base64"; media_type = "application/pdf"; data = $b64 } },
    @{ type = "text"; text = $prompt }
  )})
} | ConvertTo-Json -Depth 12
$bb = [System.Text.Encoding]::UTF8.GetBytes($body)
try {
  $r = Invoke-RestMethod -Method Post -Uri "https://api.anthropic.com/v1/messages" `
    -Headers @{ "x-api-key" = $key; "anthropic-version" = "2023-06-01" } -ContentType "application/json" -Body $bb -TimeoutSec 300
  $txt = ($r.content | Where-Object { $_.type -eq "text" } | Select-Object -First 1).text
  Write-Output $txt
  Write-Output ("--- usage: in {0} / out {1} tokens" -f $r.usage.input_tokens, $r.usage.output_tokens)
} catch {
  Write-Output "ERR"
  if ($_.ErrorDetails.Message) { Write-Output $_.ErrorDetails.Message }
  elseif ($_.Exception.Response) {
    $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
    Write-Output $sr.ReadToEnd()
  } else { Write-Output $_.Exception.Message }
}