# ingest_legacy_office_text.ps1 - text layer for legacy .doc and Outlook .msg files.
#
# The companion to ingest_ooxml_text.ps1, which handles .docx/.pptx with pure
# ZIP+XML. These two formats cannot use that route: both .doc and .msg are OLE
# Compound File binaries, not ZIP archives, so COM is the practical option.
#
# WHY COM IS ACCEPTABLE HERE, given project_emergency_manuals records that Word COM
# HANGS: the hang was on ExportAsFixedFormat, i.e. RENDERING to PDF. This script
# never renders. It opens read-only and reads .Content.Text, which is a far lighter
# path. Belt and braces anyway: Visible=false, DisplayAlerts suppressed,
# ConfirmConversions=false so no format-conversion dialog can block, and
# AutomationSecurity forced to disable macros - these are third-party files pulled
# from a deal room, so macro execution must be off, not merely unlikely.
#
# .msg gives more than a body: subject, from, to and sent date are prepended so a
# retrieval hit reads as correspondence rather than an anonymous block of text, and
# attachment FILENAMES are listed (the attachments themselves are separate documents
# and are not extracted here).
#
# Chunking mirrors pdf-extract and ingest_ooxml_text.ps1 (1400 chars, 200 overlap,
# prefer paragraph > line > sentence in the window tail). If those constants change
# in the edge function, change them in BOTH scripts or ranking drifts apart.
#
# page_number is 1: neither format has pagination that survives extraction. Order is
# chunk_index. Same consequence as the OOXML pass - searchable, not deep-linkable
# until rendered to PDF.
#
#   .\ingest_legacy_office_text.ps1 -WhatIf
#   .\ingest_legacy_office_text.ps1
param(
  [int]$Limit = 0,
  [switch]$WhatIf
)
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$SKEY = if ($cfg['SUPABASE_SERVICE_JWT']) { $cfg['SUPABASE_SERVICE_JWT'] } else { $KEY }
$UA = 'cre-loader/1.0'
$H  = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$log = "$PSScriptRoot\ingest_legacy_office_text.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }

$CHUNK = 1400; $OVERLAP = 200

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
  # Unary comma required - see ingest_ooxml_text.ps1. Without it a one-element list
  # returns as a bare string and $pieces[0] yields its first CHARACTER.
  return ,$res
}

