# ingest_batch_ingest.ps1 - PHASE B of the Anthropic Message Batches ingest.
#
# Polls the batches submitted by ingest_batch_submit.ps1 and, as each one ENDS,
# runs the SAME downstream as ingest_local_docs.ps1 (Voyage embed + documents /
# document_chunks inserts) keyed back to each file by custom_id. Idempotent and
# resumable: re-runnable any number of times; already-ingested files are skipped
# and completed batches are not re-processed.
#
#   .\ingest_batch_ingest.ps1                 # poll every 60s until all batches end, ingesting as they finish
#   .\ingest_batch_ingest.ps1 -Once           # single pass: ingest whatever has ended, then exit
#   .\ingest_batch_ingest.ps1 -StateDir <dir> # match the submit run's state dir
param(
  [int]$PollSeconds = 60,
  [double]$MaxHours = 26,                                # Batches SLA is 24h; give a little margin
  [switch]$Once,
  [string]$Model = "claude-haiku-4-5-20251001",
  [string]$StateDir = ''
)
$ErrorActionPreference = "Stop"
$repo = "C:\Users\pskontos\Desktop\Software\cre-platform"
$cfg = @{}; foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match "=" })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']; $AK = $cfg['ANTHROPIC_API_KEY']
$VOYAGE_KEY = $cfg['VOYAGE_API_KEY']; $VOYAGE_MODEL = if ($cfg['VOYAGE_MODEL']) { $cfg['VOYAGE_MODEL'] } else { 'voyage-3-large' }
$SP = if ($env:INGEST_SP -and (Test-Path -LiteralPath $env:INGEST_SP)) { $env:INGEST_SP } else { "C:\Users\pskontos\AppData\Local\cre-ingest" }
$STATE = if ($StateDir) { $StateDir } else { "$SP\batch_state" }
if (-not (Test-Path -LiteralPath $STATE)) { throw "No batch-state dir at $STATE - run ingest_batch_submit.ps1 first" }
$BatchFile = "$STATE\batches.jsonl"; $MapFile = "$STATE\map.jsonl"   # NOT $BATCHES/$MAP - PS is case-insensitive; the $batches array / $map hashtable below would shadow them
$DEAD = "$SP\ingest_deadletter.txt"; $GIANTS = "$SP\giants_to_split.txt"
$log = "$STATE\ingest.log"
$enc = New-Object System.Text.UTF8Encoding($false)
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [ingest] $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }

# -- downstream helpers (IDENTICAL to ingest_local_docs.ps1) --
function ToDocType($t) { switch ("$t") { 'lease' { 'lease' } 'amendment' { 'lease' } 'estoppel' { 'estoppel' } default { 'other' } } }
function Blob($x) { $a = { param($v) if ($v -is [array]) { $v } else { @() } }
  $kd = (& $a $x.key_dates | ForEach-Object { "$($_.label): $($_.date)" }) -join '; '
  @($x.summary, $x.doc_type, $x.sub_type, $x.property, $x.tenant, ((& $a $x.counterparties) -join ', '),
    $x.base_rent_summary, $x.percentage_rent, $x.recovery_method, $x.co_tenancy, $x.exclusive_use,
    ((& $a $x.options) -join '; '), $kd) | Where-Object { $_ } | ForEach-Object { "$_" } | Out-String
}
function Post($table, $obj, $prefer) {
  $body = '[' + (ConvertTo-Json -InputObject $obj -Depth 8 -Compress) + ']'
  $tmp = "$STATE\_doc_post.json"; [System.IO.File]::WriteAllText($tmp, $body, $enc)
  $resp = & curl.exe -s -X POST "$BASE/rest/v1/$table" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Prefer: $prefer" --data-binary "@$tmp"
  if ($resp -match '"code"' -and $resp -match '"message"') { throw "POST $table failed: $resp" }
  return $resp
}

# -- load the custom_id -> file map --
$map = @{}
if (-not (Test-Path -LiteralPath $MapFile)) { throw "No map at $MapFile" }
foreach ($l in (Get-Content -LiteralPath $MapFile)) { if ($l) { try { $o = $l | ConvertFrom-Json; if ($o.custom_id) { $map[$o.custom_id] = $o } } catch {} } }
Log "loaded custom_id map: $($map.Count) docs"

# -- done-set (skip already-ingested; keeps ingest idempotent across re-runs) --
$done = New-Object System.Collections.Generic.HashSet[string]
$off = 0
while ($true) {
  $r = & curl.exe -s "$BASE/rest/v1/documents?select=file_path&file_path=like.file:*" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Range: $off-$($off+999)"
  $arr = $r | ConvertFrom-Json; if (-not $arr) { break }
  foreach ($d in $arr) { if ($d.file_path) { [void]$done.Add($d.file_path) } }
  if ($arr.Count -lt 1000) { break }; $off += 1000
}
Log "done-set (already-ingested) = $($done.Count)"

