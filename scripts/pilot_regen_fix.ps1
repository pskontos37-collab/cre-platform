# pilot_regen_fix.ps1 - re-run regen+verify for the 11 pilot tenants whose
# 2026-07-13 abstracts came back wrapped in a tool-call envelope key
# ($PARAMETER_NAME / parameter / parameters variants) on lease-abstract v25.
# v26 unwraps all envelope shapes generically and throws (-> retry) on garbage.
param([int]$Shard = 0, [int]$Of = 2)
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$log = "$PSScriptRoot\pilot_regen_fix_s$Shard.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [s$Shard] $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }
$enc = New-Object System.Text.UTF8Encoding($false)

function PostFn($slug, $obj) {
  $tmp = "$PSScriptRoot\_fix_body_s$Shard.json"
  [System.IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Compress), $enc)
  $out = (& curl.exe -s -w "`n%{http_code}" -X POST "$BASE/functions/v1/$slug" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -A $UA --data-binary "@$tmp" --max-time 290) -join "`n"
  $code = ($out -split "`n")[-1]
  $json = if ($out.Length -gt $code.Length) { $out.Substring(0, $out.Length - $code.Length - 1) } else { '' }
  return @{ code = $code; json = $json }
}

$Enveloped = @('BEV MAX LIQUORS','DSW 29193','J. Crew','JINYA Ramen Bar','Krispy Kreme',
  "Moe's Southwest Grill",'Nordstrom Rack','Old Navy #4885','Qdoba','Sport Clips','T-Mobile')
$rows = Invoke-RestMethod -Uri "$BASE/rest/v1/lease_abstracts?select=property_id,tenant_name,locked" -Headers $H -UserAgent $UA -TimeoutSec 60
$all = @($rows | Where-Object { ($Enveloped -contains $_.tenant_name) -and (-not $_.locked) })
$todo = @(for ($j = 0; $j -lt $all.Count; $j++) { if (($j % $Of) -eq $Shard) { $all[$j] } })
Log ("envelope-fix regen: {0} tenants; shard {1}/{2} handles {3}" -f $all.Count, $Shard, $Of, $todo.Count)

$i = 0
foreach ($r in $todo) {
  $i++
  $g = $null
  foreach ($attempt in 1..4) {
    $g = PostFn 'lease-abstract' @{ property_id = $r.property_id; tenant = $r.tenant_name; force = $true }
    if ($g.code -eq '200') { break }
    Log ("  regen attempt {0} http={1} :: {2}" -f $attempt, $g.code, ($g.json -replace '\s+', ' ').Substring(0, [Math]::Min(140, $g.json.Length)))
    Start-Sleep -Seconds 15
  }
  if ($g.code -ne '200') { Log ("{0}/{1} REGEN FAIL :: {2}" -f $i, $todo.Count, $r.tenant_name); continue }
  $v = $null
  foreach ($attempt in 1..3) {
    $v = PostFn 'abstract-verify' @{ property_id = $r.property_id; tenant = $r.tenant_name }
    if ($v.code -eq '200') { break }
    Start-Sleep -Seconds 15
  }
  $qs = ''; try { $qs = ($v.json | ConvertFrom-Json).qa_status } catch {}
  Log ("{0}/{1} OK qa={2} :: {3}" -f $i, $todo.Count, $qs, $r.tenant_name)
}
Log 'envelope-fix regen complete'
