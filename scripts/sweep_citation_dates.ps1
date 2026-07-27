param(
  [string]$PropertyId = '',
  [int]$MaxDocs = 0,
  [string]$ReportDir = '',
  [switch]$Verbose
)
$ErrorActionPreference = "Stop"
# ---------------------------------------------------------------------------
# CITATION-DATE SWEEP -- deterministic, no AI, no spend, READ-ONLY.
#
# A lease amendment (or estoppel, SNDA, assignment) recites its own chain:
#   "...as amended by that certain First Amendment of Lease dated July 22, 2022..."
# If we HOLD that First Amendment but it is dated July 22, 2020, the citing
# document is WRONG -- and any abstract that followed the citation inherits the
# error silently. Wild Wing Cafe is a confirmed live example: its 2nd Amendment
# misdates the 1st by two years, and its abstract cites the base lease, the
# assignment and the 2nd Amendment while never pulling in the 1st.
#
# This is a DIFFERENT defect from "recited but not found". Here we DO hold the
# instrument; the citation's date is wrong. The two need opposite fixes, so they
# are reported separately.
#
# HOW A CITATION IS IDENTIFIED: by its instrument IDENTITY (kind + ordinal), not
# by its date -- matching on date would be circular. "First Amendment" is matched
# against the in-scope document classified lease_amendment whose filename ordinal
# is 1, and only THEN are the dates compared.
#
# Reads doc_subtype straight from the register (populated 2026-07-27), so the
# classification is not re-derived here.
#
# FAIL-CLOSED: a citation is only judged when its referent is UNAMBIGUOUS -- one
# candidate at that kind+ordinal in that tenant scope. Ambiguous or unidentifiable
# citations are counted and set aside, never guessed at.
#
# NOTE: the date helpers below intentionally duplicate a few functions from
# classify_doc_families.ps1 rather than refactoring that script, which has
# already been applied against prod. Consolidate later, deliberately.
#
# Usage:
#   powershell -File sweep_citation_dates.ps1
#   powershell -File sweep_citation_dates.ps1 -PropertyId <uuid> -MaxDocs 50
# ---------------------------------------------------------------------------

$ROOT = "C:\Users\pskontos\Desktop\Software\cre-platform"
$cfg = @{}
foreach ($l in (Get-Content "$ROOT\.env" | Where-Object { $_ -match "=" })) {
  $k,$v = $l -split '=',2; $cfg[$k.Trim()] = $v.Trim()
}
$SUPA_URL = $cfg['VITE_SUPABASE_URL']; $SUPA_KEY = $cfg['SUPABASE_SECRET_KEY']
if (-not $SUPA_URL -or -not $SUPA_KEY) { throw "missing VITE_SUPABASE_URL / SUPABASE_SECRET_KEY in .env" }
if (-not $ReportDir) { $ReportDir = "$env:LOCALAPPDATA" }

# Only an AMENDMENT's recital is treated as a judgeable claim about its own chain.
# Lender and third-party instruments (SNDA, estoppel) are routinely filed INTO a
# tenant folder while referencing a different lease: SNDA-KeyBank sits in the Best
# Buy folder and cites a 2018 second amendment, which got matched against Best
# Buy's 2011 one. Folder + ordinal is not identity for those, so they are not
# judged -- only counted.
$CITING_SUBTYPES = @('lease_amendment')
# subtypes that can BE cited
$TARGET_SUBTYPES = @('lease_original','lease_amendment','lease_assignment','lease_assumption',
                     'guaranty','lease_memorandum','snda','lease_termination')