# Ingest ONE succeeded batch result line. Returns 'ok' | 'skip' | 'fail'.
function IngestResult($custom_id, $msg) {
  # No Log calls here: this function is called for its RETURN value ($st = IngestResult ...),
  # and Log writes to the pipeline (Write-Output), which would pollute the return with an array.
  $meta = $map[$custom_id]
  if (-not $meta) { return 'skip' }
  if ($done.Contains($meta.fp)) { return 'skip' }   # already ingested (idempotent re-run)
  $abs = ($msg.content | Where-Object { $_.type -eq 'tool_use' } | Select-Object -First 1).input
  if (-not $abs) { return 'fail' }
  $title = if ($abs.summary) { ($abs.summary -replace '\s+', ' ').Trim() } else { $meta.file_name }
  if ($title.Length -gt 280) { $title = $title.Substring(0, 280) }
  $blob = (Blob $abs).Trim(); if (-not $blob) { $blob = $title }
  # stamp provenance into the stored abstraction JSON, matching ingest_local_docs.ps1 exactly
  $abs | Add-Member -NotePropertyName _tenant_folder -NotePropertyValue $meta.tenant -Force
  $abs | Add-Member -NotePropertyName _source -NotePropertyValue ($meta.fp.Substring(5)) -Force
  # embed FIRST (so a failure never leaves an orphan documents row)
  $ebody = @{ model = $VOYAGE_MODEL; input = $blob.Substring(0, [Math]::Min(32000, $blob.Length)); input_type = 'document'; output_dimension = 1024 } | ConvertTo-Json
  $er = Invoke-RestMethod -Method Post -Uri "https://api.voyageai.com/v1/embeddings" -Headers @{ Authorization = "Bearer $VOYAGE_KEY" } -ContentType "application/json" -Body ([System.Text.Encoding]::UTF8.GetBytes($ebody)) -TimeoutSec 120
  $vec = $er.data[0].embedding
  $docRow = @{ property_id = $meta.property_id; doc_type = (ToDocType $abs.doc_type); title = $title;
    file_name = $meta.file_name; file_path = $meta.fp; is_indexed = $true; notes = (ConvertTo-Json $abs -Depth 8 -Compress)
  }
  $ins = (Post 'documents' $docRow 'return=representation') | ConvertFrom-Json
  $docId = $ins[0].id
  $chunk = @{ document_id = $docId; chunk_index = 0; content = $blob; embedding_voyage = "[$($vec -join ',')]" }
  $null = Post 'document_chunks' $chunk 'return=minimal'
  [void]$done.Add($meta.fp)
  return 'ok'
}

# Fetch + process the results of an ENDED batch. Signals ended-ness via $script:pbEnded
# (NOT a return value: Log writes to the pipeline, so a bool return would come back as an
# array of [loglines..., bool] and every batch would read as truthy). Mutates counters in script scope.
function ProcessBatch($bid) {
  $obj = Invoke-RestMethod -Method Get -Uri "https://api.anthropic.com/v1/messages/batches/$bid" -Headers @{ "x-api-key" = $AK; "anthropic-version" = "2023-06-01" } -TimeoutSec 120
  if ("$($obj.processing_status)" -ne 'ended') {
    $c = $obj.request_counts
    Log "  $bid : $($obj.processing_status) (proc=$($c.processing) ok=$($c.succeeded) err=$($c.errored) exp=$($c.expired))"
    $script:pbEnded = $false; return
  }
  $url = $obj.results_url
  if (-not $url) { Log "  $bid ended but no results_url yet - retry next poll"; $script:pbEnded = $false; return }
  $rf = "$STATE\_results_$bid.jsonl"
  & curl.exe -s "$url" -H "x-api-key: $AK" -H "anthropic-version: 2023-06-01" -o $rf
  $ok = 0; $skip = 0; $fail = 0; $err = 0; $exp = 0; $tin = 0; $tout = 0
  foreach ($line in [System.IO.File]::ReadLines($rf)) {
    if (-not $line) { continue }
    $res = $null; try { $res = $line | ConvertFrom-Json } catch { continue }
    $cid = $res.custom_id; $rt = $res.result.type
    if ($rt -eq 'succeeded') {
      try { $tin += [int]$res.result.message.usage.input_tokens; $tout += [int]$res.result.message.usage.output_tokens } catch {}
      $st = 'fail'; try { $st = IngestResult $cid $res.result.message } catch { $st = 'fail'; Log "  ingest error $cid :: $($_.Exception.Message)" }
      switch ($st) { 'ok' { $ok++ } 'skip' { $skip++ } default { $fail++ } }
    }
    elseif ($rt -eq 'errored') {
      $err++
      # Batch error shape: result.error.error.{type,message} (nested) - NOT result.error.message.
      $einner = $res.result.error.error
      $emsg = if ($einner -and $einner.message) { "$($einner.type): $($einner.message)" } else { "$($res.result.error.type)" }
      $meta = $map[$cid]; $fn = if ($meta) { $meta.file_name } else { $cid }
      $emsgClean = ($emsg -replace '\s+', ' ')
      Log "  ERRORED $fn :: $($emsgClean.Substring(0,[Math]::Min(200,$emsgClean.Length)))"
      # only SIZE errors are deterministic -> dead-letter + queue for split_ingest. Everything
      # else (rate/overload/network) stays retryable: resubmit its file via a fresh submit run.
      if ($meta -and $emsg -match '(?i)too many pages|too large|prompt is too long|exceeds the maximum|page limit|maximum.*pages') {
        Add-Content -LiteralPath $DEAD -Value $meta.fp -Encoding utf8
        Add-Content -LiteralPath $GIANTS -Value ($meta.fp.Substring(5)) -Encoding utf8
      }
    }
    elseif ($rt -eq 'expired') { $exp++ }
    else { $exp++ }
  }
  Remove-Item -LiteralPath $rf -ErrorAction SilentlyContinue
  $costHalf = [math]::Round(($tin / 1e6 * 0.5) + ($tout / 1e6 * 2.5), 4)   # Haiku 4.5 at 50% batch rate
  Log "  $bid ENDED: ingested=$ok skipped=$skip fail=$fail errored=$err expired=$exp | tokens in=$tin out=$tout | batch cost ~`$$costHalf"
  $script:tOk += $ok; $script:tSkip += $skip; $script:tFail += $fail; $script:tErr += $err; $script:tExp += $exp; $script:tCost += $costHalf
  $script:pbEnded = $true
}

