param([int]$Limit = 0, [int]$PageBatch = 24, [int]$SegPages = 12)
# Ingest oversized/100+pg PDFs (leases, reports) that fail the local one-shot path.
# Upload each to Supabase Storage, then call the pdf-extract edge fn in PAGE BATCHES:
#   batch 1 (pages 1..PageBatch)      -> ?store=1 ... creates ONE documents row, returns its id + page_count
#   batch n (pages ..)                -> ?appendDocId=<id> ... appends chunks + merges notes into that row
# Each request processes only PageBatch pages (segmented into SegPages-page Claude calls), so no
# single request hits Supabase's ~150s edge idle timeout or OOMs the worker on image-heavy scans
# (the old single-request-per-doc path failed 200+pp / 10-22MB docs). engine=mu forces the
# low-memory MuPDF engine. Idempotent via documents.file_path ('file:'+local path); a doc whose
# later batch fails is rolled back (row+chunks deleted) so a re-run retries it cleanly.
# Env: SPLIT_LIST (file of local paths), INGEST_PID (property uuid).
$ErrorActionPreference = "Stop"
$repo = "C:\Users\pskontos\Desktop\Software\cre-platform"
$cfg = @{}; foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match "=" })) { $k,$v = $l -split '=',2; $cfg[$k.Trim()]=$v.Trim() }
$BASE=$cfg['VITE_SUPABASE_URL']; $KEY=$cfg['SUPABASE_SECRET_KEY']
$LIST=$env:SPLIT_LIST; $PID2=$env:INGEST_PID
if(-not $LIST -or -not $PID2){ throw "Set `$env:SPLIT_LIST and `$env:INGEST_PID" }
$MODEL = if($env:SPLIT_MODEL){ $env:SPLIT_MODEL } else { "claude-haiku-4-5-20251001" }
$SP = if($env:INGEST_SP -and (Test-Path -LiteralPath $env:INGEST_SP)){ $env:INGEST_SP } else { "C:\Users\pskontos\AppData\Local\cre-ingest" }
if(-not (Test-Path -LiteralPath $SP)){ New-Item -ItemType Directory -Force -Path $SP | Out-Null }
$log="$SP\split_ingest.log"
$tmp="$SP\_split_tmp_$PID.pdf"   # per-process (PID) temp so concurrent runs don't collide
$BUCKET="lease-ingest"
function Log($m){ $line="$(Get-Date -Format HH:mm:ss) $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }

# done-set (corpus file: paths already ingested)
$done = New-Object System.Collections.Generic.HashSet[string]
$off=0
while($true){
  $r = & curl.exe -s "$BASE/rest/v1/documents?select=file_path&file_path=like.file:*" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Range: $off-$($off+999)"
  $arr = $r | ConvertFrom-Json; if(-not $arr){break}
  foreach($d in $arr){ if($d.file_path){[void]$done.Add($d.file_path)} }
  if($arr.Count -lt 1000){break}; $off+=1000
}
$paths = Get-Content -LiteralPath $LIST | Where-Object { $_ }
Log "split-ingest: $($paths.Count) files; done-set=$($done.Count); pid=$PID2; pageBatch=$PageBatch segPages=$SegPages model=$MODEL"

# POST a pdf-extract call and return the parsed object (or $null on transport failure).
function Extract($qs){
  $u = "$BASE/functions/v1/pdf-extract?$qs"
  $resp = & curl.exe -s -X POST $u -H "apikey: $KEY" -H "Authorization: Bearer $KEY" --max-time 200
  try { return ($resp | ConvertFrom-Json) } catch { return [pscustomobject]@{ success=$false; error=("unparseable: " + ($resp -replace '\s+',' ')) } }
}
function DelDoc($docId){
  & curl.exe -s -X DELETE "$BASE/rest/v1/document_chunks?document_id=eq.$docId" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" | Out-Null
  & curl.exe -s -X DELETE "$BASE/rest/v1/documents?id=eq.$docId" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" | Out-Null
}

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
    $up = & curl.exe -s -X POST "$BASE/storage/v1/object/$BUCKET/$objkey" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "x-upsert: true" -H "Content-Type: application/pdf" --data-binary "@$tmp" -w "HTTP%{http_code}"
    if($up -notmatch 'HTTP200'){ $fail++; Log "FAIL upload ($mb MB) $name :: $up"; continue }
    $enc=[uri]::EscapeDataString($fp)
    $common = "storagePath=$BUCKET/$objkey&model=$MODEL&engine=mu&segPages=$SegPages"
    # batch 1: create the row for pages 1..PageBatch
    $o1 = Extract "store=1&$common&propertyId=$PID2&filePath=$enc&pageStart=1&pageEnd=$PageBatch"
    if(-not $o1.success -or -not $o1.stored_document_id){
      & curl.exe -s -X DELETE "$BASE/storage/v1/object/$BUCKET/$objkey" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" | Out-Null
      $fail++; $err = if($o1.error){ ($o1.error -replace '\s+',' ') } else { 'no doc id' }; if($err.Length -gt 200){$err=$err.Substring(0,200)}
      Log "FAIL batch1 ($mb MB) $name :: $err"; continue
    }
    $docId = $o1.stored_document_id; $pg = [int]$o1.page_count
    # batches 2..N: append the remaining pages into the same row
    $partial = $false
    for($s = $PageBatch + 1; $s -le $pg; $s += $PageBatch){
      $e = [math]::Min($s + $PageBatch - 1, $pg)
      $o2 = Extract "appendDocId=$docId&$common&pageStart=$s&pageEnd=$e"
      if(-not $o2.success){
        $partial = $true; $err2 = if($o2.error){ ($o2.error -replace '\s+',' ') } else { 'append failed' }; if($err2.Length -gt 200){$err2=$err2.Substring(0,200)}
        Log "FAIL append pp$s-$e ($mb MB) $name :: $err2"; break
      }
    }
    & curl.exe -s -X DELETE "$BASE/storage/v1/object/$BUCKET/$objkey" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" | Out-Null
    if($partial){ DelDoc $docId; $fail++; Log "ROLLBACK $name (a batch failed; row+chunks deleted so re-run retries)"; continue }
    [void]$done.Add($fp)   # so a duplicate path later in the list is skipped
    $ok++; Log "OK ($mb MB, ${pg}pg, $([math]::Ceiling($pg / [double]$PageBatch)) batches) $name -> $docId"
  } catch { $fail++; Log "FAIL $name :: $($_.Exception.Message)" }
  if($Limit -gt 0 -and ($ok+$fail) -ge $Limit){ Log "hit Limit=$Limit"; break }
}
Log "DONE split-ingest: ok=$ok skip=$skip fail=$fail"
