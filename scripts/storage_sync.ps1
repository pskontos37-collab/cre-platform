# storage_sync.ps1 - mirrors corpus source files into Supabase Storage (bucket: documents).
# Two phases each run:
#   1. NEW:     documents rows with storage_path null  -> upload file, set storage_path/file_mtime/file_size_bytes
#   2. CHANGED: rows with storage_path set             -> if disk size/mtime differs, re-upload (x-upsert)
# Resumable and idempotent. Designed for Task Scheduler (nightly) + ad-hoc backfill runs.
# Requires an on-network machine (V:/K: reachable). Skips: missing files, >48MB, piece-fragment paths (#pages).
param(
  [int]$MaxNew = 100000,        # cap new uploads per run (0 = unlimited within timeout)
  [switch]$SkipChanged          # backfill mode: only phase 1
)
$ErrorActionPreference='Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg=@{}; foreach($l in (Get-Content "$repo\.env" | Where-Object {$_ -match "="})){ $k,$v=$l -split '=',2; $cfg[$k.Trim()]=$v.Trim() }
$BASE=$cfg['VITE_SUPABASE_URL']; $KEY=$cfg['SUPABASE_SECRET_KEY']
# Storage endpoints intermittently reject sb_secret_ keys ("Invalid Compact JWS") —
# use the classic service-role JWT for storage; PostgREST keeps working on sb_secret.
$SKEY = if($cfg['SUPABASE_SERVICE_JWT']){ $cfg['SUPABASE_SERVICE_JWT'] } else { $KEY }
$H=@{ apikey=$KEY; Authorization="Bearer $KEY" }
$UA='cre-loader/1.0'
$log = "$PSScriptRoot\storage_sync.log"
function Log($m){ $line="$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }

function SbGet($path){ Invoke-RestMethod -Method Get -Uri "$BASE/rest/v1/$path" -Headers $H -UserAgent $UA -TimeoutSec 120 }
function SbPatch($path,$obj){
  $h2=@{ apikey=$KEY; Authorization="Bearer $KEY"; Prefer='return=representation' }
  $r=Invoke-RestMethod -Method Patch -Uri "$BASE/rest/v1/$path" -Headers $h2 -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $obj -Compress))) -UserAgent $UA -TimeoutSec 120
  return ($r -ne $null)
}

