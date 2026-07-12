# recompute_qa_status.ps1 - re-derive lease_abstracts.qa_status from the ALREADY
# STORED qa JSON, using the refined rule (fabrication_risk no longer forces
# 'issues'). No model calls, no API cost - pure relabel of the existing verdicts.
# Mirrors deriveStatus() in supabase/functions/abstract-verify/index.ts.
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$UA = 'cre-loader/1.0'   # non-browser UA — secret keys are rejected with a browser UA

$MRI = 'MRI|system[- ]of[- ]record'   # MRI-vs-document conflicts are a reconciliation signal, not an abstract error
function Derive($qa) {
  $checks = @(); if ($qa.field_checks) { $checks = @($qa.field_checks) }
  $arith  = @(); if ($qa.arithmetic)   { $arith  = @($qa.arithmetic) }
  $bad = { param($v) $v -eq 'discrepancy' -or $v -eq 'unsupported' }
  # ISSUES = a HIGH-severity DOCUMENT discrepancy (note does NOT invoke MRI),
  # a genuine arithmetic failure, or a document-based stale-amendment flag.
  $highDoc   = @($checks | Where-Object { (& $bad $_.verdict) -and $_.severity -eq 'high' -and ($_.note -notmatch $MRI) }).Count -gt 0
  # A failed arithmetic check counts as an issue ONLY when it is a genuine numeric
  # contradiction — not a "cannot compute / unconfirmed / formula-based" note (the
  # old prompt over-set ok=false for unverifiable values; the v4 prompt tightens this).
  $benignArith = 'cannot|could not|unconfirm|unable|not (stated|fixed|verif|comput|established|pinned)|formula|estimat|unknown|indetermin|n/a'
  $arithFail = @($arith | Where-Object { $_.ok -eq $false -and ($_.detail -notmatch $benignArith) }).Count -gt 0
  $staleDoc  = ($qa.amendment_currency -and $qa.amendment_currency.current -eq $false -and ($qa.amendment_currency.note -notmatch $MRI))
  if ($highDoc -or $arithFail -or $staleDoc) { return 'issues' }
  # REVIEW = softer flags, derived-value disclosures, OR an MRI-only conflict.
  $softFlag = @($checks | Where-Object { (& $bad $_.verdict) -or $_.verdict -eq 'needs_source' }).Count -gt 0
  $fab = ($qa.fabrication_risk -and @($qa.fabrication_risk).Count -gt 0)
  $mri = ($qa.mri_reconciliation -and @($qa.mri_reconciliation).Count -gt 0)
  if ($softFlag -or $fab -or $mri) { return 'review' }
  return 'verified'
}

$rows = Invoke-RestMethod -Uri "$BASE/rest/v1/lease_abstracts?select=id,tenant_name,qa,qa_status&qa=not.is.null" -Headers $H -UserAgent $UA -TimeoutSec 120
Write-Output ("rows with qa: {0}" -f @($rows).Count)
$changed = 0; $tally = @{ issues = 0; review = 0; verified = 0 }
foreach ($r in $rows) {
  $new = Derive $r.qa
  $tally[$new]++
  if ($new -ne $r.qa_status) {
    $body = (@{ qa_status = $new } | ConvertTo-Json -Compress)
    $bytes = [Text.Encoding]::UTF8.GetBytes($body)
    Invoke-RestMethod -Method Patch -Uri "$BASE/rest/v1/lease_abstracts?id=eq.$($r.id)" `
      -Headers ($H + @{ Prefer = 'return=minimal' }) -UserAgent $UA -ContentType 'application/json' -Body $bytes -TimeoutSec 60 | Out-Null
    $changed++
    Write-Output ("  {0}: {1} -> {2}" -f $r.tenant_name, $r.qa_status, $new)
  }
}
Write-Output ("relabeled {0} of {1}" -f $changed, @($rows).Count)
Write-Output ("NEW DISTRIBUTION -> issues={0} review={1} verified={2}" -f $tally.issues, $tally.review, $tally.verified)
