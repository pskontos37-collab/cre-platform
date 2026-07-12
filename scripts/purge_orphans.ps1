# purge_orphans.ps1  (ASCII only - PS 5.1)
# Deletes storage objects under forms/help/lib/ that are NO LONGER referenced by
# the current helpResources.json (property-specific files removed in the cleanup,
# plus stale keys from earlier generator runs). SAFETY: only ever touches the
# forms/help/lib/ prefix, and never a key that appears in the live JSON. Other
# storage (forms/inspection/, forms/help/<curated>, property docs) is untouched.
# Dry-run by default; pass -Execute to actually delete.

param([switch]$Execute)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$json = Join-Path $repoRoot 'src\lib\helpResources.json'
$envMap=@{}; Get-Content (Join-Path $repoRoot '.env') | ForEach-Object { if($_ -match '^\s*([^#=]+)=(.*)$'){$envMap[$matches[1].Trim()]=$matches[2].Trim()} }
$baseUrl=$envMap['VITE_SUPABASE_URL']; $svc=$envMap['SUPABASE_SERVICE_JWT']
$H=@{ Authorization = "Bearer $svc" }
$PREFIX='forms/help/lib/'

# 1) keep-set: every key referenced by the live library JSON
$keep=@{}
$j = Get-Content $json -Raw -Encoding UTF8 | ConvertFrom-Json
foreach($c in $j.collections){ foreach($g in $c.groups){ foreach($it in $g.items){ if($it.key){ $keep[$it.key]=$true } } } }
Write-Host ("Keys referenced by live JSON: {0}" -f $keep.Count)

# 2) list every object under forms/help/lib/ (paginated)
$all=New-Object System.Collections.ArrayList
$offset=0
do {
  $body = @{ prefix=$PREFIX; limit=1000; offset=$offset; sortBy=@{column='name';order='asc'} } | ConvertTo-Json
  $resp = Invoke-RestMethod -Method Post -Uri "$baseUrl/storage/v1/object/list/documents" -Headers $H -ContentType 'application/json' -Body $body
  $batch = @($resp)
  foreach($o in $batch){ if($o.name){ [void]$all.Add($PREFIX + $o.name) } }
  $offset += 1000
} while ($batch.Count -eq 1000)
Write-Host ("Objects in storage under {0}: {1}" -f $PREFIX, $all.Count)

# 3) orphans = in storage but not referenced
$orphans = @($all | Where-Object { -not $keep.ContainsKey($_) })
# hard safety: never touch anything outside the lib prefix or anything kept
$orphans = @($orphans | Where-Object { $_.StartsWith($PREFIX) -and -not $keep.ContainsKey($_) })
Write-Host ("ORPHANS to delete: {0}" -f $orphans.Count)
$orphans | Select-Object -First 8 | ForEach-Object { Write-Host ("   {0}" -f $_) }

if (-not $Execute) { Write-Host "`nDRY RUN - nothing deleted. Re-run with -Execute to purge."; return }
if ($orphans.Count -eq 0) { Write-Host 'Nothing to delete.'; return }

# 4) delete in batches of 100 via the storage remove API
$del=0
for ($i=0; $i -lt $orphans.Count; $i += 100) {
  $slice = $orphans[$i..([Math]::Min($i+99,$orphans.Count-1))]
  $body = @{ prefixes = $slice } | ConvertTo-Json
  Invoke-RestMethod -Method Delete -Uri "$baseUrl/storage/v1/object/documents" -Headers $H -ContentType 'application/json' -Body $body | Out-Null
  $del += $slice.Count
  Write-Host ("  deleted {0}/{1}" -f $del, $orphans.Count)
}
Write-Host ("PURGE DONE: removed {0} orphaned objects." -f $del)