# ---------------------------------------------------------------------------
# Minimal CFB (MS-CFB / OLE Compound File) reader, enough to pull MAPI property
# streams out of a .msg (MS-OXMSG). Streams are named __substg1.0_<TAG><TYPE>;
# the plain-text body is PR_BODY 0x1000, type 001F (Unicode) or 001E (CP1252).
#
# This replaced two failed approaches:
#   - Outlook COM opened a modal "700 Reminder(s)" window and BLOCKED (242s CPU,
#     never advanced past file 1). Same class as the documented Word COM hang.
#   - Scraping printable runs from the bytes returned 46,073 chars of MAPI property
#     names and Exchange headers, not the body. PR_TRANSPORT_MESSAGE_HEADERS
#     (007D001F) alone is ~9.8KB of headers, which is what that noise mostly was.
#
# Three bugs worth remembering, all hit while writing this:
#   1. Special sector values (0xFFFFFFFE/FF/FD/FC) must be bounds-checked at EVERY
#      hop, not just compared against the two commonest - one slipped through and
#      produced a file offset of 0x20000000000.
#   2. Some writers leave the DIFAT start sector as 0 rather than ENDOFCHAIN, so
#      walking it unconditionally reads sector 0 as DIFAT garbage. Gate on nDifat.
#   3. Do NOT return a scriptblock accessor closed over the FAT tables - invoked
#      from the caller's scope those names are gone. Pre-extract and return data.
function Read-CfbProps([string]$path) {
  $b = [IO.File]::ReadAllBytes($path)
  if ($b.Length -lt 512) { throw 'file too small to be CFB' }
  $sig = ($b[0..7] | ForEach-Object { $_.ToString('X2') }) -join ''
  if ($sig -ne 'D0CF11E0A1B11AE1') { throw "not a compound file (sig=$sig)" }

  $secSize   = 1 -shl [BitConverter]::ToUInt16($b, 30)
  $miniSize  = 1 -shl [BitConverter]::ToUInt16($b, 32)
  $nFat      = [BitConverter]::ToUInt32($b, 44)
  $dirStart  = [BitConverter]::ToUInt32($b, 48)
  $miniCut   = [BitConverter]::ToUInt32($b, 56)
  $miniFatSt = [BitConverter]::ToUInt32($b, 60)
  $nMiniFat  = [BitConverter]::ToUInt32($b, 64)
  $difatSt   = [BitConverter]::ToUInt32($b, 68)
  $nDifat    = [BitConverter]::ToUInt32($b, 72)
  $maxSector = [uint32](([int64]$b.Length / $secSize) + 2)

  function SecOff([uint32]$s) { return ([int64]$s + 1) * [int64]$secSize }
  function OkSector([uint32]$s) { return ([int64]$s -lt [int64]$maxSector) }

  $fatSectors = New-Object System.Collections.Generic.List[uint32]
  for ($i = 0; $i -lt 109; $i++) {
    $v = [BitConverter]::ToUInt32($b, 76 + ($i * 4))
    if (OkSector $v) { $fatSectors.Add($v) }
  }
  if ($nDifat -gt 0) {
    $ds = $difatSt; $g = 0
    while ((OkSector $ds) -and $g -lt 1000) {
      $g++
      [int64]$off = SecOff $ds
      if ($off + $secSize -gt $b.Length) { break }
      for ($i = 0; $i -lt ([int]($secSize / 4) - 1); $i++) {
        $v = [BitConverter]::ToUInt32($b, $off + ($i * 4))
        if (OkSector $v) { $fatSectors.Add($v) }
      }
      $ds = [BitConverter]::ToUInt32($b, $off + ($secSize - 4))
    }
  }
  $fat = New-Object System.Collections.Generic.List[uint32]
  foreach ($fs in $fatSectors) {
    [int64]$off = SecOff $fs
    if ($off + $secSize -gt $b.Length) { continue }
    for ($i = 0; $i -lt ($secSize / 4); $i++) { $fat.Add([BitConverter]::ToUInt32($b, $off + ($i * 4))) }
  }

  function ChainBytes([uint32]$start, [int64]$size) {
    $ms = New-Object IO.MemoryStream
    $s = $start; $g = 0
    while ((OkSector $s) -and $g -lt 200000) {
      $g++
      [int64]$off = SecOff $s
      if ($off -lt 0 -or $off -ge [int64]$b.Length) { break }
      [int64]$len = [Math]::Min([int64]$secSize, ([int64]$b.Length - $off))
      if ($len -le 0) { break }
      $ms.Write($b, [int]$off, [int]$len)
      if ([int64]$s -ge [int64]$fat.Count) { break }
      $s = $fat[[int]$s]
    }
    $all = $ms.ToArray(); $ms.Dispose()
    if ($size -gt 0 -and $size -lt $all.Length) { return $all[0..([int]$size - 1)] }
    return $all
  }

  $miniFat = New-Object System.Collections.Generic.List[uint32]
  if ($nMiniFat -gt 0) {
    $mf = ChainBytes $miniFatSt 0
    for ($i = 0; $i + 3 -lt $mf.Length; $i += 4) { $miniFat.Add([BitConverter]::ToUInt32($mf, $i)) }
  }

  $dirBytes = ChainBytes $dirStart 0
  $entries = @()
  for ($i = 0; ($i + 128) -le $dirBytes.Length; $i += 128) {
    $nl = [BitConverter]::ToUInt16($dirBytes, $i + 64)
    $nm = ''
    if ($nl -gt 2) { $nm = [Text.Encoding]::Unicode.GetString($dirBytes, $i, $nl - 2) }
    $entries += [pscustomobject]@{ Name=$nm; Type=$dirBytes[$i+66]
                                  Start=[BitConverter]::ToUInt32($dirBytes,$i+116)
                                  Size=[BitConverter]::ToInt64($dirBytes,$i+120) }
  }
  # The root entry's chain IS the mini stream that mini sectors index into.
  $rootE = $entries | Where-Object { $_.Type -eq 5 } | Select-Object -First 1
  $miniStream = if ($rootE) { ChainBytes $rootE.Start $rootE.Size } else { New-Object byte[] 0 }

  function MiniBytes([uint32]$start, [int64]$size) {
    $ms = New-Object IO.MemoryStream
    $s = $start; $g = 0
    [int64]$miniMax = [int64]($miniStream.Length / $miniSize) + 1
    while ([int64]$s -lt $miniMax -and $g -lt 200000) {
      $g++
      [int64]$off = [int64]$s * [int64]$miniSize
      if ($off -lt 0 -or ($off + [int64]$miniSize) -gt [int64]$miniStream.Length) { break }
      $ms.Write($miniStream, [int]$off, [int]$miniSize)
      if ([int64]$s -ge [int64]$miniFat.Count) { break }
      $s = $miniFat[[int]$s]
    }
    $all = $ms.ToArray(); $ms.Dispose()
    if ($size -gt 0 -and $size -lt $all.Length) { return $all[0..([int]$size - 1)] }
    return $all
  }

  $props = @{}
  foreach ($e in $entries) {
    if ($e.Type -ne 2 -or $e.Name -notlike '__substg1.0_*') { continue }
    if ($e.Name -like '__substg1.0_3701*') { continue }        # attachment payload
    if ($e.Size -le 0 -or $e.Size -gt 4194304) { continue }
    $bytes = if ($e.Size -lt $miniCut) { MiniBytes $e.Start $e.Size } else { ChainBytes $e.Start $e.Size }
    # Flat entry read means an attachment sub-storage can repeat a message tag; largest wins.
    if (-not $props.ContainsKey($e.Name) -or $props[$e.Name].Length -lt $bytes.Length) { $props[$e.Name] = $bytes }
  }
  return $props
}