$MONTHS = @{
  'january'=1;'jan'=1;'february'=2;'feb'=2;'march'=3;'mar'=3;'april'=4;'apr'=4;'may'=5
  'june'=6;'jun'=6;'july'=7;'jul'=7;'august'=8;'aug'=8;'september'=9;'sept'=9;'sep'=9
  'october'=10;'oct'=10;'november'=11;'nov'=11;'december'=12;'dec'=12
}
$MONTH_RX = '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)'
$DATE_ALT = "$MONTH_RX\s*\.?\s*\d{1,2}\s*(?:st|nd|rd|th)?\s*,?\s*\d{4}|\d{1,2}\s*(?:st|nd|rd|th)?[^A-Za-z0-9]{0,12}day\s*[co]f\s*$MONTH_RX\s*,?\s*\d{4}|$MONTH_RX\s*,?\s*\d{4}"
$WORD_ORD = @{
  'first'=1;'second'=2;'third'=3;'fourth'=4;'fifth'=5;'sixth'=6;'seventh'=7;'eighth'=8
  'ninth'=9;'tenth'=10;'eleventh'=11;'twelfth'=12
  '1st'=1;'2nd'=2;'3rd'=3;'4th'=4;'5th'=5;'6th'=6;'7th'=7;'8th'=8;'9th'=9;'10th'=10;'11th'=11;'12th'=12
}
$ORD_WORDS = 'first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th|11th|12th'
$FNAME_ORD_RX = "(?i)\b($ORD_WORDS)\b"
$FNAME_DATE_RX = '\((\d{1,2})[-\.](\d{1,2})[-\.](\d{2,4})\)|\((\d{1,2})[-\.](\d{4})\)|\((\d{4})\)'
$CONTAINER_RX = '(?i)^(_?TERMINATED\s+TENANTS|.*FORMER\s+TENANTS|_?INACTIVE.*|_?OLD\s+TENANTS)$'

function ConvertTo-Iso($monthTok, $dayTok, $yearTok) {
  if (-not $monthTok) { return $null }
  $mk = ([string]$monthTok).ToLower().Trim('.',' ')
  if (-not $MONTHS.ContainsKey($mk)) { return $null }
  $mo = $MONTHS[$mk]; $yr = 0
  if (-not [int]::TryParse([string]$yearTok, [ref]$yr)) { return $null }
  if ($yr -lt 1900 -or $yr -gt 2100) { return $null }
  $dy = 0
  if (-not [int]::TryParse([string]$dayTok, [ref]$dy)) { $dy = 0 }
  if ($dy -lt 1 -or $dy -gt 31) { $dy = 0 }
  return ("{0:0000}-{1:00}-{2:00}" -f $yr, $mo, $dy)
}

# PRE-COMPILED regexes. .NET caches only ~15 patterns by default; this script
# cycles more than that per document, so [regex]::Match(str, pattern) was
# recompiling on nearly every call -- 10 seconds per document. Build the objects
# once, with a match timeout as a backstop against pathological backtracking.
$RXOPT = [System.Text.RegularExpressions.RegexOptions]::IgnoreCase -bor [System.Text.RegularExpressions.RegexOptions]::Compiled
$RXTIMEOUT = [TimeSpan]::FromSeconds(5)
function New-Rx([string]$pattern) {
  return New-Object System.Text.RegularExpressions.Regex($pattern, $RXOPT, $RXTIMEOUT)
}
$RX_DATE_MDY  = New-Rx "($MONTH_RX)\s*\.?\s*(\d{1,2})\s*(?:st|nd|rd|th)?\s*,?\s*(\d{4})"
$RX_DATE_DAYOF = New-Rx "(\d{1,2})?\s*(?:st|nd|rd|th)?[^A-Za-z0-9]{0,12}day\s*[co]f\s*($MONTH_RX)\s*,?\s*(\d{4})"
$RX_DATE_MY   = New-Rx "($MONTH_RX)\s*,?\s*(\d{4})"
$RX_FNAME_ORD = New-Rx "\b($ORD_WORDS)\b"
$RX_ORD_AMD   = New-Rx "(?:\b($ORD_WORDS)\b[\s\-]*(?:AMD|Amendment)\b)|(?:\b(?:AMD|Amendment)\b[\s\-]*($ORD_WORDS)\b)"
$RX_FNAME_DATE = New-Rx $FNAME_DATE_RX

