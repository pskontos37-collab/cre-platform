# gen_help_library.ps1  (ASCII only - PS 5.1)
# Turns the comprehensive wiki content (wiki-portal/wiki-content/*.md) into the
# in-app Help Center resource library:
#   1) parses every MEDIA_BASE link out of the markdown (label + K: relpath),
#   2) uploads document files (pdf/office) to the documents bucket under
#      forms/help/lib/<hash><ext> so the drawer can sign them,
#   3) leaves videos/audio as catalog entries (too large for Supabase; they
#      need a media host to play - surfaced with their location),
#   4) writes src/lib/helpResources.json (collections -> groups -> items).
# Re-runnable (x-upsert). Run with -EmitOnly to regenerate JSON without uploading.

param([switch]$EmitOnly)
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$wikiRoot = 'C:\Users\pskontos\Desktop\Software\wiki-portal\wiki-content'
$outJson  = Join-Path $repoRoot 'src\lib\helpResources.json'
$KM       = 'K:\Property Management'

$envMap = @{}
Get-Content (Join-Path $repoRoot '.env') | ForEach-Object {
  if ($_ -match '^\s*([^#=]+)=(.*)$') { $envMap[$matches[1].Trim()] = $matches[2].Trim() }
}
$baseUrl = $envMap['VITE_SUPABASE_URL']
$svcJwt  = $envMap['SUPABASE_SERVICE_JWT']

# The University and Emergency wiki pages built their links relative to their
# own K: folder, not to K:\Property Management. Re-root those two categories.
$BASE_PREFIX = @{ 'university' = 'M & J University/'; 'emergency' = 'Emergency Procedures Manual/' }

$VIDEO = '.mp4','.mov','.wmv','.avi','.m4v'
$AUDIO = '.m4a','.mp3'
$DOC   = '.pdf','.docx','.doc','.xlsx','.xls','.xlsm','.pptx','.ppt','.csv'

# top-folder -> display category (folders not listed are skipped - prose lives
# in the curated articles in helpContent.ts)
$CATEGORY = @{
  'policy'='Policy Manual'; 'university'='M&J University'; 'forms'='Forms & Templates';
  'emergency'='Emergency & Life Safety';
  'accounting'='Departments'; 'leasing'='Departments'; 'marketing'='Departments';
  'operations'='Departments'; 'licensing'='Departments'; 'portfolio'='Departments';
  'esg'='Departments'; 'hr'='Departments'; 'events'='Departments'
}