function Get-MsgProp($props, [string]$tagHex) {
  $u = "__substg1.0_${tagHex}001F"
  if ($props.ContainsKey($u)) { return [Text.Encoding]::Unicode.GetString($props[$u]) }
  $a = "__substg1.0_${tagHex}001E"
  if ($props.ContainsKey($a)) { return [Text.Encoding]::GetEncoding(1252).GetString($props[$a]) }
  return ''
}

# Outlook rewrites every link through safelinks, turning one URL into 400+ chars of
# base64 tracking payload. Left in, a short approval email becomes mostly URL noise
# and retrieval suffers. Unwrap to the real target, then drop any URL still absurd.
function Strip-Safelinks([string]$t) {
  if (-not $t) { return '' }
  $t = [regex]::Replace($t, 'https?://[a-z0-9.\-]*safelinks\.protection\.outlook\.com/\?url=([^&>\s]+)[^>\s]*', {
    param($m)
    try { [uri]::UnescapeDataString($m.Groups[1].Value) } catch { '' }
  })
  $t = [regex]::Replace($t, '<?https?://\S{160,}>?', '[long-url-removed]')
  return $t
}

function Clean-Text([string]$t) {
  if (-not $t) { return '' }
  $t = $t -replace "`r`n", "`n" -replace "`r", "`n"
  $t = $t -replace "\x0c", "`n"                       # form feed
  $t = [regex]::Replace($t, '[\x00-\x08\x0b\x0e-\x1f]', ' ')
  $t = [regex]::Replace($t, '[ \t]+', ' ')
  $t = [regex]::Replace($t, '(\r?\n){3,}', "`n`n")
  return $t.Trim()
}

# ---- targets ----
$docs = New-Object System.Collections.Generic.List[object]
$off = 0
while ($true) {
  $page = Invoke-RestMethod -Uri "$BASE/rest/v1/documents?select=id,file_name,storage_path,property_id&storage_path=not.is.null&order=id.asc&limit=1000&offset=$off" -Headers $H -UserAgent $UA -TimeoutSec 120
  if (-not $page -or $page.Count -eq 0) { break }
  foreach ($d in $page) {
    $nm = if ($d.file_name) { $d.file_name } else { $d.storage_path }
    if ($nm -match '\.(doc|msg)$') { $docs.Add($d) }     # \.doc$ only - .docx handled elsewhere
  }
  $off += 1000
  if ($page.Count -lt 1000) { break }
}
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
Log "legacy Office candidates: $($docs.Count) | to process: $($todo.Count)"
if (-not $todo.Count) { Log 'nothing to do'; return }

