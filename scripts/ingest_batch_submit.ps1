# ingest_batch_submit.ps1 - PHASE A of the Anthropic Message Batches ingest.
#
# Offline drive-scan backfill ONLY. Same model / schema / prompt / dedup / skip rules
# as ingest_local_docs.ps1, but instead of calling /v1/messages synchronously per file,
# it submits the abstraction requests to the Message Batches API (~50% cheaper, async,
# up to 24h SLA). NEVER use this for anything a user waits on.
#
# Two-phase flow:
#   Phase A (this script)  -> read new PDFs, build requests, POST /v1/messages/batches,
#                             persist batch ids + a custom_id->file map to a state dir.
#   Phase B (ingest_batch_ingest.ps1) -> poll the batches, and when each ends, run the
#                             SAME downstream (Voyage embed + documents/document_chunks
#                             inserts) keyed back to each file by custom_id.
#
# Same env contract as ingest_local_docs.ps1 (drop-in per folder):
#   $env:INGEST_ROOT     = UNC root of the folder being ingested
#   $env:INGEST_PID      = property_id for that folder
#   $env:INGEST_MANIFEST = (optional) size<TAB>path manifest; else recursive scan
#   $env:INGEST_SP       = (optional) stable work dir (defaults under LocalAppData)
#
#   .\ingest_batch_submit.ps1 -Limit 20     # TEST SLICE: submit only the first 20 new PDFs
#   .\ingest_batch_submit.ps1               # submit all new PDFs in the folder
#
# Cost is HALF of the synchronous path but NOT zero. Requires Anthropic credit.
param(
  [double]$MaxMB = 23,                                   # skip PDFs larger than this (queue to GIANTS for split_ingest)
  [int]$Limit = 0,                                       # 0 = all; >0 = stop after N (test slice)
  [string]$Model = "claude-haiku-4-5-20251001",
  [int]$BatchMaxMB = 150,                                # cap cumulative payload per batch (API hard limit is 256MB)
  [int]$BatchMaxReqs = 1000,                             # cap requests per batch (API hard limit is 100000)
  [switch]$RetryDeadletter,                              # resubmit dead-lettered files (do NOT add $DEAD to skip-set)
  [switch]$FromDeadletter,                               # work-list = the dead-letter file itself; maps each path->property via scan_folders.json
  [string]$StateDir = ''                                 # override the batch-state dir (default: $SP\batch_state)
)
$ErrorActionPreference = "Stop"
$Root = $env:INGEST_ROOT
$PropertyId = $env:INGEST_PID
if (-not $FromDeadletter -and (-not $Root -or -not $PropertyId)) { throw "Set `$env:INGEST_ROOT and `$env:INGEST_PID before running (or pass -FromDeadletter)" }
if ($FromDeadletter) { $RetryDeadletter = $true }        # reading FROM the dead-letter list; never skip its own entries
$repo = "C:\Users\pskontos\Desktop\Software\cre-platform"
$cfg = @{}; foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match "=" })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']; $AK = $cfg['ANTHROPIC_API_KEY']
if (-not $FromDeadletter -and -not (Test-Path -LiteralPath $Root)) { throw "Root not found / not accessible from this process: $Root" }
$SP = if ($env:INGEST_SP -and (Test-Path -LiteralPath $env:INGEST_SP)) { $env:INGEST_SP } else { "C:\Users\pskontos\AppData\Local\cre-ingest" }
if (-not (Test-Path -LiteralPath $SP)) { New-Item -ItemType Directory -Force -Path $SP | Out-Null }
$STATE = if ($StateDir) { $StateDir } else { "$SP\batch_state" }
if (-not (Test-Path -LiteralPath $STATE)) { New-Item -ItemType Directory -Force -Path $STATE | Out-Null }
$BATCHES = "$STATE\batches.jsonl"     # one line per submitted batch
$MAP = "$STATE\map.jsonl"             # one line per doc: custom_id -> {fp,file_name,property_id,tenant,batch_id}
$log = "$STATE\submit.log"
$DEAD = "$SP\ingest_deadletter.txt"
$GIANTS = if ($env:GIANTS_OUT) { $env:GIANTS_OUT } else { "$SP\giants_to_split.txt" }
$enc = New-Object System.Text.UTF8Encoding($false)
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [submit] $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }

