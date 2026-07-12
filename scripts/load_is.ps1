param([string]$Path, [string]$PropertyId, [int]$Year, [int]$Month)
$ErrorActionPreference = "Stop"
$SP = "C:\Users\pskontos\AppData\Local\Temp\claude\C--Users-pskontos-Desktop-Software\c9d09617-ceab-4ad8-9e65-cb51a8403010\scratchpad"
$cfg = @{}; foreach ($l in (Get-Content "C:\Users\pskontos\Desktop\Software\cre-platform\.env" | Where-Object { $_ -match "=" })) { $k,$v = $l -split '=',2; $cfg[$k.Trim()]=$v.Trim() }
$KEY = $cfg['SUPABASE_SECRET_KEY']; $BASE = $cfg['VITE_SUPABASE_URL']
$enc = New-Object System.Text.UTF8Encoding($false)

# 1. Extract the IS PDF via Claude
$prompt = @'
This is a monthly commercial real estate Income Statement (P&L). Return ONLY a JSON object:
{ "period_end":"yyyy-mm-dd",
  "lines":[ {"name":"<line item>","section":"income|expense","mtd_actual":<num|null>,"mtd_budget":<num|null>} ] }
Include every revenue and operating-expense line. Numbers plain (no $/commas; parentheses=negative). null if absent.
Mark interest, depreciation, amortization, debt service, and capital items with section "below" (not income/expense).
'@
$txt = & "$SP\extract_pdf.ps1" -Path $Path -Prompt $prompt -MaxTokens 8192
$txt = $txt -replace '^```json','' -replace '^```','' -replace '```$',''
$is = $txt | ConvertFrom-Json
Write-Output ("extracted lines: " + $is.lines.Count)

function Classify($name, $section) {
  $n = $name.ToLower()
  if ($section -eq 'income') {
    if ($n -match 'percentage|% rent|pct rent') { return 'percentage_rent' }
    if ($n -match 'base rent|rental') { return 'base_rent' }
    if ($n -match 'recover') { return 'cam_recovery' }
    return 'other_income'
  }
  if ($section -eq 'below') { return 'capital_expenditure' }   # excluded from NOI by computeNOI
  if ($n -match 'management fee|mgmt fee|asset management') { return 'management_fee' }
  if ($n -match 'propert.*tax|real estate tax|re tax|^tax| tax ') { return 'taxes' }
  if ($n -match 'insurance') { return 'insurance' }
  if ($n -match 'electric|water|gas|sewer|utilit') { return 'utilities' }
  if ($n -match 'repair|mainten|landscap|janitor|parking|roof|hvac|paint|snow|sweep|ground|pest|clean|sign|lighting|security|alarm|fire') { return 'repairs_maintenance' }
  if ($n -match 'advertis|market|legal|professional|bad debt|bank fee|admin|g&a|postage|due|travel|license|office') { return 'other_expense' }
  return 'operating_expenses'
}

$ps = '{0:0000}-{1:00}-01' -f $Year, $Month
$pe = (Get-Date $ps).AddMonths(1).AddDays(-1).ToString('yyyy-MM-dd')

function PostJson($table, $obj, $prefer) {
  $tmp = "$SP\_is_post_$PID.json"
  [System.IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Depth 6), $enc)
  & curl.exe -s -X POST "$BASE/rest/v1/$table" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Prefer: $prefer" --data-binary "@$tmp"
}

# 2. idempotent: clear existing periods for this property+month (cascade clears line items)
foreach ($isb in @('false','true')) {
  & curl.exe -s -X DELETE "$BASE/rest/v1/financial_periods?property_id=eq.$PropertyId&period_start=eq.$ps&is_budget=eq.$isb" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" | Out-Null
}

# 3. load actual + budget periods
foreach ($variant in @(@{flag=$false; field='mtd_actual'}, @{flag=$true; field='mtd_budget'})) {
  $period = @{ property_id=$PropertyId; period_start=$ps; period_end=$pe; period_type='monthly'; is_budget=$variant.flag; source='mri' }
  $pr = PostJson 'financial_periods' @($period) 'return=representation'
  $perId = ($pr | ConvertFrom-Json)[0].id
  $items = @()
  foreach ($ln in $is.lines) {
    $amt = $ln.($variant.field)
    if ($null -eq $amt) { continue }
    $items += @{ financial_period_id=$perId; category=(Classify $ln.name $ln.section); line_name=$ln.name; amount=[double]$amt }
  }
  if ($items.Count -gt 0) { PostJson 'operating_line_items' @($items) 'return=minimal' | Out-Null }
  Write-Output ("loaded {0} period: {1} line items" -f $(if($variant.flag){'BUDGET'}else{'ACTUAL'}), $items.Count)
}
Write-Output "DONE"