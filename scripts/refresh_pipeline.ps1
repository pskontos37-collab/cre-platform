# refresh_pipeline.ps1 - THE WEEKLY ONE-COMMAND REFRESH, run after each week's
# acquisitions meeting (the Acq. Pipeline Summary is updated weekly).
# Chain:
#   1. load_acq_pipeline.ps1    sync the newest summary book (auto-discovered)
#   2. link_deal_folders.ps1    (re)link deals to K:\ACQUISITIONS folders
#   3. mirror_deal_docs.ps1     mirror NEW files only (idempotent skip-set)
#   4. extract_site_plans.ps1   secure a site plan for deals still missing one
#   5. render_site_plans.ps1    rasterize new site-plan PDFs -> stored JPEGs (for the meeting deck)
#   6. extract_underwriting.ps1 fill still-blank return metrics from deal docs
#   7. extract_rent_roll.ps1    auto-populate the tenant-level underwriting model from the rent roll
#   8. extract_t12.ps1          derive recoverable/non-recoverable OpEx from the T-12 (recoveries)
#   9. audit_folder_links.ps1   READ-ONLY report: does every deal's folder actually
#                               belong to that deal? (step 2 links by fuzzy name; a
#                               generic name once matched a different property and
#                               mirrored 36 wrong-property docs onto the deal). Runs
#                               LAST so it sees the final links + mirrored documents.
#                               Writes nothing - grep the log for 'FLAGGED'.
# Logs to scripts\logs\refresh_<date>.log. Safe to re-run any time.
$ErrorActionPreference = "Continue"   # a failed step logs; later steps still run
$here = Split-Path $MyInvocation.MyCommand.Path
$logDir = Join-Path $here "logs"; New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir ("refresh_" + (Get-Date -Format 'yyyy-MM-dd_HHmm') + ".log")

function Step([string]$title, [scriptblock]$body){
  $line = "===== $title  ($(Get-Date -Format 'HH:mm:ss')) ====="
  Write-Output $line; Add-Content $log $line
  try { & $body 2>&1 | Tee-Object -FilePath $log -Append }
  catch { $m = "STEP FAILED: $($_.Exception.Message)"; Write-Output $m; Add-Content $log $m }
}

Step "1/9 Sync weekly pipeline book"    { & (Join-Path $here 'load_acq_pipeline.ps1') }
Step "2/9 Link deal folders"            { & (Join-Path $here 'link_deal_folders.ps1') }
Step "3/9 Mirror new documents"         { & (Join-Path $here 'mirror_deal_docs.ps1') -Apply }
Step "4/9 Site plans"                   { & (Join-Path $here 'extract_site_plans.ps1') -Apply }
Step "5/9 Render site plans"            { & (Join-Path $here 'render_site_plans.ps1') }
Step "6/9 Underwriting auto-fill"       { & (Join-Path $here 'extract_underwriting.ps1') -Apply }
Step "7/9 Rent roll -> model"           { & (Join-Path $here 'extract_rent_roll.ps1') -Apply }
Step "8/9 T-12 -> recoveries"           { & (Join-Path $here 'extract_t12.ps1') -Apply }
Step "9/9 Audit folder links"           { & (Join-Path $here 'audit_folder_links.ps1') }

# Surface the audit verdict in the last lines of the run so a weekly skim catches a
# mis-link without reading the whole log. Reads the audit's own "FLAGGED: N" count.
$auditLine = 'Folder-link audit: no verdict found (did step 9/9 fail?).'
$m = @(Select-String -Path $log -Pattern 'FLAGGED:\s*(\d+)' -ErrorAction SilentlyContinue)
if($m.Count -gt 0){
  $n = [int]$m[-1].Matches[0].Groups[1].Value
  $auditLine = if($n -eq 0){ 'Folder-link audit: OK - every deal folder agrees with its deal.' }
               else { "Folder-link audit: $n link(s) FLAGGED - search this log for 'FLAGGED FOR REVIEW'." }
}
Write-Output $auditLine; Add-Content $log $auditLine

$done = "===== Refresh complete ($(Get-Date -Format 'HH:mm:ss')). Log: $log ====="
Write-Output $done; Add-Content $log $done