function Get-ProseDate([string]$span) {
  # the FIRST date in a citation phrase (a citation names one instrument)
  $m = $RX_DATE_MDY.Match($span)
  if ($m.Success) { return ConvertTo-Iso $m.Groups[1].Value $m.Groups[2].Value $m.Groups[3].Value }
  $m = $RX_DATE_DAYOF.Match($span)
  if ($m.Success) { return ConvertTo-Iso $m.Groups[2].Value $m.Groups[1].Value $m.Groups[3].Value }
  $m = $RX_DATE_MY.Match($span)
  if ($m.Success) { return ConvertTo-Iso $m.Groups[1].Value '' $m.Groups[2].Value }
  return $null
}

function Get-FilenameDate([string]$name) {
  $m = $RX_FNAME_DATE.Match($name)
  if (-not $m.Success) { return $null }
  if ($m.Groups[1].Success) {
    $mo = [int]$m.Groups[1].Value; $dy = [int]$m.Groups[2].Value; $yr = [int]$m.Groups[3].Value
  } elseif ($m.Groups[4].Success) {
    $mo = [int]$m.Groups[4].Value; $dy = 1; $yr = [int]$m.Groups[5].Value
  } else { $mo = 1; $dy = 1; $yr = [int]$m.Groups[6].Value }
  if ($yr -lt 100) { if ($yr -ge 40) { $yr = 1900 + $yr } else { $yr = 2000 + $yr } }
  if ($mo -lt 1 -or $mo -gt 12 -or $dy -lt 1 -or $dy -gt 31) { return $null }
  return ("{0:0000}-{1:00}-{2:00}" -f $yr, $mo, $dy)
}

function Get-FilenameOrdinal([string]$name) {
  # The ordinal must belong to an AMENDMENT token. Taking the first ordinal
  # anywhere in the filename read "1st Mod to 2006 AMD-Kohls" as amendment #1 --
  # that "1st" numbers the Modification, not the amendment -- and an estoppel
  # citing the 1964 EJ Korvette amendment was matched against it.
  $m = $RX_ORD_AMD.Match($name)
  if (-not $m.Success) { return $null }
  $k = $m.Groups[1].Value
  if (-not $k) { $k = $m.Groups[2].Value }
  if (-not $k) { return $null }
  $k = $k.ToLower()
  if ($WORD_ORD.ContainsKey($k)) { return $WORD_ORD[$k] }
  return $null
}