# -- abstraction schema (IDENTICAL to ingest_local_docs.ps1) --
$nstr = @('string', 'null')
$schema = @{ type = 'object'; additionalProperties = $false; properties = [ordered]@{
    doc_type          = @{type = 'string'; enum = @('lease', 'amendment', 'estoppel', 'easement_operating_agreement', 'guaranty', 'correspondence', 'memorandum', 'other') }
    sub_type          = @{type = $nstr }; confidence = @{type = 'string'; enum = @('high', 'medium', 'low') }
    property          = @{type = $nstr }; tenant = @{type = $nstr }; counterparties = @{type = 'array'; items = @{type = 'string' } }
    effective_date    = @{type = $nstr }; expiration_date = @{type = $nstr }; premises_suite = @{type = $nstr }
    sqft              = @{type = @('number', 'null') }; base_rent_summary = @{type = $nstr }; percentage_rent = @{type = $nstr }
    recovery_method   = @{type = $nstr }; options = @{type = 'array'; items = @{type = 'string' } }
    co_tenancy        = @{type = $nstr }; exclusive_use = @{type = $nstr }; recording_info = @{type = $nstr }
    amends            = @{type = $nstr }; amendment_seq = @{type = $nstr }
    key_dates         = @{type = 'array'; items = @{type = 'object'; additionalProperties = $false; properties = @{label = @{type = 'string' }; date = @{type = 'string' } }; required = @('label', 'date') } }
    summary           = @{type = 'string' }
  }; required = @('doc_type', 'sub_type', 'confidence', 'property', 'tenant', 'counterparties', 'effective_date', 'expiration_date', 'premises_suite', 'sqft', 'base_rent_summary', 'percentage_rent', 'recovery_method', 'options', 'co_tenancy', 'exclusive_use', 'recording_info', 'amends', 'amendment_seq', 'key_dates', 'summary')
}
$PROMPT = "You are abstracting a commercial real estate legal document for an asset-management platform. Read the attached PDF and extract the fields defined by the tool schema. Classify doc_type from the CONTENT, not the filename. Use null for any field the document does not establish; do not guess. Dates as yyyy-mm-dd when determinable. For amends: if this document amends/supersedes/modifies a prior lease or agreement, briefly state WHAT it changes (sections/terms); null if it is an original/base agreement or does not amend anything. For amendment_seq: the sequence label if applicable (e.g. 'First Amendment','Second Amendment','Rider','Side Letter','Assignment'); null otherwise. Provide a 2-4 sentence plain-language summary."

# Pre-serialize the constant pieces ONCE (schema is identical for every request; the
# prompt has no double-quotes/backslashes but ConvertTo-Json escapes it correctly anyway).
$schemaJson = ConvertTo-Json $schema -Depth 25 -Compress
$promptJson = ConvertTo-Json $PROMPT   # includes surrounding quotes

