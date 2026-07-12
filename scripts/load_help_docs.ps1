# load_help_docs.ps1  (ASCII only - PS 5.1)
# Uploads the documents referenced by the in-app Help Center to the documents
# bucket under forms/help/<slug><ext>. The "forms/" prefix is readable by any
# authenticated user (existing storage RLS "auth read forms prefix"), so the
# logged-in Help drawer can mint signed URLs for them at runtime - no migration.
# Originals are uploaded as-is: PDFs open inline in the browser; Office files
# download (the desired action for fillable forms). Files are located by name
# under K:\Property Management so exact folder paths don't have to be hard-coded.

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$envMap = @{}
Get-Content (Join-Path $repoRoot '.env') | ForEach-Object {
  if ($_ -match '^\s*([^#=]+)=(.*)$') { $envMap[$matches[1].Trim()] = $matches[2].Trim() }
}
$baseUrl = $envMap['VITE_SUPABASE_URL']
$svcJwt  = $envMap['SUPABASE_SERVICE_JWT']
if (-not $baseUrl -or -not $svcJwt) { throw 'Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_JWT in .env' }

$KM = 'K:\Property Management'

# slug -> filename pattern to locate on K: (newest match wins)
$docs = @(
  @{ slug = 'tenant-notification-form';      pattern = 'M & J Wilkow Tenant Notification Form.xls' },
  @{ slug = 'travel-expense-policy-2025';    pattern = '*Travel & Expense Policy*FINAL*.pdf' },
  @{ slug = 'certify-missing-receipt';       pattern = 'Certify*Missing Receipt*.pdf' },
  @{ slug = 'construction-plan-review-2026'; pattern = 'Signage*Construction Plans Review Policy*.docx' },
  @{ slug = 'v-drive-filing-2026';           pattern = '*V Drive Filing Procedure*.docx' },
  @{ slug = 'check-request-2026';            pattern = 'Check Request Form*.doc' },
  @{ slug = 'tenant-refund-2026';            pattern = 'Tenant Refund Request*.xlsx' },
  @{ slug = 'balance-writeoff-2026';         pattern = 'Balance Write Off Request*.xlsx' }
)

function Get-Mime([string]$ext) {
  switch ($ext.ToLower()) {
    '.pdf'  { 'application/pdf' }
    '.xls'  { 'application/vnd.ms-excel' }
    '.xlsx' { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
    '.doc'  { 'application/msword' }
    '.docx' { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
    default { 'application/octet-stream' }
  }
}

$allFiles = Get-ChildItem -LiteralPath $KM -Recurse -File -ErrorAction SilentlyContinue
$results = @()
foreach ($d in $docs) {
  $match = $allFiles | Where-Object { $_.Name -like $d.pattern } |
           Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $match) { Write-Host ("MISSING: " + $d.slug + "  (" + $d.pattern + ")"); continue }
  $ext = $match.Extension.ToLower()
  $key = 'forms/help/' + $d.slug + $ext
  $uploadUrl = "$baseUrl/storage/v1/object/documents/$key"
  $resp = curl.exe -sS -X POST $uploadUrl `
    -H "Authorization: Bearer $svcJwt" `
    -H ("Content-Type: " + (Get-Mime $ext)) `
    -H "x-upsert: true" `
    --data-binary ("@" + $match.FullName)
  if ($resp -match '"error"' -or $resp -match '"statusCode"\s*:\s*"?4') { throw "Upload failed for $key : $resp" }
  Write-Host ("OK  " + $key + "   <- " + $match.Name)
  $results += [pscustomobject]@{ slug = $d.slug; key = $key; file = $match.Name; ext = $ext }
}

Write-Host ""
Write-Host "==== helpContent mapping (slug -> storage key / filename) ===="
$results | ForEach-Object { Write-Host ("  {0,-30} {1,-42} {2}" -f $_.slug, $_.key, $_.file) }
Write-Host ("Done: " + $results.Count + " / " + $docs.Count + " uploaded.")
