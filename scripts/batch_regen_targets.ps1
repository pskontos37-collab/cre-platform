# batch_regen_targets.ps1 - regen+verify a NAMED list of tenants on the current
# lease-abstract fn (v23: current-schedule-only, MRI-not-a-source, guarantor-only-
# if-executed). Targets = the 2026-07-08 worklist Groups 1/2/4/6 (see
# docs/abstract-issues-worklist.md). Skips locked. Log: batch_regen_targets.log
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$log = "$PSScriptRoot\batch_regen_targets.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }
$enc = New-Object System.Text.UTF8Encoding($false)

# tenant_name|property_id (exact DB values, resolved 2026-07-09)
$targets = @(
  '100 Chiro Fehrman, LLC|d4f08824-2d88-472d-b7aa-a703310c2aaf',
  "Bad Daddy's Burger Bar|d4f08824-2d88-472d-b7aa-a703310c2aaf",
  'Bass Pro Shop|d4f08824-2d88-472d-b7aa-a703310c2aaf',
  'BEV MAX LIQUORS|d5a4ed03-0b60-4168-9208-83822dd24884',
  'Dave and Busters|d4f08824-2d88-472d-b7aa-a703310c2aaf',
  'European Wax Center|00000000-0000-0000-0000-000000000011',
  "Firebird's Wood Fired Grill|d4f08824-2d88-472d-b7aa-a703310c2aaf",
  'GNC|00000000-0000-0000-0000-000000000010',
  'HomeGoods, Inc.|00000000-0000-0000-0000-000000000010',
  'Music and Arts|d4f08824-2d88-472d-b7aa-a703310c2aaf',
  'Restore Hyper Wellness of Port Chester|d5a4ed03-0b60-4168-9208-83822dd24884',
  'Salt Grass|00000000-0000-0000-0000-000000000010',
  'SSI Greenville LLC|d4f08824-2d88-472d-b7aa-a703310c2aaf',
  'Subway #37092|00000000-0000-0000-0000-000000000010',
  'TJ Maxx|00000000-0000-0000-0000-000000000011',
  'Woodhouse Day Spa|d4f08824-2d88-472d-b7aa-a703310c2aaf'
)

function PostFn($slug, $prop, $tenant) {
  $body = (@{ property_id = $prop; tenant = $tenant } | ConvertTo-Json -Compress)
  $tmp = "$PSScriptRoot\_targets_body.json"
  [System.IO.File]::WriteAllText($tmp, $body, $enc)
  $out = & curl.exe -s -w "`n%{http_code}" -X POST "$BASE/functions/v1/$slug" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -A $UA --data-binary "@$tmp" --max-time 295
  $code = ($out -split "`n")[-1]
  $json = if ($out.Length -gt $code.Length) { $out.Substring(0, $out.Length - $code.Length - 1) } else { '' }
  return @{ code = $code; json = $json }
}

$i = 0
foreach ($t in $targets) {
  $i++
  $name, $prop = $t -split '\|', 2
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $g = PostFn 'lease-abstract' $prop $name
  if ($g.code -ne '200') {
    $sw.Stop()
    Log ("{0}/{1} REGEN-FAIL http={2} :: {3} :: {4}" -f $i, $targets.Count, $g.code, $name, (($g.json -replace '\s+',' ').Substring(0, [Math]::Min(180, $g.json.Length))))
    Start-Sleep -Seconds 8; continue
  }
  $v = PostFn 'abstract-verify' $prop $name
  $sw.Stop()
  $qs = ''; try { $qs = ($v.json | ConvertFrom-Json).qa_status } catch {}
  Log ("{0}/{1} OK {2}s -> qa={3} :: {4}" -f $i, $targets.Count, [math]::Round($sw.Elapsed.TotalSeconds), $qs, $name)
}
Log 'targets regen+verify complete'