function ReadBytesRetry($path) {
  for ($a = 1; $a -le 5; $a++) {
    try { return [System.IO.File]::ReadAllBytes($path) }
    catch { if ($a -eq 5) { throw }; Start-Sleep -Seconds (3 * $a) }
  }
}
# Stable, collision-free custom_id from the file: path (also makes resubmits idempotent).
$sha = [System.Security.Cryptography.SHA256]::Create()
function Cid($fp) { $h = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($fp)); 'd' + (($h[0..7] | ForEach-Object { $_.ToString('x2') }) -join '') }
# Drive-letter -> UNC (corpus stores UNC; scan_folders.json roots are drive-letter form).
function ToUnc([string]$p) {
  if ($p -imatch '^K:\\') { return ($p -ireplace '^K:\\', '\\192.168.220.121\users\') }
  if ($p -imatch '^V:\\') { return ($p -ireplace '^V:\\', '\\192.168.220.121\virtual_file_room\') }
  return $p
}

# -- done-set: file_path already ingested (skip; same as sync) --
$done = New-Object System.Collections.Generic.HashSet[string]
$off = 0
while ($true) {
  $r = & curl.exe -s "$BASE/rest/v1/documents?select=file_path&file_path=like.file:*" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Range: $off-$($off+999)"
  $arr = $r | ConvertFrom-Json; if (-not $arr) { break }
  foreach ($d in $arr) { if ($d.file_path) { [void]$done.Add($d.file_path) } }
  if ($arr.Count -lt 1000) { break }; $off += 1000
}
Log "done-set (already-ingested file: docs) = $($done.Count)"
if ($RetryDeadletter) { Log "RETRY mode: dead-letter NOT added to skip-set (wrongly-dead-lettered files will be resubmitted)" }
elseif (Test-Path -LiteralPath $DEAD) { foreach ($d in (Get-Content -LiteralPath $DEAD)) { if ($d) { [void]$done.Add($d) } } }
# also skip anything already submitted in a prior run (present in map.jsonl)
$submitted = New-Object System.Collections.Generic.HashSet[string]
if (Test-Path -LiteralPath $MAP) { foreach ($l in (Get-Content -LiteralPath $MAP)) { if ($l) { try { $o = $l | ConvertFrom-Json; if ($o.fp) { [void]$submitted.Add($o.fp) } } catch {} } } }
Log "already-submitted (pending) file: docs = $($submitted.Count)"

# -- enumerate PDFs (dead-letter list, manifest, or recursive scan) --
if ($FromDeadletter) {
  # Work-list = the dead-letter file. Map each UNC path -> property_id via scan_folders.json
  # (roots are drive-letter form; ToUnc them, then longest-prefix match). Each item carries
  # its own PropertyId/Tenant so one batch can span multiple properties.
  $conf = Get-Content -LiteralPath "$PSScriptRoot\scan_folders.json" -Raw | ConvertFrom-Json
  $folderMap = @($conf.folders | ForEach-Object { [PSCustomObject]@{ UncRoot = (ToUnc $_.root); PropertyId = $_.property_id } } | Sort-Object { $_.UncRoot.Length } -Descending)
  $pdfs = @()
  foreach ($d in (Get-Content -LiteralPath $DEAD | Where-Object { $_ })) {
    $disk = if ($d.StartsWith('file:')) { $d.Substring(5) } else { $d }
    if ($disk -match '#pages') { continue }   # split-fragment path, not a real file
    $fi = Get-Item -LiteralPath $disk -ErrorAction SilentlyContinue
    if (-not $fi) { Log "DL missing on disk (skip): $disk"; continue }
    $fold = $folderMap | Where-Object { $disk.ToLower().StartsWith($_.UncRoot.ToLower()) } | Select-Object -First 1
    if (-not $fold) { Log "DL no scan_folders match (skip): $disk"; continue }
    $tn = ($disk.Substring($fold.UncRoot.Length).TrimStart('\') -split '\\')[0]
    $pdfs += [PSCustomObject]@{ Length = $fi.Length; FullName = $disk; Name = $fi.Name; PropertyId = $fold.PropertyId; Tenant = $tn }
  }
  $pdfs = @($pdfs | Sort-Object FullName)
  Log "deadletter mode: $($pdfs.Count) files mapped from $DEAD"
} elseif ($env:INGEST_MANIFEST -and (Test-Path -LiteralPath $env:INGEST_MANIFEST)) {
  $pdfs = @(Get-Content -LiteralPath $env:INGEST_MANIFEST | Where-Object { $_ } | ForEach-Object {
      $p = $_ -split "`t", 2; [PSCustomObject]@{ Length = [long]$p[0]; FullName = $p[1]; Name = (Split-Path $p[1] -Leaf) } } | Sort-Object FullName)
  Log "manifest mode: $($pdfs.Count) PDFs from $env:INGEST_MANIFEST"
} else {
  $pdfs = Get-ChildItem -LiteralPath $Root -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -ieq '.pdf' } | Sort-Object FullName
  Log "scan mode: found $($pdfs.Count) PDFs under root"
}
Log "ROOT=$Root  PID=$PropertyId  FromDeadletter=$FromDeadletter  BatchMaxMB=$BatchMaxMB BatchMaxReqs=$BatchMaxReqs Limit=$Limit"

# -- batch writer: stream requests to a temp file, POST when full --
$batchMaxBytes = [long]$BatchMaxMB * 1MB
$sw = $null; $tmpFile = $null; $curBytes = 0L; $curReqs = 0; $curMap = $null
$batchSeq = 0; $submittedCount = 0; $added = 0; $skip = 0; $big = 0
function NewBatch() {
  $script:batchSeq++
  $script:tmpFile = "$STATE\_batch_body_$($script:batchSeq).json"
  $script:sw = New-Object System.IO.StreamWriter($script:tmpFile, $false, $enc)
  $script:sw.Write('{"requests":[')
  $script:curBytes = 0L; $script:curReqs = 0; $script:curMap = New-Object System.Collections.ArrayList
}
function FlushBatch() {
  if (-not $script:sw -or $script:curReqs -eq 0) { if ($script:sw) { $script:sw.Dispose(); $script:sw = $null }; return }
  $script:sw.Write(']}'); $script:sw.Dispose(); $script:sw = $null
  # POST the batch
  $resp = & curl.exe -s -X POST "https://api.anthropic.com/v1/messages/batches" -H "x-api-key: $AK" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" --data-binary "@$($script:tmpFile)"
  $bid = $null
  try { $j = $resp | ConvertFrom-Json; $bid = $j.id } catch {}
  if (-not $bid) {
    Log "BATCH SUBMIT FAILED (seq $($script:batchSeq)) :: $((""$resp"" -replace '\s+',' ').Substring(0,[Math]::Min(300,(""$resp"").Length)))"
    throw "batch submit failed; aborting so nothing is half-recorded"
  }
  # record batch + per-doc map (now that we have the batch id)
  (@{ batch_id = $bid; count = $script:curReqs; property_id = $(if ($FromDeadletter) { 'mixed' } else { $PropertyId }); status = 'submitted'; submitted_at = (Get-Date -Format 'o') } | ConvertTo-Json -Compress) | Out-File $BATCHES -Append -Encoding utf8
  foreach ($m in $script:curMap) { $m.batch_id = $bid; ($m | ConvertTo-Json -Compress) | Out-File $MAP -Append -Encoding utf8 }
  Remove-Item -LiteralPath $script:tmpFile -ErrorAction SilentlyContinue
  $script:submittedCount += $script:curReqs
  Log "submitted batch $bid : $($script:curReqs) requests ($([math]::Round($script:curBytes/1MB,1)) MB)"
}

NewBatch
foreach ($f in $pdfs) {
  $fp = "file:" + $f.FullName
  if ($done.Contains($fp) -or $submitted.Contains($fp)) { $skip++; continue }
  if ($f.Name -match '(__g-|_g-|_p)\d+-\d+\.pdf$') { $skip++; continue }   # never ingest a pre-split piece
  if (($f.Length / 1MB) -gt $MaxMB) { $big++; Add-Content -LiteralPath $GIANTS -Value $f.FullName; Log "OVERSIZE -> giants ($([math]::Round($f.Length/1MB,1))MB): $($f.FullName)"; continue }
  # per-item property/tenant when present (dead-letter mode); else the folder-wide values.
  # NOTE: $docPid not $pid - $PID is PowerShell's automatic process-id variable (case-insensitive).
  $docPid = if ($f.PSObject.Properties['PropertyId'] -and $f.PropertyId) { $f.PropertyId } else { $PropertyId }
  $tenant = if ($f.PSObject.Properties['Tenant'] -and $f.Tenant) { $f.Tenant } else { ($f.FullName.Substring($Root.Length).TrimStart('\') -split '\\')[0] }
  try { $b64 = [System.Convert]::ToBase64String((ReadBytesRetry $f.FullName)) }
  catch { Log "READ FAIL (skip this run): $($f.FullName) :: $($_.Exception.Message)"; continue }
  $cid = Cid $fp
  # base64 contains only [A-Za-z0-9+/=] so it is safe to interpolate into JSON verbatim.
  $req = '{"custom_id":"' + $cid + '","params":{"model":"' + $Model + '","max_tokens":2048,"tools":[{"name":"record_abstraction","description":"Record the document abstraction.","input_schema":' + $schemaJson + '}],"tool_choice":{"type":"tool","name":"record_abstraction"},"messages":[{"role":"user","content":[{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"' + $b64 + '"}},{"type":"text","text":' + $promptJson + '}]}]}}'
  # would this request push the current batch over a limit? flush first.
  if ($curReqs -gt 0 -and (($curBytes + $req.Length) -ge $batchMaxBytes -or $curReqs -ge $BatchMaxReqs)) { FlushBatch; NewBatch }
  if ($curReqs -gt 0) { $sw.Write(',') }
  $sw.Write($req)
  [void]$curMap.Add([PSCustomObject]@{ custom_id = $cid; fp = $fp; file_name = $f.Name; property_id = $docPid; tenant = $tenant; batch_id = $null })
  $curBytes += $req.Length; $curReqs++; $added++
  $b64 = $null; $req = $null
  if (($added % 25) -eq 0) { Log "queued $added (skip=$skip oversize=$big) current-batch=$curReqs" }
  if ($Limit -gt 0 -and $added -ge $Limit) { Log "hit Limit=$Limit"; break }
}
FlushBatch
Log "DONE submit: queued=$added submitted=$submittedCount skip=$skip oversize=$big | batches this run=$batchSeq"
Log "next: run ingest_batch_ingest.ps1 to poll + ingest results (state dir: $STATE)"
