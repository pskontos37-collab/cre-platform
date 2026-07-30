# ingest_ooxml_text.ps1 - give OOXML documents (.docx/.pptx) a verbatim text layer.
#
# WHY: 189 documents in the corpus are Office files and NOT ONE had any extracted
# text, so they were invisible to doc-ask, doc-search and the abstractor -- a lease
# amendment sent as a Word file simply did not exist to retrieval. All 189 are
# acquisition pipeline documents (K:\ASSTMGMT\ACQUISITIONS, stored under
# pipeline/<deal>/...), which is why property_id is null on them.
#
# DELIBERATELY NOT ALL 189. 153 of them are .xls/.xlsx, and 58 of those are already
# rows in comps.source_document -- they are CF models/T12s/rent rolls consumed as
# STRUCTURED data by the comps and underwriting extractors. Running prose extraction
# over a 3.3MB financial model injects noise into retrieval and gains nothing, so
# spreadsheets are excluded by default. Pass -Ext to override if a specific
# spreadsheet really does carry prose (some estoppel summaries might).
#
# NO WORD COM. OOXML files are ZIP archives of XML, so text comes out with
# System.IO.Compression alone. That matters here: Word COM is documented to HANG in
# this repo (project_emergency_manuals: "-Load without -SkipRender HANGS on Word
# COM"), and this path is headless and cannot hang on a modal dialog.
#
# CHUNKING matches the pdf-extract edge function on purpose (TEXT_CHUNK_CHARS 1400,
# TEXT_CHUNK_OVERLAP 200, prefer a paragraph > line > sentence break in the window
# tail). Divergent chunk sizes would skew hybrid-search ranking against these docs.
#
# page_number IS ALWAYS 1, and that is honest rather than lazy: an OOXML file has no
# fixed pagination, so there is no page for the PDF viewer to jump to. Ordering is
# carried by chunk_index. CONSEQUENCE: view-source deep-links will not land on a
# page for these documents until they are also rendered to PDF -- searchable now,
# deep-linkable later.
#
# Embeddings are left NULL (same choice reindex_text.ps1 makes with -skipEmbed):
# inserting 1024-dim vectors triggers HNSW maintenance per row and blew the edge
# wall. backfill_text_embeddings.ps1 fills them later; content alone serves FTS and
# the abstractor.
#
#   .\ingest_ooxml_text.ps1 -WhatIf          # report what would be done
#   .\ingest_ooxml_text.ps1
#   .\ingest_ooxml_text.ps1 -Ext 'docx,pptx,xlsx'
param(
  [string]$Ext = 'docx,pptx',
  [int]$Limit = 0,
  [int]$DelayMs = 100,
  [switch]$WhatIf
)
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
# Storage endpoints intermittently reject sb_secret_ keys ("Invalid Compact JWS") -
# use the classic service-role JWT for storage; PostgREST keeps working on sb_secret.
$SKEY = if ($cfg['SUPABASE_SERVICE_JWT']) { $cfg['SUPABASE_SERVICE_JWT'] } else { $KEY }
$UA = 'cre-loader/1.0'
$H  = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$log = "$PSScriptRoot\ingest_ooxml_text.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }

$CHUNK = 1400; $OVERLAP = 200

function Get-OoxmlText([string]$path) {
  $zip = [IO.Compression.ZipFile]::OpenRead($path)
  try {
    # docx body/headers/footers; pptx one XML per slide (sorted so slide order holds).
    $parts = @($zip.Entries | Where-Object {
      $_.FullName -eq 'word/document.xml' -or
      $_.FullName -match '^ppt/slides/slide[0-9]+\.xml$' -or
      $_.FullName -match '^word/(header|footer)[0-9]*\.xml$'
    } | Sort-Object { if ($_.FullName -eq 'word/document.xml') { '0' } else { $_.FullName } })
    if (-not $parts.Count) { return '' }
    $sb = New-Object Text.StringBuilder
    foreach ($e in $parts) {
      $sr = New-Object IO.StreamReader($e.Open(), [Text.UTF8Encoding]::new($false))
      $xml = $sr.ReadToEnd(); $sr.Close()
      # Insert breaks BEFORE stripping tags, else every paragraph collapses onto one line.
      $xml = $xml -replace '</w:p>', "`n" -replace '</a:p>', "`n" -replace '</w:tr>', "`n"
      $xml = $xml -replace '<w:tab[^>]*/>', "`t" -replace '<w:br[^>]*/>', "`n"
      [void]$sb.AppendLine(($xml -replace '<[^>]+>', ''))
    }
    $out = $sb.ToString()
    $out = $out -replace '&amp;', '&' -replace '&lt;', '<' -replace '&gt;', '>' -replace '&quot;', '"' -replace '&apos;', "'"
    $out = [regex]::Replace($out, '[ \t]+', ' ')
    $out = [regex]::Replace($out, '(\r?\n){3,}', "`n`n")
    return $out.Trim()
  } finally { $zip.Dispose() }
}

# Window into ~$CHUNK passages with $OVERLAP, preferring a clean break in the tail.
function Split-Windows([string]$text) {
  $res = New-Object System.Collections.Generic.List[string]
  if ([string]::IsNullOrWhiteSpace($text)) { return $res }
  $i = 0
  while ($i -lt $text.Length) {
    $len = [Math]::Min($CHUNK, $text.Length - $i)
    $end = $i + $len
    if ($end -lt $text.Length) {
      $tailStart = $i + [int]($len * 0.6)
      $seg = $text.Substring($tailStart, $end - $tailStart)
      $cut = -1
      foreach ($pat in @("`n`n", "`n", '. ')) {
        $p = $seg.LastIndexOf($pat)
        if ($p -ge 0) { $cut = $tailStart + $p + $pat.Length; break }
      }
      if ($cut -gt $i) { $end = $cut }
    }
    $piece = $text.Substring($i, $end - $i).Trim()
    if ($piece) { $res.Add($piece) }
    if ($end -ge $text.Length) { break }
    $i = [Math]::Max($end - $OVERLAP, $i + 1)
  }
  return $res
}

