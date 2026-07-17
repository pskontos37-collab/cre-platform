# pilot_ensemble.ps1 - Stage 2 pilot: run abstract-ensemble on the known-hard
# exclusives tenants + Best Buy and print the confidence/disagreement output.
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'; $enc = New-Object System.Text.UTF8Encoding($false)
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }

$targets = @('Club Pilates', 'Old Navy', 'Nordstrom Rack', 'Athlete', 'Barnes & Noble', 'Best Buy')
$rows = Invoke-RestMethod -Uri "$BASE/rest/v1/lease_abstracts?select=tenant_name,property_id" -Headers $H -UserAgent $UA

foreach ($t in $targets) {
  $row = $rows | Where-Object { $_.tenant_name -like "*$t*" } | Select-Object -First 1
  if (-not $row) { Write-Output "== $t :: NOT FOUND"; continue }
  $name = $row.tenant_name
  $tmp = "$PSScriptRoot\_pilot_body.json"
  [System.IO.File]::WriteAllText($tmp, (@{ property_id = $row.property_id; tenant = $name } | ConvertTo-Json -Compress), $enc)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $out = (& curl.exe -s -w "`n%{http_code}" -X POST "$BASE/functions/v1/abstract-ensemble" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -A $UA --data-binary "@$tmp" --max-time 285) -join "`n"
  $sw.Stop()
  $code = ($out -split "`n")[-1]
  $json = if ($out.Length -gt $code.Length) { $out.Substring(0, $out.Length - $code.Length - 1) } else { '' }
  Write-Output ("== {0}  (http {1}, {2}s)" -f $name, $code, [math]::Round($sw.Elapsed.TotalSeconds))
  if ($code -ne '200') { Write-Output ("   ERROR :: " + ($json -replace '\s+', ' ').Substring(0, [Math]::Min(300, $json.Length))); continue }
  try {
    $o = $json | ConvertFrom-Json
    $s = $o.summary
    Write-Output ("   confidence: high={0} medium={1} low={2} | disagreements={3} | lens_errors={4}" -f $s.high, $s.medium, $s.low, $s.disagreements, ($o.lens_errors -join ';'))
    foreach ($d in $o.disagreements) {
      $av = ("" + $d.abstract_value); if ($av.Length -gt 80) { $av = $av.Substring(0, 80) + '...' }
      $cv = ("" + $d.correct_value); if ($cv.Length -gt 80) { $cv = $cv.Substring(0, 80) + '...' }
      Write-Output ("     - {0}: [{1}] stored='{2}' -> correct='{3}' :: {4}" -f $d.field, $d.votes, $av, $cv, $d.citation)
    }
  } catch { Write-Output ("   parse err :: " + $json.Substring(0, [Math]::Min(300, $json.Length))) }
}
Write-Output 'pilot complete'
