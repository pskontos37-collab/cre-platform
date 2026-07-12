# analyze_issues.ps1 - READ-ONLY. For every qa_status='issues' abstract, report
# WHAT drives the 'issues' label: high-severity discrepancy/unsupported field
# checks (and whether each mentions MRI), failed arithmetic, stale amendment.
# Helps size the MRI-conflict refinement before spending on re-verification.
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']; $UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }

$rows = Invoke-RestMethod -Uri "$BASE/rest/v1/lease_abstracts?select=tenant_name,qa&qa_status=eq.issues" -Headers $H -UserAgent $UA -TimeoutSec 120
$mriRe = 'MRI|system-of-record|system of record'
$onlyMri = 0; $hasDoc = 0; $arithOnly = 0; $staleOnly = 0
foreach ($r in $rows) {
  $qa = $r.qa
  $checks = @(); if ($qa.field_checks) { $checks = @($qa.field_checks) }
  $highBad = @($checks | Where-Object { ($_.verdict -eq 'discrepancy' -or $_.verdict -eq 'unsupported') -and $_.severity -eq 'high' })
  $arithFail = @(@($qa.arithmetic) | Where-Object { $_.ok -eq $false })
  $stale = ($qa.amendment_currency -and $qa.amendment_currency.current -eq $false)
  # Of the high-severity bad checks, how many look like MRI-vs-doc conflicts?
  $highMri = @($highBad | Where-Object { ($_.note -match $mriRe) -or ($_.field -match 'mri') })
  $highDoc = @($highBad | Where-Object { -not (($_.note -match $mriRe) -or ($_.field -match 'mri')) })
  $tag = ''
  if ($highDoc.Count -gt 0) { $hasDoc++; $tag = "DOC-ERROR ($($highDoc.Count) doc, $($highMri.Count) mri)" }
  elseif ($highBad.Count -gt 0) { $onlyMri++; $tag = "MRI-ONLY ($($highMri.Count))" }
  elseif ($arithFail.Count -gt 0) { $arithOnly++; $tag = "ARITH-FAIL ($($arithFail.Count))" }
  elseif ($stale) { $staleOnly++; $tag = 'STALE-ONLY' }
  else { $tag = 'OTHER' }
  Write-Output ("{0,-38} {1}" -f $r.tenant_name, $tag)
}
Write-Output ""
Write-Output ("TOTALS: has-real-doc-error=$hasDoc  MRI-only=$onlyMri  arith-only=$arithOnly  stale-only=$staleOnly  of $(@($rows).Count)")