# ---- COM apps, started once and only if needed ----
#
# HARD SAFETY GUARD. Word registers a single-instance automation server, so
# New-Object -ComObject Word.Application can ATTACH to a Word the user already has
# open rather than creating its own. If it attaches, then Visible=$false hides their
# window and Quit(0) discards their unsaved changes. On 2026-07-29 this machine had
# WINWORD running with the window title "Document3 - AutoRecovered - Word" - an
# unsaved crash-recovered document. Quitting that would have destroyed real work.
# So: if Word is ALREADY running we never create the object at all, and .doc files
# fall back to binary extraction. Only quit what this script itself started.
$word = $null; $outlook = $null
$startedWord = $false; $startedOutlook = $false
$wordAlreadyRunning    = [bool](Get-Process WINWORD -ErrorAction SilentlyContinue)
$outlookAlreadyRunning = [bool](Get-Process OUTLOOK -ErrorAction SilentlyContinue)
$needWord = @($todo | Where-Object { (($_.file_name, $_.storage_path -ne $null)[0]) -match '\.doc$' }).Count -gt 0
$needOl   = @($todo | Where-Object { (($_.file_name, $_.storage_path -ne $null)[0]) -match '\.msg$' }).Count -gt 0
if ($wordAlreadyRunning) {
  Log 'WINWORD is ALREADY RUNNING - refusing to touch Word COM (attaching could hide the window or discard unsaved work). .doc files will use binary fallback.'
}

# Fallback .doc reader: legacy .doc is an OLE compound binary, not ZIP. Rather than
# parse CFB properly for two files, pull printable runs - single-byte and UTF-16LE -
# and keep whichever yields more. Verified good on a real LOI: 10,443 chars of fully
# coherent prose with dates, addresses, $51,275,000, a 7.0% cap rate and the PSA
# terms all intact.
#
# CP1252 PUNCTUATION IS MAPPED, NOT DROPPED. The first version filtered to bytes
# 32..126, which silently ate every curly apostrophe and quote - Word writes those as
# 0x91-0x94 - producing "Seller s legal counsel" and "(the )" where a defined term's
# quoted name had been. Substance survived but possessives and defined terms were
# damaged, which for an LOI is exactly the wrong thing to lose.
$script:CP1252 = @{
  0x91 = "'"; 0x92 = "'"; 0x93 = '"'; 0x94 = '"'
  0x95 = '*'; 0x96 = '-'; 0x97 = '-'; 0x85 = '...'
  0xA0 = ' '; 0xB7 = '*'; 0x99 = '(TM)'; 0xAE = '(R)'; 0xA9 = '(C)'
}
function Convert-Byte([int]$b) {
  if (($b -ge 32 -and $b -le 126) -or $b -eq 9) { return [string][char]$b }
  if ($script:CP1252.ContainsKey($b)) { return [string]$script:CP1252[$b] }
  return $null
}
function Get-LegacyDocText([string]$path) {
  $bytes = [IO.File]::ReadAllBytes($path)
  $minRun = 6
  $sb1 = New-Object Text.StringBuilder; $run = New-Object Text.StringBuilder
  foreach ($b in $bytes) {
    $c = Convert-Byte $b
    if ($c) { [void]$run.Append($c) }
    else { if ($run.Length -ge $minRun) { [void]$sb1.AppendLine($run.ToString()) }; [void]$run.Clear() }
  }
  if ($run.Length -ge $minRun) { [void]$sb1.AppendLine($run.ToString()) }
  $single = $sb1.ToString()

  $sb2 = New-Object Text.StringBuilder; $run2 = New-Object Text.StringBuilder
  for ($i = 0; $i -lt $bytes.Length - 1; $i += 2) {
    $c = $null
    if ($bytes[$i + 1] -eq 0) { $c = Convert-Byte $bytes[$i] }
    if ($c) { [void]$run2.Append($c) }
    else { if ($run2.Length -ge $minRun) { [void]$sb2.AppendLine($run2.ToString()) }; [void]$run2.Clear() }
  }
  if ($run2.Length -ge $minRun) { [void]$sb2.AppendLine($run2.ToString()) }
  $wide = $sb2.ToString()

  if ($wide.Length -gt $single.Length) { return $wide } else { return $single }
}

