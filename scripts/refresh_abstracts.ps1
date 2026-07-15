# refresh_abstracts.ps1 - LIVING ABSTRACTS. Detects documents ingested in the last
# -SinceDays that belong to a tenant with an existing abstract, then:
#   locked abstract   -> log 'locked_needs_review' (human decides; never clobbered)
#   unlocked abstract -> regenerate + verify, DIFF the high-value fields vs the
#                        prior abstract, log the change set (material=true if any
#                        high-value field moved). AbstractsPage shows unseen entries.
# Chain this AFTER the nightly document sync (Task Scheduler):
#   schtasks /Create /SC DAILY /ST 03:30 /TN "CRE refresh abstracts" /TR
#     "powershell -NoProfile -File C:\...\scripts\refresh_abstracts.ps1"
# Resumable/idempotent per run; safe to re-run (regen+verify are idempotent).
param([int]$SinceDays = 2)
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$amp = [char]38
$log = "$PSScriptRoot\refresh_abstracts.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }
$enc = New-Object System.Text.UTF8Encoding($false)

function PostFn($slug, $bodyObj) {
  $body = $bodyObj | ConvertTo-Json -Compress -Depth 6
  $tmp = "$PSScriptRoot\_refresh_body.json"
  [System.IO.File]::WriteAllText($tmp, $body, $enc)
  # -join: PS captures multi-line native output as an ARRAY; without joining,
  # $out.Length is the element count and the json extraction silently fails.
  $out = (& curl.exe -s -w "`n%{http_code}" -X POST "$BASE/functions/v1/$slug" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -A $UA --data-binary "@$tmp" --max-time 295) -join "`n"
  $code = ($out -split "`n")[-1]
  $json = if ($out.Length -gt $code.Length) { $out.Substring(0, $out.Length - $code.Length - 1) } else { '' }
  return @{ code = $code; json = $json }
}
function RestGet($path) { Invoke-RestMethod -Uri "$BASE/rest/v1/$path" -Headers $H -UserAgent $UA -TimeoutSec 90 }
function RestPost($path, $bodyObj) {
  $body = $bodyObj | ConvertTo-Json -Compress -Depth 8
  $tmp = "$PSScriptRoot\_refresh_ins.json"
  [System.IO.File]::WriteAllText($tmp, $body, $enc)
  & curl.exe -s -o NUL -X POST -A $UA -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -H 'Prefer: return=minimal' --data-binary "@$tmp" "$BASE/rest/v1/$path" | Out-Null
}

# High-value fields to diff (mirrors AbstractsPage REVIEW_FIELDS + schedule size).
$FIELDS = @('trade_name','tenant_legal_name','suite','square_footage')
function GetPath($obj, $path) { $o = $obj; foreach ($k in $path -split '\.') { if ($null -eq $o) { return $null }; $o = $o.$k }; return $o }
function Snapshot($abs) {
  $s = @{}
  foreach ($f in $FIELDS) { $s[$f] = [string](GetPath $abs $f) }
  $s['term.rent_commencement'] = [string](GetPath $abs 'term.rent_commencement')
  $s['term.expiration']        = [string](GetPath $abs 'term.expiration')
  $s['term.term_years']        = [string](GetPath $abs 'term.term_years')
  $s['rent_rows']              = [string](@(GetPath $abs 'base_rent_schedule').Count)
  return $s
}

$since = (Get-Date).ToUniversalTime().AddDays(-$SinceDays).ToString('yyyy-MM-ddTHH:mm:ssZ')
Log "scan: documents created since $since"

# Recent docs at properties that have abstracts.
$docs = RestGet ("documents?select=id,title,file_name,file_path,property_id" + $amp + "created_at=gte.$since" + $amp + "property_id=not.is.null" + $amp + "limit=1000")
if (-not $docs) { Log 'no new documents - done'; exit 0 }
$props = @($docs | Select-Object -ExpandProperty property_id -Unique)
$inList = ($props -join ',')
$abstracts = RestGet ("lease_abstracts?select=property_id,tenant_name,locked,abstract" + $amp + "property_id=in.($inList)")
Log ("{0} new docs across {1} properties; {2} abstracts in scope" -f @($docs).Count, $props.Count, @($abstracts).Count)

$refreshed = 0
foreach ($a in $abstracts) {
  # match: tenant name appears (case-insensitive) in a new doc's title/file_path
  $needle = ($a.tenant_name -replace "[#\d]+$", '').Trim()
  if ($needle.Length -lt 3) { continue }
  $hit = $docs | Where-Object { $_.property_id -eq $a.property_id -and (("$($_.title) $($_.file_path) $($_.file_name)") -match [regex]::Escape($needle)) } | Select-Object -First 1
  if (-not $hit) { continue }

  if ($a.locked) {
    RestPost 'abstract_refresh_log' @{ property_id = $a.property_id; tenant_name = $a.tenant_name; document_id = $hit.id; doc_title = ("$($hit.title)").Substring(0, [Math]::Min(200, ("$($hit.title)").Length)); action = 'locked_needs_review'; material = $true }
    Log ("LOCKED needs review :: {0} (new doc: {1})" -f $a.tenant_name, $hit.file_name)
    continue
  }

  $before = Snapshot $a.abstract
  # Stage 1: brief the NEW document first (100%-of-text extraction) so the
  # regeneration synthesizes from full coverage, not the raw-text fallback.
  # Resumable: giant docs return done=false -> call again (max 15 rounds).
  $bDone = $false; $bGuard = 0
  while (-not $bDone -and $bGuard -lt 15) {
    $bGuard++
    $b = PostFn 'doc-brief' @{ document_id = $hit.id }
    if ($b.code -ne '200') { Log ("  brief FAIL http={0} (non-fatal, raw-text fallback) :: {1}" -f $b.code, $hit.file_name); break }
    try { $bDone = (($b.json | ConvertFrom-Json).done -ne $false) } catch { $bDone = $true }
  }
  $g = PostFn 'lease-abstract' @{ property_id = $a.property_id; tenant = $a.tenant_name }
  if ($g.code -ne '200') {
    RestPost 'abstract_refresh_log' @{ property_id = $a.property_id; tenant_name = $a.tenant_name; document_id = $hit.id; doc_title = "$($hit.title)"; action = 'regen_failed' }
    Log ("REGEN FAIL http={0} :: {1}" -f $g.code, $a.tenant_name); continue
  }
  $v = PostFn 'abstract-verify' @{ property_id = $a.property_id; tenant = $a.tenant_name }
  $qs = ''; try { $qs = ($v.json | ConvertFrom-Json).qa_status } catch {}

  $encName = [uri]::EscapeDataString($a.tenant_name)
  $newRow = RestGet ("lease_abstracts?select=abstract" + $amp + "property_id=eq.$($a.property_id)" + $amp + "tenant_name=eq.$encName")
  $after = Snapshot $newRow[0].abstract
  $changes = @{}
  foreach ($k in $before.Keys) { if ($before[$k] -ne $after[$k]) { $changes[$k] = @{ old = $before[$k]; new = $after[$k] } } }
  RestPost 'abstract_refresh_log' @{
    property_id = $a.property_id; tenant_name = $a.tenant_name; document_id = $hit.id
    doc_title = ("$($hit.title)").Substring(0, [Math]::Min(200, ("$($hit.title)").Length))
    action = 'regenerated'; qa_status = $qs; changes = $changes; material = ($changes.Count -gt 0)
  }
  $refreshed++
  Log ("REFRESHED {0} -> qa={1}, {2} field change(s)" -f $a.tenant_name, $qs, $changes.Count)
}
Log "refresh complete: $refreshed regenerated"