function Get-TenantScope([string]$path) {
  $p = $path -replace '^file:',''
  $seg = @($p.Split('\') | Where-Object { $_ -ne '' })
  for ($i = 0; $i -lt $seg.Count - 1; $i++) {
    if ($seg[$i] -eq 'TENANTS') {
      $j = $i + 1
      if ($seg[$j] -match $CONTAINER_RX -and $j + 1 -lt $seg.Count) { $j = $j + 1 }
      return (($seg[0..$j]) -join '\')
    }
  }
  return $null
}

# --- citation patterns -----------------------------------------------------
# Each yields: kind (maps to doc_subtype), optional ordinal, and a date.
# Ordered most-specific first; an ordinal-bearing amendment citation is the
# highest-value form because its referent is unambiguous.
# ONLY ordinal-bearing amendment citations are judged. For every other instrument
# kind there is no ordinal, so the referent would have to be guessed as "the only
# document of that subtype in this folder" -- and that is not identity. The smoke
# run proved the point: an estoppel citing a 1987 memorandum was matched to
# STAPLES' memorandum, and an SNDA citing a 1978 memorandum to a 2011 HomeGoods
# one. Both plainly different instruments. Unidentifiable citations are counted
# and set aside, never judged.
#
# Gaps are deliberately TIGHT. Text chunks overlap, so joining them can place
# "First" next to a later clause's date; a generous gap then pairs an ordinal with
# the wrong date. That produced a false "Krispy Kreme 1st Amendment misdated"
# when its recital is in fact correct.
$CITATION_RX = @(
  @{ kind='lease_amendment'; hasOrd=$true;
     rx="(?i)\b($ORD_WORDS)\s+Amendment(?:\s+(?:to|of)\s+(?:the\s+)?Lease)?[^.;]{0,18}?\bdated\b[^.;]{0,22}?($DATE_ALT)" }
)
# kinds we parse for counting/coverage only -- never used to assert a misdate
$UNJUDGED_RX = @(
  @{ kind='lease_amendment_no_ordinal'; rx="(?i)\bAmendment\s+(?:to|of)\s+(?:the\s+)?Lease[^.;]{0,18}?\bdated\b[^.;]{0,22}?($DATE_ALT)" }
  @{ kind='lease_assignment';           rx="(?i)\b(?:General\s+)?Assignment\s+and\s+Assumption(?:\s+(?:of|Agreement))?[^.;]{0,18}?\bdated\b[^.;]{0,22}?($DATE_ALT)" }
  @{ kind='guaranty';                   rx="(?i)\bGuarant(?:y|ee)(?:\s+of\s+Lease)?[^.;]{0,18}?\bdated\b[^.;]{0,22}?($DATE_ALT)" }
  @{ kind='lease_memorandum';           rx="(?i)\bMemorandum\s+of\s+Lease[^.;]{0,18}?\bdated\b[^.;]{0,22}?($DATE_ALT)" }
  @{ kind='lease_original';             rx="(?i)\b(?:Indenture|Agreement)\s+of\s+Lease[^.;]{0,22}?\bdated\b[^.;]{0,22}?($DATE_ALT)" }
)

# attach compiled Regex objects once (see the pre-compiled note above)
foreach ($p in $CITATION_RX) { $p['crx'] = New-Rx $p.rx }
foreach ($p in $UNJUDGED_RX) { $p['crx'] = New-Rx $p.rx }
# --- fetch the lease-family register (doc_subtype already populated) -------
Write-Output "fetching lease-family documents from the register ..."
$all = New-Object System.Collections.Generic.List[object]
$lastId = "00000000-0000-0000-0000-000000000000"
$subFilter = '(' + ((($CITING_SUBTYPES + $TARGET_SUBTYPES) | Sort-Object -Unique) -join ',') + ')'
$propFilter = ''
if ($PropertyId) { $propFilter = "&property_id=eq.$PropertyId" }
while ($true) {
  $url = "$SUPA_URL/rest/v1/documents?select=id,doc_subtype,property_id,file_path&doc_subtype=in.$subFilter&file_path=not.is.null&order=id.asc&id=gt.$lastId$propFilter&limit=1000"
  $page = $null
  for ($try = 1; $try -le 4; $try++) {
    $raw = (& curl.exe -s "$url" -H "apikey: $SUPA_KEY" -H "Authorization: Bearer $SUPA_KEY") -join "`n"
    if ($raw -and -not ($raw -match '"message"\s*:' -and $raw -match '"code"')) {
      try { $page = @((ConvertFrom-Json -InputObject $raw) | ForEach-Object { $_ }); break } catch { $page = $null }
    }
    Start-Sleep -Seconds (3 * $try)
  }
  if ($null -eq $page) { throw "GET documents failed at id=gt.$lastId" }
  if ($page.Count -eq 0) { break }
  foreach ($d in $page) { $all.Add($d); $lastId = $d.id }
}
Write-Output ("lease-family rows = " + $all.Count)

$docs = New-Object System.Collections.Generic.List[object]
foreach ($d in $all) {
  $p = $d.file_path -replace '^file:',''
  $name = $p.Split('\')[-1]
  $sc = Get-TenantScope $d.file_path
  if (-not $sc) { continue }         # need a tenant scope to resolve referents
  $docs.Add([pscustomobject]@{
    id = $d.id; subtype = $d.doc_subtype; property_id = $d.property_id
    name = $name; scope = $sc
    fdate = (Get-FilenameDate $name); ord = (Get-FilenameOrdinal $name)
    is_ocr = ($name -match '(?i)OCR\.pdf$')
  })
}
Write-Output ("under a TENANTS scope = " + $docs.Count)
$byScope = @{}
foreach ($g in ($docs | Group-Object scope)) { $byScope[$g.Name] = @($g.Group) }

$citing = @($docs | Where-Object { $CITING_SUBTYPES -contains $_.subtype })
if ($MaxDocs -gt 0 -and $citing.Count -gt $MaxDocs) { $citing = @($citing[0..($MaxDocs-1)]) }
Write-Output ("citing documents to read = " + $citing.Count)

# --- read each citing document and compare its citations to what we hold ---
$misdated  = New-Object System.Collections.Generic.List[object]
$confirmed = 0; $notHeld = 0; $ambiguous = 0; $noText = 0; $parsedDocs = 0; $citationsSeen = 0; $unjudged = 0
$i = 0
foreach ($c in $citing) {
  $i++
  $url = "$SUPA_URL/rest/v1/document_chunks?select=chunk_index,content&kind=eq.text&document_id=eq.$($c.id)&order=chunk_index.asc&limit=6"
  $rows = $null
  for ($try = 1; $try -le 3; $try++) {
    $raw = (& curl.exe -s "$url" -H "apikey: $SUPA_KEY" -H "Authorization: Bearer $SUPA_KEY") -join "`n"
    if ($raw -and -not ($raw -match '"message"\s*:' -and $raw -match '"code"')) {
      try { $rows = @((ConvertFrom-Json -InputObject $raw) | ForEach-Object { $_ }); break } catch { $rows = $null }
    }
    Start-Sleep -Milliseconds (400 * $try)
  }
  if ($null -eq $rows -or $rows.Count -eq 0) { $noText++; continue }
  # Chunks OVERLAP. Naively joining them repeats text and creates false adjacencies
  # (an ordinal from one copy landing beside a date from another). Skip a chunk
  # whose opening already appears in what we have assembled.
  $textSb = New-Object System.Text.StringBuilder
  foreach ($rw in ($rows | Sort-Object chunk_index)) {
    $piece = [string]$rw.content
    if (-not $piece) { continue }
    $probeLen = [math]::Min(120, $piece.Length)
    $probe = $piece.Substring(0, $probeLen)
    if ($textSb.Length -gt 0 -and $textSb.ToString().Contains($probe)) { continue }
    [void]$textSb.Append(' ').Append($piece)
  }
  $t = $textSb.ToString() -replace '\s+',' '
  # citations live in the recital; the title block describes THIS document
  $wIdx = $t.IndexOf('WHEREAS', [System.StringComparison]::OrdinalIgnoreCase)
  $recital = $t
  if ($wIdx -ge 0) { $recital = $t.Substring($wIdx) }
  $parsedDocs++
  $peers = @($byScope[$c.scope])
  $seenKey = @{}
  # count the citation kinds we deliberately do NOT judge, so coverage is visible
  foreach ($up in $UNJUDGED_RX) {
    foreach ($um in $up.crx.Matches($recital)) {
      if (Get-ProseDate $um.Groups[1].Value) { $unjudged++ }
    }
  }
  foreach ($pat in $CITATION_RX) {
    foreach ($m in $pat.crx.Matches($recital)) {
      $ord = $null; $dgrp = 1
      if ($pat.hasOrd) {
        $ok = $m.Groups[1].Value.ToLower()
        if ($WORD_ORD.ContainsKey($ok)) { $ord = $WORD_ORD[$ok] }
        $dgrp = 2
      }
      $cdate = Get-ProseDate $m.Groups[$dgrp].Value
      if (-not $cdate) { continue }
      $key = $pat.kind + '|' + [string]$ord + '|' + $cdate
      if ($seenKey.ContainsKey($key)) { continue }
      $seenKey[$key] = $true
      $citationsSeen++
      # ---- identify the referent by IDENTITY, never by the cited date ----
      if (-not $ord) { $ambiguous++; continue }   # no ordinal = no identity
      $cands = @($peers | Where-Object { $_.subtype -eq $pat.kind -and $_.id -ne $c.id -and $_.ord -eq $ord })
      # collapse OCR twins of one instrument
      $uniq = New-Object System.Collections.Generic.List[object]
      foreach ($grp in ($cands | Group-Object { [string]$_.fdate + '|' + [string]$_.ord })) {
        $pick = @($grp.Group | Where-Object { -not $_.is_ocr })
        if ($pick.Count -eq 0) { $pick = @($grp.Group) }
        $uniq.Add($pick[0])
      }
      if ($uniq.Count -eq 0) { $notHeld++; continue }
      if ($uniq.Count -gt 1) { $ambiguous++; continue }
      $ref = $uniq[0]
      if (-not $ref.fdate) { $ambiguous++; continue }
      # ---- now, and only now, compare the dates ----
      $same = $false
      if ($cdate -eq $ref.fdate) { $same = $true }
      elseif ($cdate.Substring(8,2) -eq '00' -or $ref.fdate.Substring(8,2) -eq '00') {
        $same = ($cdate.Substring(0,7) -eq $ref.fdate.Substring(0,7))
      }
      $delta = $null
      if (-not $same) {
        try {
          $d1 = [datetime]::ParseExact($cdate, 'yyyy-MM-dd', $null)
          $d2 = [datetime]::ParseExact($ref.fdate, 'yyyy-MM-dd', $null)
          $delta = [int][math]::Abs(($d1 - $d2).TotalDays)
          if ($delta -le 5) { $same = $true }
        } catch { $delta = $null }
      }
      if ($same) { $confirmed++; continue }
      # grade the discrepancy -- same month+day is a year typo, not a date dispute
      $grade = 'substantive discrepancy'
      if ($cdate.Substring(5) -eq $ref.fdate.Substring(5)) {
        $grade = 'YEAR TYPO (same month and day, different year)'
      } elseif ($delta -ne $null -and $delta -le 45) {
        $grade = 'minor (<=45d; likely execution vs effective date)'
      }
      $ordTxt = ''
      if ($ord) { $ordTxt = 'ordinal ' + $ord }
      $misdated.Add([pscustomobject]@{
        grade = $grade; delta_days = $delta; direction = 'undetermined -- read the cited document'
        citing_doc = $c.name; citing_subtype = $c.subtype
        cited_kind = $pat.kind; cited_ordinal = $ordTxt
        cited_date = $cdate; held_document = $ref.name; held_date = $ref.fdate
        scope = $c.scope
      })
    }
  }
  if ($i % 150 -eq 0) { Write-Output ("  ... " + $i + "/" + $citing.Count + " read") }
}

Write-Output ""
Write-Output "=== citation sweep result ==="
Write-Output ("  citing documents read        = " + $parsedDocs + " (no text layer: " + $noText + ")")
Write-Output ("  dated citations parsed       = " + $citationsSeen)
Write-Output ("  citations CONFIRMED correct  = " + $confirmed)
Write-Output ("  referent not held            = " + $notHeld + "  (that is the recited-but-not-found class, reported elsewhere)")
Write-Output ("  referent ambiguous, skipped  = " + $ambiguous + "  (fail-closed: could not say which instrument was meant)")
Write-Output ("  dated citations NOT JUDGED   = " + $unjudged + "  (memorandum/guaranty/assignment/base-lease and unnumbered amendments -- no ordinal means no identity)")
Write-Output ("  *** MISDATED CITATIONS       = " + $misdated.Count + " ***")
if ($misdated.Count -gt 0) {
  Write-Output ""
  Write-Output "  -- by grade --"
  $misdated | Group-Object grade | Sort-Object Count -Descending | ForEach-Object {
    Write-Output ("   {0,4}  {1}" -f $_.Count, $_.Name)
  }
  Write-Output ""
  Write-Output "  -- year typos and substantive discrepancies (the ones that matter) --"
  $misdated | Where-Object { $_.grade -notmatch '^minor' } | Sort-Object grade | Select-Object -First 25 | ForEach-Object {
    Write-Output ("   " + $_.citing_doc)
    Write-Output ("     cites " + $_.cited_kind + " " + $_.cited_ordinal + " as dated " + $_.cited_date +
                  "  but we hold it dated " + $_.held_date + " (" + $_.held_document + ")")
  }
}
$out = "$ReportDir\cre_misdated_citations.csv"
$misdated | Select-Object grade, delta_days, direction, citing_doc, citing_subtype, cited_kind, cited_ordinal, cited_date, held_document, held_date, scope |
  Export-Csv -Path $out -NoTypeInformation -Encoding UTF8
Write-Output ""
Write-Output ("report -> " + $out)
Write-Output "READ-ONLY: nothing was written to the database."
