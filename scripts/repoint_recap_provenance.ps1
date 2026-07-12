# repoint_recap_provenance.ps1
# One-shot, self-cleaning job. The two Magnolia recap amendments (First + Second
# Amendment to the Magnolia Park Greenville Venture LLC Agreement) were ingested
# from the user's Desktop; they are JV/entity docs and will be filed into
# V:\ENTITY DOCS (NOT ACQ-REFI-DISP). Once filed, re-point documents.file_path
# from the Desktop path to the V: path so provenance points at the file room.
#
# Robust to renaming: matches a filed PDF by EXACT BYTE SIZE (a name keyword only
# breaks ties), so it works even if the file is renamed to the ENTITY DOCS
# convention. Idempotent (skips docs already re-pointed). Unregisters its own
# scheduled task once BOTH are done, and gives up (logs + unregisters) after the
# cutoff so it never lingers. Uses the .env service key — no MCP / LLM needed.
$ErrorActionPreference = 'Continue'
$repo = 'C:\Users\pskontos\Desktop\Software\cre-platform'
$cfg = @{}; foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k,$v = $l -split '=',2; $cfg[$k.Trim()]=$v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$ROOT = '\\192.168.220.121\virtual_file_room\ENTITY DOCS'
$TASK = 'CRE Platform - Repoint Recap Provenance'
$CUTOFF = [datetime]'2026-07-16'                 # give up after ~1 week
$log = "$repo\scripts\repoint_recap.log"
$enc = New-Object System.Text.UTF8Encoding($false)
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m" | Out-File $log -Append -Encoding utf8 }

# doc id + exact byte size of the Desktop originals (from ingest manifest)
$targets = @(
  @{ id = 'bad2f4b7-80e5-4fd6-bc0a-e1e5a66c8fbe'; size = 330393; label = 'First Amendment' },
  @{ id = 'c03668c5-7e66-4a21-8f7c-30d4a6f3b932'; size = 473599; label = 'Second Amendment' }
)

function DocPath($id) {
  $r = & curl.exe -s "$BASE/rest/v1/documents?id=eq.$id&select=file_path" -H "apikey: $KEY" -H "Authorization: Bearer $KEY"
  return ($r | ConvertFrom-Json)[0].file_path
}

if (-not (Test-Path -LiteralPath $ROOT)) { Log "ENTITY DOCS not reachable ($ROOT) — will retry."; return }

# Enumerate ENTITY DOCS PDFs once; match per target by size.
$all = Get-ChildItem -LiteralPath $ROOT -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -ieq '.pdf' }
$done = 0; $pending = 0
foreach ($t in $targets) {
  $fp = DocPath $t.id
  if ($fp -and $fp -notmatch '(?i)desktop') { $done++; Log "$($t.label): already re-pointed ($fp)"; continue }
  $m = @($all | Where-Object { $_.Length -eq $t.size })
  if ($m.Count -gt 1) { $m = @($m | Where-Object { $_.Name -match '(?i)venture|magnolia|amendment|amd|greenville' }) }
  $hit = $m | Select-Object -First 1
  if (-not $hit) { $pending++; Log "$($t.label): not yet filed (no $($t.size)-byte PDF under ENTITY DOCS)"; continue }
  $newfp = 'file:' + $hit.FullName
  $body = @{ file_path = $newfp } | ConvertTo-Json -Compress
  $tmp = "$env:TEMP\_repoint_$($t.id).json"; [System.IO.File]::WriteAllText($tmp, $body, $enc)
  $wr = & curl.exe -s -X PATCH "$BASE/rest/v1/documents?id=eq.$($t.id)" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Prefer: return=representation" --data-binary "@$tmp"
  if ($wr -match [regex]::Escape($hit.FullName.Replace('\','\\'))) { $done++; Log "$($t.label): re-pointed -> $newfp" }
  elseif ($wr -match '"file_path"') { $done++; Log "$($t.label): re-pointed (path echoed) -> $newfp" }
  else { $pending++; Log "$($t.label): PATCH may have failed :: $wr" }
}

if ($done -ge $targets.Count) {
  Log "DONE: all $($targets.Count) re-pointed. Unregistering scheduled task."
  Unregister-ScheduledTask -TaskName $TASK -Confirm:$false -ErrorAction SilentlyContinue
} elseif ((Get-Date) -gt $CUTOFF) {
  Log "CUTOFF passed with $pending still pending. Giving up + unregistering — re-point manually."
  Unregister-ScheduledTask -TaskName $TASK -Confirm:$false -ErrorAction SilentlyContinue
} else {
  Log "progress: done=$done pending=$pending — will retry next run."
}