# -- poll loop --
$deadline = (Get-Date).AddHours($MaxHours)
$script:tOk = 0; $script:tSkip = 0; $script:tFail = 0; $script:tErr = 0; $script:tExp = 0; $script:tCost = 0.0
while ($true) {
  # reload batch list each pass (a parallel submit run may have appended more)
  $batches = @(); if (Test-Path -LiteralPath $BatchFile) { foreach ($l in (Get-Content -LiteralPath $BatchFile)) { if ($l) { try { $batches += ($l | ConvertFrom-Json) } catch {} } } }
  $doneFile = "$STATE\_done_batches.txt"
  $doneSet = New-Object System.Collections.Generic.HashSet[string]
  if (Test-Path -LiteralPath $doneFile) { foreach ($b in (Get-Content -LiteralPath $doneFile)) { if ($b) { [void]$doneSet.Add($b) } } }
  $pending = @($batches | Where-Object { -not $doneSet.Contains($_.batch_id) })
  if ($pending.Count -eq 0) { Log "all batches processed."; break }
  Log "poll: $($pending.Count) batch(es) pending"
  foreach ($b in $pending) {
    $script:pbEnded = $false
    try { ProcessBatch $b.batch_id } catch { Log "  poll error $($b.batch_id) :: $($_.Exception.Message)" }
    if ($script:pbEnded) { Add-Content -LiteralPath $doneFile -Value $b.batch_id -Encoding utf8 }
  }
  $batches2 = @(); if (Test-Path -LiteralPath $BatchFile) { foreach ($l in (Get-Content -LiteralPath $BatchFile)) { if ($l) { try { $batches2 += ($l | ConvertFrom-Json) } catch {} } } }
  $doneSet2 = New-Object System.Collections.Generic.HashSet[string]
  if (Test-Path -LiteralPath $doneFile) { foreach ($b in (Get-Content -LiteralPath $doneFile)) { if ($b) { [void]$doneSet2.Add($b) } } }
  if (@($batches2 | Where-Object { -not $doneSet2.Contains($_.batch_id) }).Count -eq 0) { Log "all batches processed."; break }
  if ($Once) { Log "-Once: exiting with batches still pending (re-run to continue)."; break }
  if ((Get-Date) -gt $deadline) { Log "MaxHours reached; exiting with batches still pending."; break }
  Start-Sleep -Seconds $PollSeconds
}
Log "TOTAL: ingested=$($script:tOk) skipped=$($script:tSkip) fail=$($script:tFail) errored=$($script:tErr) expired=$($script:tExp) | est batch cost ~`$$([math]::Round($script:tCost,2))"
if ($script:tExp -gt 0 -or $script:tErr -gt 0) { Log "NOTE: expired/transient-errored files are NOT ingested - re-run ingest_batch_submit.ps1 over the same folder to resubmit them (done-set skips the successes)." }