function Md5Hash([string]$s) {
  $md5 = [System.Security.Cryptography.MD5]::Create()
  $bytes = $md5.ComputeHash([Text.Encoding]::UTF8.GetBytes($s))
  (($bytes | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0,10)
}
function Get-Mime([string]$ext) {
  switch ($ext.ToLower()) {
    '.pdf'{'application/pdf'} '.xls'{'application/vnd.ms-excel'}
    '.xlsx'{'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}
    '.doc'{'application/msword'}
    '.docx'{'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}
    '.ppt'{'application/vnd.ms-powerpoint'}
    '.pptx'{'application/vnd.openxmlformats-officedocument.presentationml.presentation'}
    '.csv'{'text/csv'} default{'application/octet-stream'}
  }
}

$collections = @()
$uploads = @{}   # storageKey -> local K: full path (dedup)

$mdFiles = Get-ChildItem -LiteralPath $wikiRoot -Recurse -Filter *.md
foreach ($md in $mdFiles) {
  $rel = $md.FullName.Substring($wikiRoot.Length).TrimStart('\')
  $top = ($rel -split '\\')[0]
  if (-not $CATEGORY.ContainsKey($top)) { continue }
  $lines = [IO.File]::ReadAllLines($md.FullName, [Text.Encoding]::UTF8)
  # frontmatter title
  $title = ($rel -replace '\\','/')
  foreach ($l in $lines) { if ($l -match '^title:\s*(.+)$') { $title = $matches[1].Trim(); break } }

  $groups = New-Object System.Collections.ArrayList
  $curLabel = 'General'
  $curItems = New-Object System.Collections.ArrayList
  function Flush {
    if ($curItems.Count -gt 0) { [void]$groups.Add([ordered]@{ label=$curLabel; items=@($curItems) }) }
  }
  foreach ($line in $lines) {
    if ($line -match '^##\s+(.+)$') { Flush; $curLabel = $matches[1].Trim(); $curItems = New-Object System.Collections.ArrayList; continue }
    # NOTE: K: paths contain literal "(" ")" (the URL encoder leaves parens
    # unescaped), so we cannot stop at the first ")". Match minimally up to the
    # ")" that closes the markdown link - i.e. the one followed by a table pipe,
    # a middot separator, the next link, or end-of-line.
    foreach ($m in [regex]::Matches($line, '\[([^\]]+)\]\(MEDIA_BASE/(.*?)\)(?=\s*(?:\||·|\[|$))')) {
      $label = ($m.Groups[1].Value -replace '^[^A-Za-z0-9]+','').Trim()  # strip leading emoji
      $enc   = $m.Groups[2].Value
      $relPath = [uri]::UnescapeDataString($enc)
      if ($BASE_PREFIX.ContainsKey($top)) { $relPath = $BASE_PREFIX[$top] + $relPath }
      $ext = [IO.Path]::GetExtension($relPath).ToLower()
      $item = [ordered]@{ title = $label }
      if ($VIDEO -contains $ext) { $item.kind='video'; $item.loc=$relPath }
      elseif ($AUDIO -contains $ext) { $item.kind='audio'; $item.loc=$relPath }
      elseif ($DOC -contains $ext) {
        $key = 'forms/help/lib/' + (Md5Hash $relPath) + $ext
        $item.kind='doc'; $item.key=$key; $item.pdf = ($ext -eq '.pdf')
        $item.file = [IO.Path]::GetFileName($relPath)
        if (-not $uploads.ContainsKey($key)) { $uploads[$key] = ($KM + '\' + ($relPath -replace '/','\')) }
      }
      else { $item.kind='folder'; $item.loc=$relPath }   # link to a folder of handouts
      [void]$curItems.Add($item)
    }
  }
  Flush
  if ($groups.Count -eq 0) { continue }
  $collections += [ordered]@{ category=$CATEGORY[$top]; key=($rel -replace '\\','/' -replace '\.md$',''); title=$title; groups=@($groups) }
}

# ---- write JSON ----
$catOrder = 'Policy Manual','M&J University','Forms & Templates','Emergency & Life Safety','Departments'
$doc = [ordered]@{
  generated = (Get-Date).ToString('yyyy-MM-dd')
  categoryOrder = $catOrder
  collections = $collections
}
[IO.File]::WriteAllText($outJson, (ConvertTo-Json -InputObject $doc -Depth 8), [Text.UTF8Encoding]::new($false))
$docCount = ($collections | ForEach-Object { $_.groups } | ForEach-Object { $_.items } | Where-Object { $_.kind -eq 'doc' }).Count
$vidCount = ($collections | ForEach-Object { $_.groups } | ForEach-Object { $_.items } | Where-Object { $_.kind -eq 'video' }).Count
Write-Host ("JSON: {0} collections, {1} doc items, {2} unique doc files, {3} videos -> {4}" -f $collections.Count, $docCount, $uploads.Count, $vidCount, $outJson)

if ($EmitOnly) { Write-Host 'EmitOnly - skipping upload.'; return }
if (-not $baseUrl -or -not $svcJwt) { throw 'Missing VITE_SUPABASE_URL/SUPABASE_SERVICE_JWT for upload' }

# ---- upload documents (resilient + resumable) ----
# Uses Invoke-RestMethod (not curl) so a transient TLS error is a catchable
# exception, not a script-aborting NativeCommandError. A done-manifest lets a
# re-run skip already-uploaded files, so the job can be resumed after any glitch.
$doneFile = Join-Path $env:TEMP 'help_lib_uploaded.txt'
$done = @{}
if (Test-Path $doneFile) { Get-Content $doneFile | ForEach-Object { if ($_) { $done[$_] = $true } } }

function Upload-One([string]$key, [string]$src, [string]$mime) {
  # NOTE: use ReadAllBytes + -Body, NOT -InFile. -InFile treats [ ] as wildcards,
  # which breaks every path with a bracketed folder (e.g. "[2024] M & J
  # University Sessions"). ReadAllBytes takes a literal path.
  for ($try = 1; $try -le 3; $try++) {
    try {
      $bytes = [IO.File]::ReadAllBytes($src)
      Invoke-RestMethod -Method Post -Uri "$baseUrl/storage/v1/object/documents/$key" `
        -Headers @{ Authorization = "Bearer $svcJwt"; 'x-upsert' = 'true' } `
        -ContentType $mime -Body $bytes -UserAgent 'cre-help-loader' -TimeoutSec 600 | Out-Null
      return $true
    } catch {
      if ($try -eq 3) { return $false }
      Start-Sleep -Seconds 2
    }
  }
  return $false
}

$ok=0; $skip=0; $miss=0; $fail=0; $n=0; $tot=$uploads.Count
$failedKeys = @()
foreach ($key in $uploads.Keys) {
  $n++
  if ($done.ContainsKey($key)) { $skip++; continue }
  $src = $uploads[$key]
  if (-not (Test-Path -LiteralPath $src)) { $miss++; continue }
  if ((Get-Item -LiteralPath $src).Length -gt 240MB) { $fail++; $failedKeys += $key; continue }  # too big for bucket -> media host
  if (Upload-One $key $src (Get-Mime ([IO.Path]::GetExtension($src)))) {
    $ok++; Add-Content -Path $doneFile -Value $key
  } else { $fail++; $failedKeys += $key }
  if ($n % 50 -eq 0) { Write-Host ("  ...{0}/{1} (ok {2}, skip {3}, miss {4}, fail {5})" -f $n,$tot,$ok,$skip,$miss,$fail) }
}
Write-Host ("UPLOAD DONE: ok {0}, skipped {1}, missing-on-K {2}, failed {3}, of {4}" -f $ok,$skip,$miss,$fail,$tot)
if ($failedKeys.Count) { Write-Host 'FAILED KEYS:'; $failedKeys | ForEach-Object { Write-Host ("  " + $_) } }