$ok = 0; $empty = 0; $fail = 0; $chunksTotal = 0; $n = 0; $skippedMsg = 0
$tmpDir = "$env:TEMP\_legacy_office"
if (-not (Test-Path $tmpDir)) { New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null }

try {
  if ($needWord -and -not $WhatIf -and -not $wordAlreadyRunning) {
    $word = New-Object -ComObject Word.Application
    $startedWord = $true
    $word.Visible = $false
    $word.DisplayAlerts = 0
    # msoAutomationSecurityForceDisable - never run macros in a third-party file.
    try { $word.AutomationSecurity = 3 } catch {}
    Log 'Word COM started BY THIS SCRIPT (text-only read; no PDF render)'
  }
  # Outlook COM is NEVER started - .msg is parsed directly from the compound file.
  # Recorded so nobody re-tries COM: launching Outlook opened a modal "700
  # Reminder(s)" window that blocked automation entirely (242s CPU, no progress).
  if ($needOl) { Log ".msg files present ($(@($todo | Where-Object { (($_.file_name, $_.storage_path -ne $null)[0]) -match '\.msg$' }).Count)) - reading via CFB parser, no Outlook COM" }

  foreach ($d in $todo) {
    if ($Limit -gt 0 -and $n -ge $Limit) { break }
    $n++
    $nm = if ($d.file_name) { $d.file_name } else { $d.storage_path }
    $ext = ([IO.Path]::GetExtension($nm)).ToLower()
    $local = Join-Path $tmpDir ("f{0}{1}" -f $n, $ext)
    $enc = (($d.storage_path -split '/' | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/')
    $code = & curl.exe -s -o $local -w '%{http_code}' "$BASE/storage/v1/object/documents/$enc" -H "Authorization: Bearer $SKEY" -H "apikey: $SKEY"
    if ("$code" -notmatch '^2') { $fail++; Log "DOWNLOAD FAIL http=$code :: $nm"; continue }

    $text = ''
    if ($ext -eq '.doc') {
      if ($WhatIf) { Log "WOULD READ ($(if($word){'Word'}else{'binary fallback'})) :: $nm"; $ok++; continue }
      if ($word) {
        $doc = $null
        try {
          # ConfirmConversions=false so a legacy-format prompt cannot block the run.
          $doc = $word.Documents.Open($local, $false, $true, $false)   # Confirm, ReadOnly, AddToRecentFiles
          $text = Clean-Text $doc.Content.Text
        } catch {
          Log "WORD FAIL :: $nm :: $($_.Exception.Message)"
        } finally {
          if ($doc) { try { $doc.Close(0) } catch {}; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($doc) }
        }
      } else {
        try { $text = Clean-Text (Get-LegacyDocText $local); Log "binary-fallback read ($($text.Length) chars) :: $nm" }
        catch { Log "BINARY FALLBACK FAIL :: $nm :: $($_.Exception.Message)" }
      }
    }
    elseif ($ext -eq '.msg') {
      if ($WhatIf) { Log "WOULD READ (CFB parser) :: $nm"; $ok++; continue }
      try {
        $props = Read-CfbProps $local
        $hdr = @()
        $subj = Get-MsgProp $props '0037'; if ($subj) { $hdr += "Subject: $subj" }
        $from = Get-MsgProp $props '0C1A'; if ($from) { $hdr += "From: $from" }
        $to   = Get-MsgProp $props '0E04'; if ($to)   { $hdr += "To: $to" }
        $cc   = Get-MsgProp $props '0E03'; if ($cc)   { $hdr += "Cc: $cc" }
        # Attachment long-filenames (3707) - the payloads themselves are separate docs.
        $att = @()
        foreach ($k in $props.Keys) {
          if ($k -like '__substg1.0_3707001F') { $att += [Text.Encoding]::Unicode.GetString($props[$k]) }
        }
        if ($att.Count) { $hdr += "Attachments: " + (($att | Sort-Object -Unique) -join '; ') }
        $bodyTxt = Get-MsgProp $props '1000'
        if (-not $bodyTxt) { $bodyTxt = Get-MsgProp $props '1013' }   # HTML body fallback
        $bodyTxt = Strip-Safelinks $bodyTxt
        $text = Clean-Text (($hdr -join "`n") + "`n`n" + $bodyTxt)
        Log "CFB read ($($text.Length) chars, body $($bodyTxt.Length)) :: $nm"
      } catch {
        # A .msg that is not a compound file is usually MISLABELLED. One in this
        # corpus (5.5MB "RE_ Title Company - CCR and REA...msg") is actually a PDF:
        # signature 255044462D312E36 = "%PDF-1.6". Say so explicitly rather than
        # reporting a generic parse failure, because the fix is to re-route it to
        # pdf-extract, not to improve this parser.
        $msg = $_.Exception.Message
        if ($msg -match 'sig=25504446') {
          Log "MISLABELLED :: $nm :: this is a PDF, not a .msg - route it through pdf-extract (reindexText) instead"
        } else {
          Log "CFB FAIL :: $nm :: $msg"
        }
      }
    }

    Remove-Item $local -ErrorAction SilentlyContinue
    if ([string]::IsNullOrWhiteSpace($text) -or $text.Length -lt 40) { $empty++; Log "NO TEXT ($($text.Length) chars) :: $nm"; continue }
    $pieces = Split-Windows $text
    if (-not $pieces.Count) { $empty++; continue }

    $rows = @()
    for ($i = 0; $i -lt $pieces.Count; $i++) {
      $rows += @{ document_id=$d.id; property_id=$d.property_id; chunk_index=(1000 + $i)
                  content=$pieces[$i]; embedding_voyage=$null; page_number=1; kind='text' }
    }
    # MUST force an ARRAY - see ingest_ooxml_text.ps1. PS 5.1 ConvertTo-Json unwraps
    # a single-element array to a bare object, and insert_text_chunks then stored one
    # CHARACTER while returning HTTP 200. Silently truncated 5 documents.
    $arrJson = if ($rows.Count -eq 1) { '[' + (ConvertTo-Json $rows[0] -Depth 6 -Compress) + ']' }
               else { ConvertTo-Json $rows -Depth 6 -Compress }
    $body2 = [Text.Encoding]::UTF8.GetBytes('{"p_rows":' + $arrJson + '}')
    try {
      Invoke-RestMethod -Method Post -Uri "$BASE/rest/v1/rpc/insert_text_chunks" -Headers $H -ContentType 'application/json' -Body $body2 -UserAgent $UA -TimeoutSec 180 | Out-Null
      Invoke-RestMethod -Method Patch -Uri "$BASE/rest/v1/documents?id=eq.$($d.id)" -Headers (@{ apikey=$KEY; Authorization="Bearer $KEY"; Prefer='return=minimal' }) -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes('{"is_indexed":true}')) -UserAgent $UA -TimeoutSec 90 | Out-Null
      $ok++; $chunksTotal += $rows.Count
      Log ("OK {0} chunks ({1} chars) :: {2}" -f $rows.Count, $text.Length, $nm)
    } catch {
      $fail++
      $m = $_.Exception.Message; $rp = $_.Exception.Response
      if ($rp) { try { $sr = New-Object IO.StreamReader($rp.GetResponseStream()); $m = $sr.ReadToEnd() } catch {} }
      Log ("INSERT FAIL :: $nm :: " + (($m -replace '\s+',' ').Substring(0, [Math]::Min(200, $m.Length))))
    }
  }
}
finally {
  # Quit ONLY what this script started. Quitting an instance the user already had
  # open would close their documents - and on 2026-07-29 the open one was an unsaved
  # AutoRecovered document. Release the reference either way so no orphan lingers.
  if ($word) {
    if ($startedWord) { try { $word.Quit(0) } catch {} } else { Log 'left the pre-existing Word instance alone' }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word)
  }
  if ($outlook) {
    if ($startedOutlook) { try { $outlook.Quit() } catch {} } else { Log 'left the pre-existing Outlook instance alone' }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($outlook)
  }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
Log "DONE$(if($WhatIf){' (WhatIf)'}): processed=$n ok=$ok chunks=$chunksTotal no_text=$empty failed=$fail msg_skipped=$skippedMsg"
