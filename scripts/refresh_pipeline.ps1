# refresh_pipeline.ps1 - THE WEEKLY ONE-COMMAND REFRESH, run after each week's
# acquisitions meeting (the Acq. Pipeline Summary is updated weekly).
# Chain:
#   1. load_acq_pipeline.ps1    sync the newest summary book (auto-discovered)
#   2. link_deal_folders.ps1    (re)link deals to K:\ACQUISITIONS folders
#   3. mirror_deal_docs.ps1     mirror NEW files only (idempotent skip-set)
#   4. extract_site_plans.ps1   secure a site plan for deals still missing one
#   5. render_site_plans.ps1    rasterize new site-plan PDFs -> stored JPEGs (for the meeting deck)
#   6. extract_underwriting.ps1 fill still-blank return metrics from deal docs
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

Step "1/6 Sync weekly pipeline book"    { & (Join-Path $here 'load_acq_pipeline.ps1') }
Step "2/6 Link deal folders"            { & (Join-Path $here 'link_deal_folders.ps1') }
Step "3/6 Mirror new documents"         { & (Join-Path $here 'mirror_deal_docs.ps1') -Apply }
Step "4/6 Site plans"                   { & (Join-Path $here 'extract_site_plans.ps1') -Apply }
Step "5/6 Render site plans"            { & (Join-Path $here 'render_site_plans.ps1') }
Step "6/6 Underwriting auto-fill"       { & (Join-Path $here 'extract_underwriting.ps1') -Apply }

$done = "===== Refresh complete ($(Get-Date -Format 'HH:mm:ss')). Log: $log ====="
Write-Output $done; Add-Content $log $done