# ---- target set: OOXML docs mirrored to storage with NO kind='text' chunks ----
$exts = @($Ext -split ',' | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
$pattern = '\.(' + ($exts -join '|') + ')$'
$docs = New-Object System.Collections.Generic.List[object]
$off = 0
while ($true) {
  $page = Invoke-RestMethod -Uri "$BASE/rest/v1/documents?select=id,file_name,storage_path,property_id&storage_path=not.is.null&order=id.asc&limit=1000&offset=$off" -Headers $H -UserAgent $UA -TimeoutSec 120
  if (-not $page -or $page.Count -eq 0) { break }
  foreach ($d in $page) {
    if (($d.storage_path -notmatch '^(p|pipeline)/')) { continue }
    if ($d.file_name -and ($d.file_name -match $pattern)) { $docs.Add($d) }
    elseif ($d.storage_path -match $pattern) { $docs.Add($d) }
  }
  $off += 1000
  if ($page.Count -lt 1000) { break }
}
Log "OOXML candidates ($Ext): $($docs.Count)"

# Skip anything that already has text.
$have = New-Object System.Collections.Generic.HashSet[string]
$o = 0
while ($true) {
  $r = Invoke-RestMethod -Uri "$BASE/rest/v1/document_chunks?select=document_id&kind=eq.text&limit=1000&offset=$o" -Headers $H -UserAgent $UA -TimeoutSec 120
  if (-not $r -or $r.Count -eq 0) { break }
  foreach ($x in $r) { [void]$have.Add([string]$x.document_id) }
  if ($r.Count -lt 1000) { break }
  $o += 1000
}
$todo = @($docs | Where-Object { -not $have.Contains([string]$_.id) })
Log "already have text: $($docs.Count - $todo.Count) | to process: $($todo.Count)"

$tmp = "$env:TEMP\_ooxml_ingest.bin"
$ok = 0; $empty = 0; $fail = 0; $chunksTotal = 0; $n = 0
foreach ($d in $todo) {
  if ($Limit -gt 0 -and $n -ge $Limit) { break }
  $n++
  $enc = (($d.storage_path -split '/' | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/')
  $code = & curl.exe -s -o $tmp -w '%{http_code}' "$BASE/storage/v1/object/documents/$enc" -H "Authorization: Bearer $SKEY" -H "apikey: $SKEY"
  if ("$code" -notmatch '^2') { $fail++; Log "DOWNLOAD FAIL http=$code :: $($d.file_name)"; continue }
  $text = ''
  try { $text = Get-OoxmlText $tmp } catch { $fail++; Log "PARSE FAIL :: $($d.file_name) :: $($_.Exception.Message)"; continue }
  if ([string]::IsNullOrWhiteSpace($text) -or $text.Length -lt 40) { $empty++; Log "NO TEXT ($($text.Length) chars) :: $($d.file_name)"; continue }
  $pieces = Split-Windows $text
  if (-not $pieces.Count) { $empty++; continue }
  if ($WhatIf) { Log "WOULD INSERT $($pieces.Count) chunks ($($text.Length) chars) :: $($d.file_name)"; $ok++; $chunksTotal += $pieces.Count; continue }

  $rows = @()
  for ($i = 0; $i -lt $pieces.Count; $i++) {
    $rows += @{
      document_id      = $d.id
      property_id      = $d.property_id
      chunk_index      = 1000 + $i      # same offset convention as pdf-extract
      content          = $pieces[$i]
      embedding_voyage = $null
      page_number      = 1              # OOXML has no pagination; order is chunk_index
      kind             = 'text'
    }
  }
  $body = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json @{ p_rows = $rows } -Depth 6 -Compress))
  try {
    Invoke-RestMethod -Method Post -Uri "$BASE/rest/v1/rpc/insert_text_chunks" -Headers $H -ContentType 'application/json' -Body $body -UserAgent $UA -TimeoutSec 180 | Out-Null
    Invoke-RestMethod -Method Patch -Uri "$BASE/rest/v1/documents?id=eq.$($d.id)" -Headers (@{ apikey=$KEY; Authorization="Bearer $KEY"; Prefer='return=minimal' }) -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes('{"is_indexed":true}')) -UserAgent $UA -TimeoutSec 90 | Out-Null
    $ok++; $chunksTotal += $rows.Count
    if (($ok % 10) -eq 0) { Log "progress: ok=$ok chunks=$chunksTotal empty=$empty fail=$fail" }
  } catch {
    $fail++
    $m = $_.Exception.Message; $rp = $_.Exception.Response
    if ($rp) { try { $sr = New-Object IO.StreamReader($rp.GetResponseStream()); $m = $sr.ReadToEnd() } catch {} }
    Log ("INSERT FAIL :: $($d.file_name) :: " + (($m -replace '\s+',' ').Substring(0, [Math]::Min(200, $m.Length))))
  }
  if ($DelayMs -gt 0) { Start-Sleep -Milliseconds $DelayMs }
}
Remove-Item $tmp -ErrorAction SilentlyContinue
Log "DONE$(if($WhatIf){' (WhatIf)'}): processed=$n ok=$ok chunks=$chunksTotal no_text=$empty failed=$fail"
Log "NOT HANDLED by this script: .doc (legacy binary) and .msg (Outlook) need COM or a parser - 6 documents."