function DiskPath($filePath){
  if(-not $filePath -or -not $filePath.StartsWith('file:')){ return $null }
  $p = $filePath.Substring(5)
  if($p -match '#pages'){ return $null }   # fragment of a split giant - parent too large; pieces are separate rows
  return $p
}
function ContentType($name){
  switch -regex ($name) {
    '\.pdf$'  { 'application/pdf'; break }
    '\.xlsx?$'{ 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; break }
    '\.docx?$'{ 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'; break }
    '\.msg$'  { 'application/vnd.ms-outlook'; break }
    default   { 'application/octet-stream' }
  }
}
function Upload($doc, $disk, $upsert){
  $fi = Get-Item -LiteralPath $disk -ErrorAction SilentlyContinue
  if(-not $fi){ return @{status='missing'} }
  if($fi.Length -gt 48MB){ return @{status='toolarge'; size=$fi.Length} }
  $ext = [IO.Path]::GetExtension($fi.Name); if(-not $ext){ $ext='.bin' }
  # objKey, NOT $key: PowerShell is case-insensitive and dynamically scoped — a local
  # named $key would shadow the script-level $KEY (API key) inside callees like SbPatch.
  $objKey = "p/" + $doc.property_id + "/" + $doc.id + $ext.ToLower()
  $ct = ContentType $fi.Name
  # NOTE: args are inline — never build a curl arg list in a variable named $args
  # ($args is PowerShell's automatic parameter array inside functions; assignment is ignored).
  $code = $null
  for($try=1; $try -le 3; $try++){
    $code = & curl.exe -s -o NUL -w '%{http_code}' -X POST "$BASE/storage/v1/object/documents/$objKey" -H "Authorization: Bearer $SKEY" -H "apikey: $SKEY" -H "Content-Type: $ct" -H "x-upsert: true" --data-binary "@$disk"
    if("$code" -match '^2'){ break }
    Start-Sleep -Seconds ([Math]::Min(5, $try * 2))
  }
  if("$code" -notmatch '^2'){ return @{status="http$code"} }
  $ok = SbPatch ("documents?id=eq." + $doc.id) @{ storage_path=$objKey; file_size_bytes=$fi.Length; file_mtime=$fi.LastWriteTimeUtc.ToString('o') }
  if(-not $ok){ return @{status='patchfail'} }
  return @{status='ok'; key=$objKey}
}

# ---- Phase 1: upload NEW (storage_path null) ----
$new=0;$missing=0;$big=0;$err=0
$offset=0
while($true){
  $batch = SbGet ("documents?select=id,property_id,file_path,file_name&storage_path=is.null&file_path=like.file:*&order=id&limit=200&offset=0")
  if(-not $batch -or $batch.Count -eq 0){ break }
  $progress=$false
  foreach($d in $batch){
    if($MaxNew -gt 0 -and $new -ge $MaxNew){ break }
    $disk = DiskPath $d.file_path
    if(-not $disk){ [void](SbPatch ("documents?id=eq." + $d.id) @{ storage_path='(fragment)' }); continue }
    $r = Upload $d $disk $true
    switch($r.status){
      'ok'       { $new++; $progress=$true }
      'missing'  { $missing++; [void](SbPatch ("documents?id=eq." + $d.id) @{ storage_path='(missing)' }) }
      'toolarge' { $big++;     [void](SbPatch ("documents?id=eq." + $d.id) @{ storage_path='(toolarge)' }) }
      default    { $err++; if($err -le 3){ Log ("upload error " + $r.status + " :: " + $d.file_path) } }
    }
    if((($new + $missing + $big + $err) % 25) -eq 0){ Log ("progress: new=$new missing=$missing toolarge=$big err=$err") }
  }
  if($MaxNew -gt 0 -and $new -ge $MaxNew){ break }
  if(-not $progress -and $batch.Count -gt 0 -and $err -gt 50){ Log "aborting phase1: repeated errors"; break }
  if($batch.Count -lt 200 -and -not $progress){ break }
}
Log ("phase1 NEW: uploaded=$new missing=$missing toolarge=$big errors=$err")

# ---- Phase 2: re-upload CHANGED ----
if(-not $SkipChanged){
  $chg=0;$checked=0
  $offset=0
  while($true){
    $batch = SbGet ("documents?select=id,property_id,file_path,storage_path,file_size_bytes,file_mtime&storage_path=like.p/*&file_path=like.file:*&order=id&limit=1000&offset=$offset")
    if(-not $batch -or $batch.Count -eq 0){ break }
    foreach($d in $batch){
      $checked++
      $disk = DiskPath $d.file_path
      if(-not $disk){ continue }
      $fi = Get-Item -LiteralPath $disk -ErrorAction SilentlyContinue
      if(-not $fi){ continue }
      $storedSize = if($d.file_size_bytes){ [long]$d.file_size_bytes } else { -1 }
      # Parse the stored mtime as an INSTANT. A plain [datetime] cast localizes the offset
      # timestamp to Local kind, and -gt then compares raw ticks without normalizing zones,
      # so every US-timezone file reads ~5-6h "newer" than disk and re-uploads every night.
      # [datetimeoffset].UtcDateTime yields a Utc-kind value comparable to LastWriteTimeUtc.
      $storedMt = if($d.file_mtime){ ([datetimeoffset]$d.file_mtime).UtcDateTime } else { [datetime]::SpecifyKind([datetime]'2000-01-01',[DateTimeKind]::Utc) }
      if($fi.Length -ne $storedSize -or $fi.LastWriteTimeUtc -gt $storedMt.AddSeconds(2)){
        $r = Upload $d $disk $true
        if($r.status -eq 'ok'){ $chg++; Log ("re-uploaded (changed): " + $d.file_path) }
      }
    }
    if($batch.Count -lt 1000){ break }
    $offset += 1000
  }
  Log ("phase2 CHANGED: checked=$checked re-uploaded=$chg")
}
Log "storage_sync complete"