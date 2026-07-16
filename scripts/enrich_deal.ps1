# enrich_deal.ps1 - ONE-COMMAND per-deal enrichment. Run this right after adding
# a deal in /pipeline (manual composer or OM upload) to pull everything in from
# the K:\ACQUISITIONS folders. Does the SAME chain as the weekly refresh but
# scoped to a single deal (substring match on the deal name), so it's fast.
#
#   .\enrich_deal.ps1 -Deal "Overland Crossing"
#
# Chain (all scoped by -DealFilter):
#   1. link_deal_folders   find + link the K:\ACQUISITIONS folder
#   2. mirror_deal_docs     mirror the folder's files into storage (OM, financials, ...)
#   3. enrich_deals         Claude reads the OM -> year built/submarket/seller/broker/
#                           pricing/thesis + tenant roster + occupancy
#   4. extract_site_plans   secure a site-plan PDF (standalone or clipped from the OM)
#   5. render_site_plans    rasterize it to a stored JPEG for the meeting deck
#   6. extract_underwriting fill return metrics from the deal's own CF model / docs
#   7. extract_rent_roll    auto-populate the tenant-level underwriting model from the rent roll
#   8. extract_t12          derive recoverable/non-recoverable OpEx from the T-12 so
#                           NNN recoveries flow in the tenant model
# Logs to scripts\logs\enrich_<deal>_<date>.log. Idempotent - safe to re-run.
param([Parameter(Mandatory=$true)][string]$Deal)
$ErrorActionPreference = "Continue"   # a failed step logs; later steps still run
$here = Split-Path $MyInvocation.MyCommand.Path

# preflight: confirm the name matches exactly one active deal (warn if 0 / many)
$repo = "C:\Users\pskontos\Desktop\Software\cre-platform"
$cfg = @{}; foreach ($ln in (Get-Content "$repo\.env" | Where-Object { $_ -match "=" })) { $a,$b = $ln -split '=',2; $cfg[$a.Trim()]=$b.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $AK = $cfg['SUPABASE_SECRET_KEY']
$all = & curl.exe -s "$BASE/rest/v1/pipeline_deals?select=name,stage&limit=2000" -H "apikey: $AK" -H "Authorization: Bearer $AK" | ConvertFrom-Json
$hits = @($all | Where-Object { $_.name -like "*$Deal*" })
if ($hits.Count -eq 0) { Write-Output "No pipeline deal matches '*$Deal*'. Check the exact name on /pipeline and try again."; exit 1 }
Write-Output ("Enriching {0} deal(s): {1}" -f $hits.Count, (($hits | ForEach-Object { $_.name }) -join ', '))
if ($hits.Count -gt 1) { Write-Output "  (name matched more than one deal - all will be processed; use a more specific -Deal to narrow)" }

$logDir = Join-Path $here "logs"; New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir ("enrich_" + (($Deal -replace '[^\w]+','_').Trim('_')) + "_" + (Get-Date -Format 'yyyy-MM-dd_HHmm') + ".log")

function Step([string]$title, [scriptblock]$body){
  $line = "===== $title  ($(Get-Date -Format 'HH:mm:ss')) ====="
  Write-Output $line; Add-Content $log $line
  try { & $body 2>&1 | Tee-Object -FilePath $log -Append }
  catch { $m = "STEP FAILED: $($_.Exception.Message)"; Write-Output $m; Add-Content $log $m }
}

Step "1/8 Link folder"           { & (Join-Path $here 'link_deal_folders.ps1')   -DealFilter $Deal }
Step "2/8 Mirror documents"      { & (Join-Path $here 'mirror_deal_docs.ps1')     -Apply -DealFilter $Deal }
Step "3/8 OM facts + tenants"    { & (Join-Path $here 'enrich_deals.ps1')         -Apply -DealFilter $Deal }
Step "4/8 Site plan"             { & (Join-Path $here 'extract_site_plans.ps1')   -Apply -DealFilter $Deal }
Step "5/8 Render site plan"      { & (Join-Path $here 'render_site_plans.ps1')          -DealFilter $Deal }
Step "6/8 Underwriting metrics"  { & (Join-Path $here 'extract_underwriting.ps1') -Apply -DealFilter $Deal }
Step "7/8 Rent roll -> model"    { & (Join-Path $here 'extract_rent_roll.ps1')    -Apply -DealFilter $Deal }
Step "8/8 T-12 -> recoveries"    { & (Join-Path $here 'extract_t12.ps1')          -Apply -DealFilter $Deal }

$done = "===== Enrichment complete for '$Deal' ($(Get-Date -Format 'HH:mm:ss')). Log: $log ====="
Write-Output $done; Add-Content $log $done
