param(
  [int]$TenantDepth = 1,                                 # path segment (under Root) to record as tenant folder
  [double]$MaxMB = 23,                                   # skip PDFs larger than this (Anthropic 32MB base64 / 100pg cap)
  [int]$Shard = 0, [int]$Of = 1,                         # process files where index % Of == Shard (parallel workers)
  [int]$Limit = 0,                                       # 0 = all; >0 = stop after N (testing)
  [string]$Model = "claude-haiku-4-5-20251001"
)
$ErrorActionPreference = "Stop"
# Root + property come via env vars (CLI -Root binding was unreliable under the harness — a
# stray positional kept capturing it). Set $env:INGEST_ROOT and $env:INGEST_PID before calling.
$Root = $env:INGEST_ROOT
$PropertyId = $env:INGEST_PID
if(-not $Root -or -not $PropertyId){ throw "Set `$env:INGEST_ROOT and `$env:INGEST_PID before running" }
$repo = "C:\Users\pskontos\Desktop\Software\cre-platform"
$cfg = @{}; foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match "=" })) { $k,$v = $l -split '=',2; $cfg[$k.Trim()]=$v.Trim() }
$BASE=$cfg['VITE_SUPABASE_URL']; $KEY=$cfg['SUPABASE_SECRET_KEY']; $AK=$cfg['ANTHROPIC_API_KEY']; $OPENAI_KEY=$cfg['OPENAI_API_KEY']
$VOYAGE_KEY=$cfg['VOYAGE_API_KEY']; $VOYAGE_MODEL= if($cfg['VOYAGE_MODEL']){$cfg['VOYAGE_MODEL']}else{'voyage-3-large'}
if(-not (Test-Path -LiteralPath $Root)){ throw "Root not found / not accessible from this process: $Root" }
$SP = if($env:INGEST_SP -and (Test-Path -LiteralPath $env:INGEST_SP)){ $env:INGEST_SP } else { "C:\Users\pskontos\AppData\Local\Temp\claude\C--Users-pskontos-Desktop-Software\4813eb50-3027-4b15-81ea-2a63a5f0357b\scratchpad" }
$log = "$SP\ingest_s$Shard.log"
$DEAD = "$SP\ingest_deadletter.txt"   # files that deterministically fail (>100pg / too large) — skip on retry, handle via split later
# Oversized PDFs are QUEUED here (one path per line) instead of dead-ended. Feed this list to
# split_ingest.ps1 (SPLIT_LIST=...), which sends the WHOLE PDF to pdf-extract → ONE document with
# many chunks. Do NOT presplit + re-ingest pieces: that creates one documents row per piece
# (fragmented leases). See consolidate_splits.ps1 for the cleanup of past fragmentation.
$GIANTS = if($env:GIANTS_OUT){ $env:GIANTS_OUT } else { "$SP\giants_to_split.txt" }
function Log($m){ $line="$(Get-Date -Format HH:mm:ss) $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }
$enc = New-Object System.Text.UTF8Encoding($false)

# ── abstraction schema (mirrors pdf-extract edge function) ──
$nstr = @('string','null')
$schema = @{ type='object'; additionalProperties=$false; properties=[ordered]@{
  doc_type=@{type='string';enum=@('lease','amendment','estoppel','easement_operating_agreement','guaranty','correspondence','memorandum','other')}
  sub_type=@{type=$nstr}; confidence=@{type='string';enum=@('high','medium','low')}
  property=@{type=$nstr}; tenant=@{type=$nstr}; counterparties=@{type='array';items=@{type='string'}}
  effective_date=@{type=$nstr}; expiration_date=@{type=$nstr}; premises_suite=@{type=$nstr}
  sqft=@{type=@('number','null')}; base_rent_summary=@{type=$nstr}; percentage_rent=@{type=$nstr}
  recovery_method=@{type=$nstr}; options=@{type='array';items=@{type='string'}}
  co_tenancy=@{type=$nstr}; exclusive_use=@{type=$nstr}; recording_info=@{type=$nstr}
  amends=@{type=$nstr}; amendment_seq=@{type=$nstr}
  key_dates=@{type='array';items=@{type='object';additionalProperties=$false;properties=@{label=@{type='string'};date=@{type='string'}};required=@('label','date')}}
  summary=@{type='string'}
}; required=@('doc_type','sub_type','confidence','property','tenant','counterparties','effective_date','expiration_date','premises_suite','sqft','base_rent_summary','percentage_rent','recovery_method','options','co_tenancy','exclusive_use','recording_info','amends','amendment_seq','key_dates','summary') }
$PROMPT = "You are abstracting a commercial real estate legal document for an asset-management platform. Read the attached PDF and extract the fields defined by the tool schema. Classify doc_type from the CONTENT, not the filename. Use null for any field the document does not establish; do not guess. Dates as yyyy-mm-dd when determinable. For amends: if this document amends/supersedes/modifies a prior lease or agreement, briefly state WHAT it changes (sections/terms); null if it is an original/base agreement or does not amend anything. For amendment_seq: the sequence label if applicable (e.g. 'First Amendment','Second Amendment','Rider','Side Letter','Assignment'); null otherwise. Provide a 2-4 sentence plain-language summary."

function ToDocType($t){ switch ("$t") { 'lease'{'lease'} 'amendment'{'lease'} 'estoppel'{'estoppel'} default {'other'} } }
function Blob($x){ $a={ param($v) if($v -is [array]){$v}else{@()} }
  $kd = (& $a $x.key_dates | ForEach-Object { "$($_.label): $($_.date)" }) -join '; '
  @($x.summary,$x.doc_type,$x.sub_type,$x.property,$x.tenant,((& $a $x.counterparties) -join ', '),
    $x.base_rent_summary,$x.percentage_rent,$x.recovery_method,$x.co_tenancy,$x.exclusive_use,
    ((& $a $x.options) -join '; '),$kd) | Where-Object { $_ } | ForEach-Object { "$_" } | Out-String
}
function ReadBytesRetry($path){
  for($a=1;$a -le 5;$a++){
    try { return [System.IO.File]::ReadAllBytes($path) }
    catch { if($a -eq 5){ throw }; Start-Sleep -Seconds (3*$a) }   # UNC share drops under load; back off + retry
  }
}
function Post($table,$obj,$prefer){
  $body = '[' + (ConvertTo-Json -InputObject $obj -Depth 8 -Compress) + ']'
  $tmp = "$SP\_doc_post_s$Shard.json"; [System.IO.File]::WriteAllText($tmp,$body,$enc)
  $resp = & curl.exe -s -X POST "$BASE/rest/v1/$table" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Prefer: $prefer" --data-binary "@$tmp"
  if ($resp -match '"code"' -and $resp -match '"message"') { throw "POST $table failed: $resp" }
  return $resp
}

# ── done-set: file_path already ingested (resumable) ──
$done = New-Object System.Collections.Generic.HashSet[string]
$off=0
while($true){
  $r = & curl.exe -s "$BASE/rest/v1/documents?select=file_path&file_path=like.file:*" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Range: $off-$($off+999)"
  $arr = $r | ConvertFrom-Json; if(-not $arr){break}
  foreach($d in $arr){ if($d.file_path){[void]$done.Add($d.file_path)} }
  if($arr.Count -lt 1000){break}; $off+=1000
}
Log "done-set (already-ingested file: docs) = $($done.Count)"
if(Test-Path -LiteralPath $DEAD){ $dl=0; foreach($d in (Get-Content -LiteralPath $DEAD)){ if($d){ [void]$done.Add($d); $dl++ } }; Log "dead-letter (skip, need split) = $dl" }

Log "ROOT=$Root"
# Prefer a pre-built manifest (size<TAB>path per line) — a full recursive UNC scan of 1,292
# files hangs under load, but per-folder enumeration into a manifest is fast. Falls back to scan.
if($env:INGEST_MANIFEST -and (Test-Path -LiteralPath $env:INGEST_MANIFEST)){
  $pdfs = @(Get-Content -LiteralPath $env:INGEST_MANIFEST | Where-Object { $_ } | ForEach-Object {
    $p = $_ -split "`t",2
    [PSCustomObject]@{ Length=[long]$p[0]; FullName=$p[1]; Name=(Split-Path $p[1] -Leaf) }
  } | Sort-Object FullName)
  Log "manifest mode: $($pdfs.Count) PDFs from $env:INGEST_MANIFEST"
} else {
  $pdfs = Get-ChildItem -LiteralPath $Root -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -ieq '.pdf' } | Sort-Object FullName
  Log "scan mode: found $($pdfs.Count) PDFs under root"
}
Log "shard $Shard/$Of; maxMB=$MaxMB"
$i=-1; $ok=0; $skip=0; $fail=0; $big=0; $tokIn=0; $tokOut=0
foreach($f in $pdfs){
  $i++
  if(($i % $Of) -ne $Shard){ continue }
  $fp = "file:" + $f.FullName
  if($done.Contains($fp)){ $skip++; continue }
  # Never ingest a pre-split piece as its own document — that is exactly what fragmented the
  # leases. The whole source PDF should go through split_ingest.ps1 instead (one doc, many chunks).
  if($f.Name -match '(__g-|_g-|_p)\d+-\d+\.pdf$'){ $skip++; Log "SKIP pre-split piece (send whole PDF via split_ingest.ps1): $($f.Name)"; continue }
  # Oversized for the one-shot base64 path → queue for split_ingest.ps1 (consolidated), don't drop.
  if(($f.Length/1MB) -gt $MaxMB){ $big++; Add-Content -LiteralPath $GIANTS -Value $f.FullName; Log "OVERSIZE → queued for split_ingest ($([math]::Round($f.Length/1MB,1))MB): $($f.FullName)"; continue }
  $tenant = ($f.FullName.Substring($Root.Length).TrimStart('\') -split '\\')[($TenantDepth-1)]
  try {
    $b64 = [System.Convert]::ToBase64String((ReadBytesRetry $f.FullName))
    $body = @{ model=$Model; max_tokens=2048
      tools=@(@{ name='record_abstraction'; description='Record the document abstraction.'; input_schema=$schema })
      tool_choice=@{ type='tool'; name='record_abstraction' }
      messages=@(@{ role='user'; content=@(
        @{ type='document'; source=@{ type='base64'; media_type='application/pdf'; data=$b64 } },
        @{ type='text'; text=$PROMPT } )}) } | ConvertTo-Json -Depth 20
    $bb=[System.Text.Encoding]::UTF8.GetBytes($body)
    $r = Invoke-RestMethod -Method Post -Uri "https://api.anthropic.com/v1/messages" -Headers @{ "x-api-key"=$AK; "anthropic-version"="2023-06-01" } -ContentType "application/json" -Body $bb -TimeoutSec 300
    try { $tokIn += [int]$r.usage.input_tokens; $tokOut += [int]$r.usage.output_tokens } catch {}
    $abs = ($r.content | Where-Object { $_.type -eq 'tool_use' } | Select-Object -First 1).input
    if(-not $abs){ throw "no tool_use in response" }
    $abs | Add-Member -NotePropertyName _tenant_folder -NotePropertyValue $tenant -Force
    $abs | Add-Member -NotePropertyName _source -NotePropertyValue $f.FullName -Force
    $title = if($abs.summary){ ($abs.summary -replace '\s+',' ').Trim() } else { $f.Name }
    if($title.Length -gt 280){ $title=$title.Substring(0,280) }
    # embed FIRST (so a failure never leaves an orphan documents row)
    $blob = (Blob $abs).Trim(); if(-not $blob){ $blob = $title }
    $ebody = @{ model=$VOYAGE_MODEL; input=$blob.Substring(0,[Math]::Min(32000,$blob.Length)); input_type='document'; output_dimension=1024 } | ConvertTo-Json
    $er = Invoke-RestMethod -Method Post -Uri "https://api.voyageai.com/v1/embeddings" -Headers @{ Authorization="Bearer $VOYAGE_KEY" } -ContentType "application/json" -Body ([System.Text.Encoding]::UTF8.GetBytes($ebody)) -TimeoutSec 120
    $vec = $er.data[0].embedding
    $docRow = @{ property_id=$PropertyId; doc_type=(ToDocType $abs.doc_type); title=$title;
                 file_name=$f.Name; file_path=$fp; is_indexed=$true; notes=(ConvertTo-Json $abs -Depth 8 -Compress) }
    $ins = (Post 'documents' $docRow 'return=representation') | ConvertFrom-Json
    $docId = $ins[0].id
    $chunk = @{ document_id=$docId; chunk_index=0; content=$blob; embedding_voyage="[$($vec -join ',')]" }
    $null = Post 'document_chunks' $chunk 'return=minimal'
    $ok++
    if(($ok % 10) -eq 0){ Log "progress: ok=$ok skip=$skip fail=$fail big=$big (last: $($abs.doc_type) | $tenant | $($f.Name))" }
  } catch {
    $fail++
    $detail = if($_.ErrorDetails.Message){ ($_.ErrorDetails.Message -replace '\s+',' ') } else { $_.Exception.Message }
    if($detail.Length -gt 300){ $detail=$detail.Substring(0,300) }
    Log "FAIL $($f.Name) :: $detail"
    # deterministic too-large/too-many-pages -> dead-letter (base64 path skips it) AND queue for
    # split_ingest.ps1, which handles giants as ONE consolidated doc (no fragmentation).
    if($detail -match '(?i)\(400\)|too large|exceed|too long|page limit|invalid_request'){ Add-Content -LiteralPath $DEAD -Value $fp -Encoding utf8; Add-Content -LiteralPath $GIANTS -Value $f.FullName }
  }
  if($Limit -gt 0 -and $ok -ge $Limit){ Log "hit Limit=$Limit, stopping"; break }
}
$costUsd = [math]::Round(($tokIn/1e6*1.0) + ($tokOut/1e6*5.0), 4)   # Haiku 4.5: $1/MTok in, $5/MTok out
Log "DONE shard ${Shard}: ok=$ok skip=$skip fail=$fail oversize=$big | tokens in=$tokIn out=$tokOut | Anthropic cost=`$$costUsd (avg `$$([math]::Round($(if($ok){$costUsd/$ok}else{0}),5))/doc)"
if(Test-Path -LiteralPath $GIANTS){
  $gc = (Get-Content -LiteralPath $GIANTS | Where-Object { $_ } | Sort-Object -Unique).Count
  Log "GIANTS queued for split_ingest.ps1 = $gc  ->  run:  `$env:SPLIT_LIST='$GIANTS'; `$env:INGEST_PID=<propertyId>; .\split_ingest.ps1"
}
