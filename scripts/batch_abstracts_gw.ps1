# batch_abstracts_gw.ps1 - generates all MISSING Gateway abstracts (active,
# non-REA leases without a lease_abstracts row). Log: batch_abstracts_gw.log
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$GW = 'd5a4ed03-0b60-4168-9208-83822dd24884'
$log = "$PSScriptRoot\batch_abstracts_gw.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }

$leases = Invoke-RestMethod -Uri "$BASE/rest/v1/leases?select=tenants(name)&property_id=eq.$GW&status=eq.active&is_rea_member=eq.false" -Headers $H -UserAgent 'cre-loader/1.0' -TimeoutSec 60
$existing = Invoke-RestMethod -Uri "$BASE/rest/v1/lease_abstracts?select=tenant_name&property_id=eq.$GW" -Headers $H -UserAgent 'cre-loader/1.0' -TimeoutSec 60
$have = @($existing | ForEach-Object { $_.tenant_name.ToLower() })
$todo = @($leases | ForEach-Object { $_.tenants.name } | Where-Object { $_ -and ($have -notcontains $_.ToLower()) } | Sort-Object -Unique)
Log ("gateway batch: {0} active leases, {1} to generate" -f @($leases).Count, $todo.Count)

$i = 0
foreach ($t in $todo) {
  $i++
  $body = (@{ property_id = $GW; tenant = $t; force = $true } | ConvertTo-Json -Compress)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $resp = Invoke-RestMethod -Method Post -Uri "$BASE/functions/v1/lease-abstract" `
      -Headers @{ Authorization = "Bearer $KEY"; apikey = $KEY } -ContentType 'application/json' `
      -Body $body -TimeoutSec 280
    $sw.Stop()
    Log ("{0}/{1} OK {2}s docs={3} pdfs={4} :: {5}" -f $i, $todo.Count, [math]::Round($sw.Elapsed.TotalSeconds), $resp.docs_used, $resp.pdf_sources, $t)
  } catch {
    $sw.Stop()
    $msg = $_.Exception.Message
    $respErr = $_.Exception.Response
    if ($respErr) { try { $sr = New-Object IO.StreamReader($respErr.GetResponseStream()); $msg = $sr.ReadToEnd() } catch {} }
    Log ("{0}/{1} FAIL {2}s :: {3} :: {4}" -f $i, $todo.Count, [math]::Round($sw.Elapsed.TotalSeconds), $t, ($msg -replace '\s+', ' ').Substring(0, [Math]::Min(250, $msg.Length)))
    Start-Sleep -Seconds 15
  }
}
Log 'gateway batch complete'
