param([int]$Limit = 0)
# Ingest oversized/100+pg PDFs (leases) that fail the local one-shot path: upload each to
# Supabase Storage, call the pdf-extract edge fn (which splits via MuPDF + extracts + embeds),
# then delete the temp object. Idempotent via documents.file_path ('file:'+local path).
# Env: SPLIT_LIST (file of local paths), INGEST_PID (property uuid).
$ErrorActionPreference = "Stop"
$repo = "C:\Users\pskontos\Desktop\Software\cre-platform"
$cfg = @{}; foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match "=" })) { $k,$v = $l -split '=',2; $cfg[$k.Trim()]=$v.Trim() }
$BASE=$cfg['VITE_SUPABASE_URL']; $KEY=$cfg['SUPABASE_SECRET_KEY']
$LIST=$env:SPLIT_LIST; $PID2=$env:INGEST_PID
if(-not $LIST -or -not $PID2){ throw "Set `$env:SPLIT_LIST and `$env:INGEST_PID" }
$SP="C:\Users\pskontos\AppData\Local\Temp\claude\C--Users-pskontos-Desktop-Software\4813eb50-3027-4b15-81ea-2a63a5f0357b\scratchpad"
$log="$SP\split_ingest.log"
$tmp="$SP\_split_tmp_$PID.pdf"   # per-process (PID) temp so concurrent runs don't collide
$BUCKET="lease-ingest"
function Log($m){ $line="$(Get-Date -Format HH:mm:ss) $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }

# done-set
$done = New-Object System.Collections.Generic.HashSet[string]
$off=0
while($true){
  $r = & curl.exe -s "$BASE/rest/v1/documents?select=file_path&file_path=like.file:*" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Range: $off-$($off+999)"
  $arr = $r | ConvertFrom-Json; if(-not $arr){break}
  foreach($d in $arr){ if($d.file_path){[void]$done.Add($d.file_path)} }
  if($arr.Count -lt 1000){break}; $off+=1000
}
$paths = Get-Content -LiteralPath $LIST | Where-Object { $_ }
Log "split-ingest: $($paths.Count) files; done-set=$($done.Count); pid=$PID2"
$i=-1; $ok=0; $skip=0; $fail=0
foreach($p in $paths){
  $i++
  $fp = "file:" + $p
  if($done.Contains($fp)){ $skip++; continue }
  if(-not (Test-Path -LiteralPath $p)){ $fail++; Log "FAIL (missing) $p"; continue }
  $name = ($p -split '\\')[-1]
  $objkey = "tmp/gw$i.pdf"
  try {
    Copy-Item -LiteralPath $p -Destination $tmp -Force
    $mb = [math]::Round((Get-Item $tmp).Length/1MB,1)
    # upload (upsert)
    $up = & curl.exe -s -X POST "$BASE/storage/v1/object/$BUCKET/$objkey" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "x-upsert: true" -H "Content-Type: application/pdf" --data-binary "@$tmp" -w "HTTP%{http_code}"
    if($up -notmatch 'HTTP200'){ $fail++; Log "FAIL upload ($mb MB) $name :: $up"; continue }
    # call edge fn (splits + extracts + embeds + stores)
    $enc=[uri]::EscapeDataString($fp)
    $u = "$BASE/functions/v1/pdf-extract?store=1&storagePath=$BUCKET/$objkey&propertyId=$PID2&filePath=$enc&model=claude-haiku-4-5-20251001"
    $resp = & curl.exe -s -X POST $u -H "apikey: $KEY" -H "Authorization: Bearer $KEY" --max-time 600
    & curl.exe -s -X DELETE "$BASE/storage/v1/object/$BUCKET/$objkey" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" | Out-Null
    if($resp -match '"success"\s*:\s*true'){
      $pg = if($resp -match '"page_count":\s*(\d+)'){$matches[1]}else{'?'}
      $seg= if($resp -match '"segments":\s*(\d+)'){$matches[1]}else{'?'}
      $ch = if($resp -match '"embedded_chunks":\s*(\d+)'){$matches[1]}else{'?'}
      $ok++; Log "OK ($mb MB, ${pg}pg -> $seg seg, $ch chunks) $name"
    } else {
      $fail++; $err = if($resp.Length -gt 200){$resp.Substring(0,200)}else{$resp}; Log "FAIL extract ($mb MB) $name :: $err"
    }
  } catch { $fail++; Log "FAIL $name :: $($_.Exception.Message)" }
  if($Limit -gt 0 -and ($ok+$fail) -ge $Limit){ Log "hit Limit=$Limit"; break }
}
Log "DONE split-ingest: ok=$ok skip=$skip fail=$fail"
