# batch_abstracts_regen.ps1 - FORCE-regenerates every existing lease abstract on
# the current lease-abstract edge fn (v7: primary-PDF attachments + file-inventory
# grounding + prefixed open items). Resumable: skips abstracts already generated
# after the v7 deploy time. Log: scripts\batch_abstracts_regen.log
param(
  [string]$Since = '2026-07-05T03:56:00Z',   # regenerate abstracts generated before this
  [int]$Shard = 0, [int]$Of = 1              # parallel shards: process todo index % Of == Shard
)
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$log = "$PSScriptRoot\batch_abstracts_regen_s$Shard.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [s$Shard] $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }
$enc = New-Object System.Text.UTF8Encoding($false)

$rows = Invoke-RestMethod -Uri "$BASE/rest/v1/lease_abstracts?select=property_id,tenant_name,generated_at,locked&order=property_id,tenant_name" -Headers $H -UserAgent $UA -TimeoutSec 60
# Never clobber a human-locked (verified) abstract with an AI re-run.
$all = @($rows | Where-Object { (-not $_.locked) -and ([datetime]$_.generated_at).ToUniversalTime() -lt ([datetime]::Parse($Since).ToUniversalTime()) })
$todo = @(for ($j = 0; $j -lt $all.Count; $j++) { if (($j % $Of) -eq $Shard) { $all[$j] } })
Log ("regen: {0} total older than {1}; this shard {2}/{3} handles {4}" -f $all.Count, $Since, $Shard, $Of, $todo.Count)

$i = 0
foreach ($r in $todo) {
  $i++
  # POST via curl.exe --data-binary: PS 5.1 Invoke-RestMethod corrupts non-ASCII
  # tenant names in the body (Cafe'/accents) and returns spurious 401 on some calls.
  $body = (@{ property_id = $r.property_id; tenant = $r.tenant_name; force = $true } | ConvertTo-Json -Compress)
  $tmp = "$PSScriptRoot\_regen_body_s$Shard.json"
  [System.IO.File]::WriteAllText($tmp, $body, $enc)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $out = & curl.exe -s -w "`n%{http_code}" -X POST "$BASE/functions/v1/lease-abstract" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -A $UA --data-binary "@$tmp" --max-time 285
  $sw.Stop()
  $code = ($out -split "`n")[-1]
  $json = if ($out.Length -gt $code.Length) { $out.Substring(0, $out.Length - $code.Length - 1) } else { '' }
  if ($code -eq '200') {
    $docs = 0; $pdfs = 0; try { $o = $json | ConvertFrom-Json; $docs = $o.docs_used; $pdfs = $o.pdf_sources } catch {}
    Log ("{0}/{1} OK {2}s docs={3} pdfs={4} :: {5}" -f $i, $todo.Count, [math]::Round($sw.Elapsed.TotalSeconds), $docs, $pdfs, $r.tenant_name)
  } else {
    Log ("{0}/{1} FAIL http={2} {3}s :: {4} :: {5}" -f $i, $todo.Count, $code, [math]::Round($sw.Elapsed.TotalSeconds), $r.tenant_name, ($json -replace '\s+', ' ').Substring(0, [Math]::Min(200, $json.Length)))
    Start-Sleep -Seconds 10   # transient API errors (429/529) - backoff
  }
}
Log 'regen batch complete'
