# batch_abstracts.ps1 - generates lease abstracts for every active-lease tenant
# of the given properties that doesn't have one yet. Sequential (one Claude call
# each, ~1-2 min); resumable - rerunning skips tenants already abstracted.
# Log: scripts\batch_abstracts.log
param([string[]]$PropertyIds = @('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000011'))
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']; $ANON = $cfg['VITE_SUPABASE_ANON_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$log = "$PSScriptRoot\batch_abstracts.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }

foreach ($prop in $PropertyIds) {
  # Active-lease tenant names (trade_name preferred), mirroring the /abstracts page.
  # REA members (parcel owners under the REA) are excluded - no lease to abstract.
  $leases = Invoke-RestMethod -Uri "$BASE/rest/v1/leases?select=status,tenants(name,trade_name)&property_id=eq.$prop&status=eq.active&is_rea_member=eq.false" -Headers $H -UserAgent $UA -TimeoutSec 60
  $names = @($leases | ForEach-Object { $n = $_.tenants.trade_name; if (-not $n) { $n = $_.tenants.name }; if ($n) { $n.Trim() } } | Where-Object { $_.Length -gt 1 } | Sort-Object -Unique)
  # Existing abstracts (skip - resumable)
  $existing = Invoke-RestMethod -Uri "$BASE/rest/v1/lease_abstracts?select=tenant_name&property_id=eq.$prop" -Headers $H -UserAgent $UA -TimeoutSec 60
  $have = @{}
  foreach ($e in $existing) { $have[$e.tenant_name.ToLower()] = $true }
  # Not real tenant leases (user-confirmed): CSC is a service contract.
  $skip = @('Corporate Services Consultants, LLC')
  $todo = @($names | Where-Object { -not $have[$_.ToLower()] -and $skip -notcontains $_ })
  Log "[$prop] $($names.Count) tenants, $($todo.Count) to generate"

  $i = 0
  foreach ($t in $todo) {
    $i++
    $body = (@{ property_id = $prop; tenant = $t } | ConvertTo-Json -Compress)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
      $r = Invoke-RestMethod -Method Post -Uri "$BASE/functions/v1/lease-abstract" `
        -Headers @{ Authorization = "Bearer $ANON"; apikey = $ANON } -ContentType 'application/json' `
        -Body $body -TimeoutSec 280
      $sw.Stop()
      Log ("[$prop] {0}/{1} OK {2}s docs={3} :: {4}" -f $i, $todo.Count, [math]::Round($sw.Elapsed.TotalSeconds), $r.docs_used, $t)
    } catch {
      $sw.Stop()
      $msg = $_.Exception.Message
      $resp = $_.Exception.Response
      if ($resp) { try { $sr = New-Object IO.StreamReader($resp.GetResponseStream()); $msg = $sr.ReadToEnd() } catch {} }
      Log ("[$prop] {0}/{1} FAIL {2}s :: {3} :: {4}" -f $i, $todo.Count, [math]::Round($sw.Elapsed.TotalSeconds), $t, ($msg -replace '\s+', ' ').Substring(0, [Math]::Min(300, $msg.Length)))
      Start-Sleep -Seconds 10   # transient API errors (529) - brief backoff
    }
  }
}
Log 'batch complete'
