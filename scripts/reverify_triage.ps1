# reverify_triage.ps1 - re-run the verifiers over ONLY the rows corrected in the
# 2026-07-16 triage pass, so the QA badges reflect the corrections. Targeted (no
# full-shard re-verify). Service contracts: agreement-verify (kind=svc, id).
# Lease exclusives: abstract-verify (property_id, tenant, looked up by id).
# Log: scripts\reverify_triage.log
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$log = "$PSScriptRoot\reverify_triage.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }
$enc = New-Object System.Text.UTF8Encoding($false)

function PostFn($slug, $obj) {
  $tmp = "$PSScriptRoot\_reverify_body.json"
  [System.IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Compress), $enc)
  $out = (& curl.exe -s -w "`n%{http_code}" -X POST "$BASE/functions/v1/$slug" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -A $UA --data-binary "@$tmp" --max-time 295) -join "`n"
  $code = ($out -split "`n")[-1]
  $json = if ($out.Length -gt $code.Length) { $out.Substring(0, $out.Length - $code.Length - 1) } else { '' }
  return @{ code = $code; json = $json }
}

$svcIds = @(
  'cb6b52cc-241c-4f86-a2c1-2beeb37c324f','8784654b-7096-4c8c-ba3a-f5719047214b',
  '17e81f50-bc1a-434e-ab8a-e4f61bb9773b','04cb2deb-40a7-4e69-a65a-12cdf4abd238',
  '3d44f2cb-6680-4e25-bc1b-ca7cac454ddc','e1c5e71a-c7e8-4327-848e-49f5f1aaf40c',
  'ce32f335-721b-478e-9b9a-e053e4fa4dc2','4ee8a800-45af-485d-bae2-6f4f109b7062',
  '9f48ca8f-6e5a-4523-a9d3-a4b9d98f1a6b','d1feff5c-9183-4061-858d-10c6f96bdc31',
  '6b71d41d-4a31-47b1-9a20-2370e52fa088','e4e469f6-0533-4008-ab44-805056986462',
  '2456be92-5d75-48c2-9560-80cd4abdd444')

$leaseIds = @(
  'cabff268-375f-41be-9d06-f7d269ae93cc','5eae9ebb-55e5-4163-b0ee-483610c5e89c',
  '7894891e-d0ca-490d-b12b-6ea387ff5d00','4340706f-4be0-4007-b767-0d5d2ef230a5',
  '2222e8af-40ae-44e2-a439-f2780b381c56','101ed7eb-6003-4144-ba9b-03a1799ed8a3',
  '40d39f40-60a2-40f1-ae00-d59f5c42b06b','9d4465b7-0ec5-4050-afad-9a488e1d8ee8',
  '4c6de200-31b4-4666-9992-16d171ed7605')

Log ("reverify start: {0} svc + {1} lease rows" -f $svcIds.Count, $leaseIds.Count)

# --- service contracts: agreement-verify kind=svc (Sonnet, short) ---
$i = 0
foreach ($id in $svcIds) {
  $i++; $ok = $false; $qs = ''
  foreach ($attempt in 1..5) {
    $res = PostFn 'agreement-verify' @{ kind = 'svc'; id = $id }
    if ($res.code -eq '200') { $ok = $true; try { $qs = ($res.json | ConvertFrom-Json).qa_status } catch {}; break }
    Log ("  svc {0}/{1} attempt {2} http={3} :: {4}" -f $i, $svcIds.Count, $attempt, $res.code, ($res.json -replace '\s+',' ').Substring(0,[Math]::Min(140,$res.json.Length)))
    Start-Sleep -Seconds 30
  }
  if ($ok) { Log ("svc {0}/{1} OK qa={2} :: {3}" -f $i, $svcIds.Count, $qs, $id) }
  else { Log ("svc {0}/{1} GAVE UP :: {2}" -f $i, $svcIds.Count, $id) }
}

# --- lease exclusives: abstract-verify (property_id, tenant) ---
$j = 0
foreach ($id in $leaseIds) {
  $j++
  $row = $null
  try { $row = Invoke-RestMethod -Uri "$BASE/rest/v1/lease_abstracts?select=tenant_name,property_id&id=eq.$id" -Headers $H -UserAgent $UA -TimeoutSec 60 } catch {}
  if (-not $row -or -not $row[0]) { Log ("lease {0}/{1} LOOKUP FAIL :: {2}" -f $j, $leaseIds.Count, $id); continue }
  $tenant = $row[0].tenant_name; $pid = $row[0].property_id
  $ok = $false; $qs = ''
  foreach ($attempt in 1..5) {
    $res = PostFn 'abstract-verify' @{ property_id = $pid; tenant = $tenant }
    if ($res.code -eq '200') { $ok = $true; try { $qs = ($res.json | ConvertFrom-Json).qa_status } catch {}; break }
    Log ("  lease {0}/{1} attempt {2} http={3} :: {4}" -f $j, $leaseIds.Count, $attempt, $res.code, ($res.json -replace '\s+',' ').Substring(0,[Math]::Min(140,$res.json.Length)))
    Start-Sleep -Seconds 30
  }
  if ($ok) { Log ("lease {0}/{1} OK qa={2} :: {3}" -f $j, $leaseIds.Count, $qs, $tenant) }
  else { Log ("lease {0}/{1} GAVE UP :: {2}" -f $j, $leaseIds.Count, $tenant) }
}
Log 'reverify complete'
