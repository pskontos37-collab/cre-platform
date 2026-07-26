param(
  [switch]$Apply,
  [switch]$SkipRecitals,
  [string]$PropertyId = '',
  [int]$MaxDocs = 0,
  [string]$ReportDir = ''
)
$ErrorActionPreference = "Stop"
# ---------------------------------------------------------------------------
# Stage A of the agreement-family graph (audit Phase 1 P1c leftover).
# DETERMINISTIC ONLY -- no AI, no model calls, no spend.
#
#   1. doc_subtype for every document, from its FILENAME using the firm's own
#      filing vocabulary (LSE / AMD / ASN / SNDA / EST / GUAR / NTC / LTR),
#      with a coarse FOLDER fallback for the ops/financial bulk;
#   2. proposed 'amends' edges in document_relationships, matched by the PARTY
#      NAME carried in the filename convention (not by folder alone), and
#      sequenced by the filename ordinal, falling back to the filename date;
#   3. a missing-source worklist (content_sha256 null = the file is no longer
#      at documents.file_path), split into actionable classes.
#
# WHY PARTY AND NOT FOLDER: one tenant folder can hold decades of successive
# tenants in the same space. Gateway's "Kohl's Department Store" folder holds
# the 1964 EJ Korvette lease + its four amendments, assignments to Caldor
# (1981, 1990), assignment to Kohl's (1999), a 2006 Kohl's amendment and two
# Mods to that amendment. Folder alone cannot say which lease an amendment
# amends; the party token in the filename can.
#
# WHY FILENAME AND NOT title: documents.title holds an AI-written summary, so a
# summary that merely mentions "lease" would misclassify the document. title is
# consulted only for rows with no file_path at all.
#
# STAGE A2 (default; -SkipRecitals to disable): READ THE DOCUMENTS. Amendment
# recitals enumerate their own chain -- "by Indenture of Lease dated as of
# October 7, 1993, as amended by (i) that certain First Amendment dated March 31,
# 1995, (ii) ... dated September 19, 2003 ..." -- so the base lease date, the
# prior instruments, the document's own ordinal and the predecessor-in-interest
# can all be read from the text layer already in the corpus. Deterministic string
# work, no AI.
#
# WHY THIS EXISTS: filename-only inference produced a FALSE finding. Stage A
# reported "Nine West amendments 2-5 missing" because the filenames showed
# ordinals 1,6,7,8. The Sixth Amendment's own recital shows 2-5 are the Jones
# Retail (2003) and JAG Footwear (2010, 2013) amendments, which were sitting in
# Stage A's own "successor party" reject pile. An ordinal gap is a NUMBERING
# artifact, not a document gap. Never report filename-derived structure as a
# finding without checking the document.
#
# FAIL-CLOSED: an amendment is wired only when exactly ONE same-party original
# exists in scope. Zero or several -> no edge, and the case is reported for a
# human. A wrong edge is worse than a missing one. Where the recital DISAGREES
# with the filename match, nothing is wired and the conflict is reported.
#
# Edges are a PROPOSAL carrying their own derivation in `note`. They are not a
# verification and must not be presented as one.
#
# DRY RUN BY DEFAULT. Nothing is written without -Apply.
#
# Usage:
#   powershell -File classify_doc_families.ps1                  # dry run + reports
#   powershell -File classify_doc_families.ps1 -PropertyId <uuid>
#   powershell -File classify_doc_families.ps1 -Apply           # write subtypes + edges
# ---------------------------------------------------------------------------

$ROOT = "C:\Users\pskontos\Desktop\Software\cre-platform"
$cfg = @{}
foreach ($l in (Get-Content "$ROOT\.env" | Where-Object { $_ -match "=" })) {
  $k,$v = $l -split '=',2; $cfg[$k.Trim()] = $v.Trim()
}
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
if (-not $BASE -or -not $KEY) { throw "missing VITE_SUPABASE_URL / SUPABASE_SECRET_KEY in .env" }
if (-not $ReportDir) { $ReportDir = "$env:LOCALAPPDATA" }
$TMP = "$env:LOCALAPPDATA\cre_classify_post.json"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$ORDINALS = @{
  '1st'=1;'first'=1;'2nd'=2;'second'=2;'3rd'=3;'third'=3;'4th'=4;'fourth'=4;'5th'=5;'fifth'=5
  '6th'=6;'sixth'=6;'7th'=7;'seventh'=7;'8th'=8;'eighth'=8;'9th'=9;'ninth'=9;'10th'=10;'tenth'=10
  '11th'=11;'eleventh'=11;'12th'=12;'twelfth'=12
}
$ORD_RX = '(?i)\b(1st|first|2nd|second|3rd|third|4th|fourth|5th|fifth|6th|sixth|7th|seventh|8th|eighth|9th|ninth|10th|tenth|11th|eleventh|12th|twelfth)\b'

# An "AMD" at the start of a filename is a LEASE amendment unless it targets one
# of these other instruments. Guard list, not a guess: each was observed in the
# corpus (AMD to Articles of Incorporation, AMD to GUAR, AMD to MEM of LSE...).
$NON_LEASE_AMD_TARGET = '(?i)(articles?\s+of\s+incorporation|\bGUAR\b|guarant|\bMEM\b|memorandum|declaration|purchase\s*(and|&)\s*sale|\bCCR\b|\bREA\b|operating\s+agreement|settlement|articles?\s+of\s+organization|\bby-?laws\b|parking)'

# --- 1. filename classification rules (ordered, FIRST MATCH WINS) ----------
$RULES = @(
  # the firm's convention: AMD[-<ordinal>]-<PARTY>, plus prose forms
  @{ subtype='lease_amendment';        family='lease'; rx='(?i)(^\s*(\d+[\s\.\-]+)*AMD\b|\bAMD\b.{0,18}\bLSE\b|\bAMD\b.{0,8}(to|of)\b.{0,18}lease|amendment\s+(no\.?\s*\d+\s+)?to\s+(the\s+)?(retail\s+|ground\s+|shopping\s+center\s+)?lease|lease\s+amendment|\bLSE\s+Modification|lease\s+modification|\bMod\s+to\b.{0,20}\bAMD\b)' }
  @{ subtype='lease_assignment';       family='lease'; rx='(?i)(\bASN\b.{0,26}\bLSE\b|assignment\s+(and|&)\s+assumption|\bASN\b\s*(and|&)\s*assumption|assignment\s+of\s+(the\s+)?lease|\bASN\b\s+of\s+leasehold)' }
  @{ subtype='lease_assumption';       family='lease'; rx='(?i)(assumption\s+of\s+(the\s+)?(ground\s+)?lease|assumption\s+AGR)' }
  @{ subtype='commencement_agreement'; family='lease'; rx='(?i)(conf(irmation|\.)?\s+of\s+(LSE|lease)\s+term|commencement\s+(date\s+)?(agreement|certificate|letter)|rent\s+commencement)' }
  @{ subtype='lease_termination';      family='lease'; rx='(?i)(termination\s+of\s+(the\s+)?(LSE|lease)|\bLSE\b\s+termination|lease\s+termination|surrender\s+(and\s+release\s+)?(agreement|AGR)|lease\s+surrender)' }
  @{ subtype='snda';                   family='lease'; rx='(?i)(\bSNDA\b|subordination.{0,40}attornment|non-?disturbance)' }
  @{ subtype='estoppel';               family='lease'; rx='(?i)(^\s*(\d+[\s\.\-]+)*EST\b|\bEST\s*-|estoppel)' }
  @{ subtype='guaranty';               family='lease'; rx='(?i)(\bGUAR\b|guarant(y|ies|ee|or))' }
  @{ subtype='sublease';               family='lease'; rx='(?i)(\bSUB\s*-?LSE\b|sub-?lease)' }
  @{ subtype='license_agreement';      family='lease'; rx='(?i)(\bLIC\s+AGR\b|license\s+agreement)' }
  @{ subtype='settlement_release';     family='lease'; rx='(?i)(settlement\s*(and|&)\s*(mutual\s+)?release|mutual\s+release|confidential\s+settlement)' }
  @{ subtype='lease_memorandum';       family='lease'; rx='(?i)(\bMEM\b\s*(of|to)?\s*\bLSE\b|memorandum\s+of\s+lease)' }
  @{ subtype='lease_exhibit';          family='lease'; rx='(?i)(lease\s+exhibits?|exhibits?\s+to\s+lease)' }
  # the ONLY edge-eligible original: LSE token at the start (optionally behind a
  # numeric index prefix), or prose "<x> Lease Agreement" / "Retail|Ground Lease"
  @{ subtype='lease_original';         family='lease'; rx='(?i)(^\s*(\d+[\s\.\-]+)*LSE\b|lease\s+agreement|^\s*(\d+[\s\.\-]+)*(retail|ground)\s+lease\b)' }
  # --- non-lease families: coarse only, never edged in Stage A ---
  @{ subtype='ccr_declaration';        family='ccr';    rx='(?i)(\bCCR\b|declaration\s+of\s+(covenants|restrictions)|\bREA\b|reciprocal\s+easement|declaration\s+AMD)' }
  @{ subtype='purchase_sale';          family='deal';   rx='(?i)(purchase\s*(and|&)\s*sale|\bPSA\b|real\s+estate\s+sale\s+AGR)' }
  @{ subtype='entity_document';        family='entity'; rx='(?i)(operating\s+agreement|cert(\.|ificate)?\s+of\s+(formation|good\s+standing|GS)|articles?\s+of\s+(organization|incorporation)|\bby-?laws\b)' }
  @{ subtype='loan_document';          family='debt';   rx='(?i)(promissory\s+note|loan\s+(agreement|modification)|\bmortgage\b|deed\s+of\s+trust)' }
  @{ subtype='insurance_certificate';  family='ops';    rx='(?i)(\bCOI\b|certificate\s+of\s+insurance|\bACORD\b)' }
  @{ subtype='plans_drawings';         family='ops';    rx='(?i)(^\s*(\d+[\s\.\-]+)*PLAN\b|drawings|site\s+plan|\bsurvey\b)' }
  @{ subtype='tax_bill';               family='ops';    rx='(?i)(tax\s+bill|lump\s+sum\s+tax|\bRET\b\s+lump)' }
  @{ subtype='notice';                 family='ops';    rx='(?i)(\bNTC\b|\bnotice\b)' }
  @{ subtype='correspondence';         family='ops';    rx='(?i)(\bLTR\b|\bletter\b|^\s*EM\s*-|\bemail\b)' }
  @{ subtype='certificate';            family='ops';    rx='(?i)(\bCERT\b|certificate)' }
  @{ subtype='billing_adjustment';     family='ops';    rx='(?i)(billing\s+adj)' }
  # anything that mentions a lease but is NOT an instrument (approvals, consents,
  # MRI notes). Keeps them OUT of the edge-eligible originals pool.
  @{ subtype='other_lease_related';    family='ops';    rx='(?i)(\bLSE\b|\blease\b)' }
)

# --- folder fallback: coarse but true, for files whose NAME says nothing ----
$FOLDER_RULES = @(
  @{ subtype='monthly_report';       rx='(?i)\\Monthly\s+Report' }
  @{ subtype='lender_report';        rx='(?i)\\Lender\s+Reporting' }
  @{ subtype='cam_reconciliation';   rx='(?i)\\Reconciliation' }
  @{ subtype='acquisition_finance';  rx='(?i)\\ACQ-REFI-DISP' }
  @{ subtype='deal_document';        rx='(?i)\\ASSTMGMT\\ACQUISITIONS\\' }
  @{ subtype='management_agreement'; rx='(?i)\\Management\s+Agreements' }
  @{ subtype='operations_document';  rx='(?i)\\OPERATIONS\\' }
  @{ subtype='property_information'; rx='(?i)\\PROPERTY\s+INFORMATION\\' }
  @{ subtype='working_file';         rx='(?i)\\Working\s+Files' }
)

$ORIGINAL_SUBTYPE  = 'lease_original'
$AMENDMENT_SUBTYPE = 'lease_amendment'
# folders that CONTAIN tenant folders rather than being one
$CONTAINER_RX = '(?i)^(_?TERMINATED\s+TENANTS|.*FORMER\s+TENANTS|_?INACTIVE.*|_?OLD\s+TENANTS)$'
# date in the filing convention: "(6-4-20)", "(06-2001)", "(1997)"
$DATE_RX = '\((\d{1,2})[-\.](\d{1,2})[-\.](\d{2,4})\)|\((\d{1,2})[-\.](\d{4})\)|\((\d{4})\)'

function Get-Rule([string]$probe) {
  foreach ($r in $RULES) {
    if ($probe -match $r.rx) {
      # an AMD aimed at a non-lease instrument is not a lease amendment
      if ($r.subtype -eq $AMENDMENT_SUBTYPE -and $probe -match $NON_LEASE_AMD_TARGET) { continue }
      return $r
    }
  }
  return $null
}

function Get-FolderSubtype([string]$path) {
  foreach ($r in $FOLDER_RULES) { if ($path -match $r.rx) { return $r.subtype } }
  return $null
}

function Get-FilenameDate([string]$name) {
  # sortable yyyy-MM-dd, or $null. Two-digit years: >=40 -> 19xx (the corpus
  # reaches back to a 1964 EJ Korvette lease), else 20xx.
  $m = [regex]::Match($name, $DATE_RX)
  if (-not $m.Success) { return $null }
  if ($m.Groups[1].Success) {
    $mo = [int]$m.Groups[1].Value; $dy = [int]$m.Groups[2].Value; $yr = [int]$m.Groups[3].Value
  } elseif ($m.Groups[4].Success) {
    $mo = [int]$m.Groups[4].Value; $dy = 1; $yr = [int]$m.Groups[5].Value
  } else {
    $mo = 1; $dy = 1; $yr = [int]$m.Groups[6].Value
  }
  if ($yr -lt 100) {
    if ($yr -ge 40) { $yr = 1900 + $yr } else { $yr = 2000 + $yr }
  }
  if ($mo -lt 1 -or $mo -gt 12 -or $dy -lt 1 -or $dy -gt 31 -or $yr -lt 1900 -or $yr -gt 2100) { return $null }
  return ("{0:0000}-{1:00}-{2:00}" -f $yr, $mo, $dy)
}

function Get-Ordinal([string]$name) {
  # explicit ordinal in the filename ("AMD-2nd-EJKorvette", "Third Amendment")
  $m = [regex]::Match($name, $ORD_RX)
  if (-not $m.Success) { return $null }
  $k = $m.Groups[1].Value.ToLower()
  if ($ORDINALS.ContainsKey($k)) { return $ORDINALS[$k] }
  return $null
}

function Get-Party([string]$name) {
  # party token from "<TYPE>[-<ordinal>]-<PARTY> (<date>).pdf"
  $s = $name -replace '(?i)\.pdf$',''
  $s = $s -replace '(?i)OCR$',''            # OCR rescan variants are the same instrument
  $s = $s -replace '\s*\(.*$',''            # drop (date) and trailing notes
  $s = $s -replace '(?i)\s*w\s+NTC.*$',''
  $s = $s -replace '(?i)^\s*(\d+[\s\.\-]+)*',''            # leading numeric index prefix
  $s = $s -replace '(?i)^(LSE|AMD|ASN|EST|GUAR|NTC|LTR|AGR|CERT|MEM|EM|SNDA|LIC)\b[\s\-]*',''
  $s = $s -replace '(?i)^(of|to|and|&|the)\b[\s\-]*',''     # connectors
  $s = $s -replace '(?i)^(LSE|lease)\b[\s\-]*',''           # "AMD of LSE-<party>"
  $s = $s -replace '(?i)^(of|to|and|&|the)\b[\s\-]*',''
  $s = $s -replace $ORD_RX,''                               # ordinal is not the party
  $s = $s -replace '(?i)\bMod\b|\bModification\b',''
  $s = $s -replace '(?i)\b(LLC|L\.L\.C|Inc|Corp|Corporation|Co|Company|LP|LTD|LLP)\b\.?',''
  $s = $s -replace '[^A-Za-z0-9]',''
  return $s.ToLower()
}

function Get-EditDistance([string]$a, [string]$b) {
  # Levenshtein, for filing typos like "Jewelery" vs "Jewelry"
  $la = $a.Length; $lb = $b.Length
  if ($la -eq 0) { return $lb }
  if ($lb -eq 0) { return $la }
  $prev = New-Object 'int[]' ($lb + 1)
  $cur  = New-Object 'int[]' ($lb + 1)
  for ($j = 0; $j -le $lb; $j++) { $prev[$j] = $j }
  for ($i = 1; $i -le $la; $i++) {
    $cur[0] = $i
    for ($j = 1; $j -le $lb; $j++) {
      $cost = 1
      if ($a[$i-1] -eq $b[$j-1]) { $cost = 0 }
      $d1 = $prev[$j] + 1; $d2 = $cur[$j-1] + 1; $d3 = $prev[$j-1] + $cost
      $m = $d1
      if ($d2 -lt $m) { $m = $d2 }
      if ($d3 -lt $m) { $m = $d3 }
      $cur[$j] = $m
    }
    for ($j = 0; $j -le $lb; $j++) { $prev[$j] = $cur[$j] }
  }
  return $prev[$lb]
}

function Find-PartyMatch($party, $origs) {
  # Tiered, conservative. Each tier must yield EXACTLY ONE candidate or we fall
  # through; if no tier resolves to one, the caller fails closed. The tier used
  # is recorded on the edge so a reviewer can weigh it.
  $exact = @($origs | Where-Object { $_.party -eq $party })
  if ($exact.Count -eq 1) { return @{ doc = $exact[0]; basis = 'exact party match'; count = 1 } }
  if ($exact.Count -gt 1) { return @{ doc = $null; basis = 'several exact same-party originals'; count = $exact.Count } }
  # prefix/containment: "vidadulce" vs "vidadulceofknightdale",
  # "ejkorvette" vs "ejkorvettecaldor" (assignment carried into the filename)
  if ($party.Length -ge 6) {
    $pre = @($origs | Where-Object {
      $_.party.Length -ge 6 -and ($_.party.StartsWith($party) -or $party.StartsWith($_.party))
    })
    if ($pre.Count -eq 1) { return @{ doc = $pre[0]; basis = 'party prefix match'; count = 1 } }
    if ($pre.Count -gt 1) { return @{ doc = $null; basis = 'several prefix-matching originals'; count = $pre.Count } }
  }
  # filing typo: edit distance 1-2 on a reasonably long token
  if ($party.Length -ge 8) {
    $near = @($origs | Where-Object {
      $_.party.Length -ge 8 -and (Get-EditDistance $party $_.party) -le 2
    })
    if ($near.Count -eq 1) {
      return @{ doc = $near[0]; basis = ('party near-match, edit distance ' + (Get-EditDistance $party $near[0].party) + ' -- likely a filing typo'); count = 1 }
    }
    if ($near.Count -gt 1) { return @{ doc = $null; basis = 'several near-matching originals'; count = $near.Count } }
  }
  return @{ doc = $null; basis = 'no same-party original'; count = 0 }
}

# --- Stage A2: recital parsing ---------------------------------------------
$MONTHS = @{
  'january'=1;'jan'=1;'february'=2;'feb'=2;'march'=3;'mar'=3;'april'=4;'apr'=4;'may'=5
  'june'=6;'jun'=6;'july'=7;'jul'=7;'august'=8;'aug'=8;'september'=9;'sept'=9;'sep'=9
  'october'=10;'oct'=10;'november'=11;'nov'=11;'december'=12;'dec'=12
}
$MONTH_RX = '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)'
$SELF_ORD_RX = '(?i)\b(FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH|ELEVENTH|TWELFTH)\s+AMENDMENT\b'
$WORD_ORD = @{
  'first'=1;'second'=2;'third'=3;'fourth'=4;'fifth'=5;'sixth'=6
  'seventh'=7;'eighth'=8;'ninth'=9;'tenth'=10;'eleventh'=11;'twelfth'=12
}

function ConvertTo-IsoDate($monthToken, $dayToken, $yearToken) {
  if (-not $monthToken) { return $null }
  $mk = ([string]$monthToken).ToLower().Trim('.',' ')
  if (-not $MONTHS.ContainsKey($mk)) { return $null }
  $mo = $MONTHS[$mk]
  $yr = 0
  if (-not [int]::TryParse([string]$yearToken, [ref]$yr)) { return $null }
  if ($yr -lt 1900 -or $yr -gt 2100) { return $null }
  $dy = 0
  if (-not [int]::TryParse([string]$dayToken, [ref]$dy)) { $dy = 0 }
  if ($dy -lt 1 -or $dy -gt 31) { $dy = 0 }   # 0 = month precision only
  return ("{0:0000}-{1:00}-{2:00}" -f $yr, $mo, $dy)
}

function Get-ProseDates([string]$span) {
  # every date in a stretch of recital prose, in order of appearance.
  # Tolerant of OCR noise: "as cf the 11. !.... day cf March, 1995".
  $out = New-Object System.Collections.Generic.List[string]
  # "<Month> <d>, <yyyy>"
  foreach ($m in [regex]::Matches($span, "($MONTH_RX)\s*\.?\s*(\d{1,2})\s*(?:st|nd|rd|th)?\s*,?\s*(\d{4})")) {
    $d = ConvertTo-IsoDate $m.Groups[1].Value $m.Groups[2].Value $m.Groups[3].Value
    if ($d) { $out.Add($d) }
  }
  # "<d>th day of <Month>, <yyyy>"  (day may be OCR-mangled -> month precision)
  foreach ($m in [regex]::Matches($span, "(\d{1,2})?\s*(?:st|nd|rd|th)?[^A-Za-z0-9]{0,12}day\s*[co]f\s*($MONTH_RX)\s*,?\s*(\d{4})")) {
    $d = ConvertTo-IsoDate $m.Groups[2].Value $m.Groups[1].Value $m.Groups[3].Value
    if ($d) { $out.Add($d) }
  }
  # "<Month> <yyyy>" with no day at all
  foreach ($m in [regex]::Matches($span, "($MONTH_RX)\s*,?\s*(\d{4})")) {
    $d = ConvertTo-IsoDate $m.Groups[1].Value '' $m.Groups[2].Value
    if ($d -and -not ($out | Where-Object { $_.Substring(0,7) -eq $d.Substring(0,7) })) { $out.Add($d) }
  }
  return @($out)
}

function Parse-Recital([string]$text) {
  # returns what the DOCUMENT says about itself and its chain
  $res = @{ self_ordinal = $null; base_date = $null; recited = @(); successor_to = $null; had_recital = $false }
  if (-not $text) { return $res }
  $t = $text -replace '\s+',' '
  # The document's own ordinal comes from its TITLE BLOCK only -- everything before
  # the first WHEREAS. Scanning the whole text reads the recital's references to
  # OTHER instruments ("by First Amendment of Lease dated March 31, 1995") and
  # mislabels an unnumbered "AMENDMENT OF LEASE" as the first amendment.
  $titleBlock = $t
  $wFirst = $t.IndexOf('WHEREAS', [System.StringComparison]::OrdinalIgnoreCase)
  if ($wFirst -gt 0) { $titleBlock = $t.Substring(0, $wFirst) }
  $m = [regex]::Match($titleBlock, $SELF_ORD_RX)
  if ($m.Success) {
    $k = $m.Groups[1].Value.ToLower()
    if ($WORD_ORD.ContainsKey($k)) { $res.self_ordinal = $WORD_ORD[$k] }
  }
  # Work only inside the RECITAL, never the title block. An amendment's title is
  # "THIRD AMENDMENT TO LEASE ... dated as of March 12, 2018", and a regex allowed
  # to see it captures the AMENDMENT's own date as the lease date -- which is what
  # produced 32 bogus "conflicts" on the first run.
  $recital = $t
  $wIdx = $t.IndexOf('WHEREAS', [System.StringComparison]::OrdinalIgnoreCase)
  if ($wIdx -ge 0) { $recital = $t.Substring($wIdx) }
  $DATE_ALT = "$MONTH_RX\s*\.?\s*\d{1,2}\s*(?:st|nd|rd|th)?\s*,?\s*\d{4}|\d{1,2}\s*(?:st|nd|rd|th)?[^A-Za-z0-9]{0,12}day\s*[co]f\s*$MONTH_RX\s*,?\s*\d{4}|$MONTH_RX\s*,?\s*\d{4}"
  # highest precision first: an explicitly-named lease instrument
  $baseM = [regex]::Match($recital, "(?i)(?:Indenture|Agreement|Instrument)\s+of\s+Lease[^.;]{0,70}?\bdated\b[^.;]{0,40}?($DATE_ALT)")
  if (-not $baseM.Success) {
    # fall back to a bare "Lease ... dated", but never one that is part of an
    # amendment's own self-description
    $baseM = [regex]::Match($recital, "(?i)(?<!amendment\s+to\s+)(?<!amendment\s+of\s+)\bLease\b(?![^.;]{0,24}amendment)[^.;]{0,70}?\bdated\b[^.;]{0,40}?($DATE_ALT)")
  }
  if ($baseM.Success) {
    $res.had_recital = $true
    $d = @(Get-ProseDates $baseM.Groups[1].Value)
    if ($d.Count -gt 0) { $res.base_date = $d[0] }
  }
  # prior instruments: the "as amended by" list ONLY, tightly bounded. A loose
  # window runs past the recital into rent tables and harvests period boundaries
  # (2026-12-01, 2027-11-30, ...) as if they were instrument dates.
  $amM = [regex]::Match($recital, '(?is)as\s+amended\s+by(.{0,1500}?)(?:\(collectively|\(the\s+"Lease"|WITNESSETH|NOW\s+THEREFORE|predecessor-in-interest|;\s*and\s+WHEREAS)')
  if ($amM.Success) {
    $res.had_recital = $true
    # keep only dates attached to an instrument word -- an amending instrument is
    # named, not just dated
    $span = $amM.Groups[1].Value
    $kept = New-Object System.Collections.Generic.List[string]
    foreach ($im in [regex]::Matches($span, "(?i)(amendment|assignment|assumption|agreement|letter\s+agreement|modification|side\s+letter)[^.;]{0,60}?\bdated\b[^.;]{0,40}?($DATE_ALT)")) {
      foreach ($dd in @(Get-ProseDates $im.Groups[2].Value)) { $kept.Add($dd) }
    }
    $res.recited = @($kept)
  }
  # predecessor-in-interest names the party the filename may be filed under
  $sm = [regex]::Match($t, '(?i)successor[- ]in[- ]interest\s+to\s+([A-Z][A-Za-z0-9&.,\'' -]{3,60}?)(?:,\s+(?:with|having)|\s+\(|\.)')
  if ($sm.Success) { $res.successor_to = $sm.Groups[1].Value.Trim() }
  return $res
}

function Test-DateNear($a, $b, [int]$tolDays) {
  # compares two iso strings; day 00 means month precision on that side
  if (-not $a -or -not $b) { return $false }
  if ($a -eq $b) { return $true }
  if ($a.Substring(8,2) -eq '00' -or $b.Substring(8,2) -eq '00') {
    return ($a.Substring(0,7) -eq $b.Substring(0,7))
  }
  try {
    $da = [datetime]::ParseExact($a, 'yyyy-MM-dd', $null)
    $db = [datetime]::ParseExact($b, 'yyyy-MM-dd', $null)
    return ([math]::Abs(($da - $db).TotalDays) -le $tolDays)
  } catch { return $false }
}

function Get-DedupedOriginals($groupRows) {
  # One instrument can sit in the register twice -- a native PDF and an "...OCR.pdf"
  # rescan (Nine West's 1993 lease has both). Collapse them by party+date, keeping
  # the non-OCR copy when there is one. MUST be used everywhere originals are
  # counted: an un-deduped list makes two copies of one lease look like two
  # candidate leases and silently fails closed.
  $out = New-Object System.Collections.Generic.List[object]
  foreach ($grp in ($groupRows | Group-Object { $_.party + '|' + [string]$_.fdate })) {
    $pick = @($grp.Group | Where-Object { -not $_.is_ocr })
    if ($pick.Count -eq 0) { $pick = @($grp.Group) }
    $out.Add($pick[0])
  }
  return $out
}

function Get-TenantScope([string]$path) {
  # ...\TENANTS\<tenant folder>\...  -- descend one more level through folders
  # that merely CONTAIN tenant folders (_TERMINATED TENANTS, Former Tenants).
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

# --- 2. fetch the register -------------------------------------------------
Write-Output "fetching document register ..."
$docs = New-Object System.Collections.Generic.List[object]
$lastId = "00000000-0000-0000-0000-000000000000"
$propFilter = ''
if ($PropertyId) { $propFilter = "&property_id=eq.$PropertyId" }
while ($true) {
  $url = "$BASE/rest/v1/documents?select=id,doc_type,doc_subtype,property_id,title,file_path,content_sha256,is_indexed&order=id.asc&id=gt.$lastId$propFilter&limit=1000"
  $page = $null
  for ($try = 1; $try -le 4; $try++) {
    $raw = (& curl.exe -s "$url" -H "apikey: $KEY" -H "Authorization: Bearer $KEY") -join "`n"
    if ($raw -and -not ($raw -match '"message"\s*:' -and $raw -match '"code"')) {
      try { $page = @((ConvertFrom-Json -InputObject $raw) | ForEach-Object { $_ }); break } catch { $page = $null }
    }
    Write-Output "  GET retry $try"; Start-Sleep -Seconds (5 * $try)
  }
  if ($null -eq $page) { throw "GET documents failed after retries at id=gt.$lastId" }
  if ($page.Count -eq 0) { break }
  foreach ($d in $page) { $docs.Add($d); $lastId = $d.id }
  if ($MaxDocs -gt 0 -and $docs.Count -ge $MaxDocs) { break }
}
Write-Output ("register rows = " + $docs.Count)

# --- 3. classify ----------------------------------------------------------
$classified = New-Object System.Collections.Generic.List[object]
$subtypeHist = @{}; $unclassified = 0; $titleFallback = 0; $folderFallback = 0
foreach ($d in $docs) {
  $name = ''; $fullPath = ''
  if ($d.file_path) {
    $fullPath = $d.file_path -replace '^file:',''
    $name = $fullPath.Split('\')[-1]
  }
  $probe = $name
  if (-not $probe) { $probe = [string]$d.title; if ($probe) { $titleFallback++ } }
  $rule = $null
  if ($probe) { $rule = Get-Rule $probe }
  $st = $null; $fam = $null; $viaFolder = $false
  if ($rule) {
    $st = $rule.subtype; $fam = $rule.family
  } elseif ($fullPath) {
    $st = Get-FolderSubtype $fullPath
    if ($st) { $fam = 'ops'; $viaFolder = $true; $folderFallback++ }
  }
  $fdate = $null; $ord = $null
  if ($name) { $fdate = Get-FilenameDate $name; $ord = Get-Ordinal $name }
  $party = ''
  if ($name -and $fam -eq 'lease') { $party = Get-Party $name }
  $scope = $null
  if ($d.file_path) { $scope = Get-TenantScope $d.file_path }
  if ($st) {
    if (-not $subtypeHist.ContainsKey($st)) { $subtypeHist[$st] = 0 }
    $subtypeHist[$st]++
  } else { $unclassified++ }
  $classified.Add([pscustomobject]@{
    id = $d.id; doc_type = $d.doc_type; title = $d.title; name = $name; path = $fullPath
    property_id = $d.property_id; subtype = $st; family = $fam; via_folder = $viaFolder
    fdate = $fdate; ord = $ord; party = $party; scope = $scope
    is_ocr = ($name -match '(?i)OCR\.pdf$')
    sha = $d.content_sha256; indexed = $d.is_indexed; prior_subtype = $d.doc_subtype
  })
}

Write-Output ""
Write-Output "=== doc_subtype classification (deterministic) ==="
$subtypeHist.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
  Write-Output ("  {0,-24} {1,6}" -f $_.Key, $_.Value)
}
Write-Output ("  {0,-24} {1,6}" -f '<unclassified>', $unclassified)
$cov = 100.0 * ($classified.Count - $unclassified) / [math]::Max(1, $classified.Count)
Write-Output ("  corpus coverage = " + [math]::Round($cov,1) + "% of " + $classified.Count +
              "  (by filename: " + ($classified.Count - $unclassified - $folderFallback) +
              ", by folder: " + $folderFallback + ", title-fallback rows: " + $titleFallback + ")")
$leaseFam = @($classified | Where-Object { $_.family -eq 'lease' })
$tenantDocs = @($classified | Where-Object { $_.scope })
$tenantClassified = @($tenantDocs | Where-Object { $_.subtype })
Write-Output ("  lease-instrument docs = " + $leaseFam.Count)
Write-Output ("  docs under a TENANTS scope = " + $tenantDocs.Count +
              ", classified = " + $tenantClassified.Count +
              " (" + [math]::Round(100.0 * $tenantClassified.Count / [math]::Max(1,$tenantDocs.Count),1) + "%)")

# --- 4. propose amends edges ----------------------------------------------
# A family is defined by its BASE LEASE, not by the amendment's own party token.
# Resolving the base FIRST and grouping on it keeps a family together when the
# filenames disagree about the party ("Kriklands"/"Kirklands",
# "EJKorvette"/"EJKorvette-Caldor") -- grouping by party first would split those
# into separate chains and number each one from 1.
$edges = New-Object System.Collections.Generic.List[object]
$unmatched = New-Object System.Collections.Generic.List[object]
$ordConflicts = New-Object System.Collections.Generic.List[object]
$ordGaps = New-Object System.Collections.Generic.List[object]
$scopes = @($classified | Where-Object { $_.scope -and $_.family -eq 'lease' } | Group-Object scope)
foreach ($g in $scopes) {
  $amendments = @($g.Group | Where-Object { $_.subtype -eq $AMENDMENT_SUBTYPE })
  if ($amendments.Count -eq 0) { continue }
  # originals pool: prefer a non-OCR copy when both exist for the same party+date
  $origs = Get-DedupedOriginals @($g.Group | Where-Object { $_.subtype -eq $ORIGINAL_SUBTYPE })
  # resolve each amendment's base first
  $resolved = New-Object System.Collections.Generic.List[object]
  foreach ($a in $amendments) {
    $match = Find-PartyMatch $a.party $origs
    if (-not $match.doc) {
      $why = $match.basis
      if ($origs.Count -eq 0) {
        $why = 'ORIGINAL LEASE ABSENT from scope (document gap)'
      } elseif ($match.count -eq 0) {
        $why = 'no matching original -- likely successor/assignee party (needs a human)'
      }
      $unmatched.Add([pscustomobject]@{
        reason = $why; party = $a.party; amendment = $a.name; scope = $g.Name
        originals_in_scope = (($origs | ForEach-Object { $_.party }) -join ' ')
      })
      continue
    }
    $resolved.Add([pscustomobject]@{ amd = $a; base = $match.doc; basis = $match.basis })
  }
  # now group by the resolved base -- that is the family
  foreach ($fam in ($resolved | Group-Object { $_.base.id })) {
    $baseLease = $fam.Group[0].base
    $members = @($fam.Group)
    $withOrd = @($members | Where-Object { $_.amd.ord })
    $allOrd = ($withOrd.Count -eq $members.Count -and $members.Count -gt 0)
    $sorted = @($members | Sort-Object @{Expression={
      if ($allOrd) { $_.amd.ord } elseif ($_.amd.fdate) { $_.amd.fdate } else { '9999-99-99' }
    }}, @{Expression={ $_.amd.name }})
    # ordinal order vs date order: report the disagreement, never resolve it silently
    if ($withOrd.Count -gt 1) {
      $byOrd  = @($withOrd | Sort-Object @{Expression={ $_.amd.ord }} | ForEach-Object { $_.amd.name })
      $byDate = @($withOrd | Sort-Object @{Expression={ if ($_.amd.fdate) { $_.amd.fdate } else { '9999-99-99' } }} | ForEach-Object { $_.amd.name })
      if (($byOrd -join '|') -ne ($byDate -join '|')) {
        $ordConflicts.Add([pscustomobject]@{
          base = $baseLease.name; scope = $g.Name
          by_ordinal = ($byOrd -join ' > '); by_date = ($byDate -join ' > ')
        })
      }
    }
    # stated ordinals present but not contiguous from 1 => intermediate
    # amendments are MISSING from the register. That is a document gap, and it is
    # the reason a positional "n of N" would have been a lie.
    $missingOrds = @()
    if ($withOrd.Count -gt 0) {
      $have = @($withOrd | ForEach-Object { [int]$_.amd.ord } | Sort-Object -Unique)
      $top = $have[$have.Count - 1]
      for ($k = 1; $k -le $top; $k++) { if ($have -notcontains $k) { $missingOrds += $k } }
      # amendments in this family that state NO ordinal could themselves BE the
      # apparently-missing ones (EJ Korvette's "AMD of LSE-EJKorvette (7-14-64)"
      # is almost certainly its 1st). Qualify the gap instead of overstating it.
      $noOrdCount = $members.Count - $withOrd.Count
      if ($missingOrds.Count -gt 0) {
        $ordGaps.Add([pscustomobject]@{
          base = $baseLease.name; scope = $g.Name
          present = ($have -join ',') ; missing = ($missingOrds -join ',')
          unordinaled_in_chain = $noOrdCount
        })
      }
    }
    $gapNote = ''
    if ($missingOrds.Count -gt 0) {
      $gapNote = " NOT IN REGISTER: amendment ordinal(s) " + ($missingOrds -join ',') +
                 " absent between 1 and " + $have[$have.Count - 1] + " -- chain may be incomplete."
      if ($noOrdCount -gt 0) {
        $gapNote = $gapNote + " (" + $noOrdCount + " amendment(s) here state no ordinal and could be among them.)"
      }
    }
    $n = 0
    foreach ($r in $sorted) {
      $n++
      $a = $r.amd
      # report the STATED ordinal when the filename gives one; a positional index
      # would misdescribe e.g. the 6th amendment as "amendment 1 of 3"
      $posText = "position " + $n + " of " + $sorted.Count + " present (by filename date; no ordinal stated)"
      $seqVal = $n
      if ($a.ord) {
        $posText = "stated as amendment " + $a.ord + " in the filename; " + $sorted.Count + " of this chain present in the register"
        $seqVal = $a.ord
      }
      $dpart = 'no filename date'
      if ($a.fdate) { $dpart = $a.fdate }
      $edges.Add([pscustomobject]@{
        from_document_id = $a.id
        to_document_id   = $baseLease.id
        relationship     = 'amends'
        seq              = $seqVal
        stated_ordinal   = $a.ord
        party            = $a.party
        scope            = $g.Name
        from_name        = $a.name
        to_name          = $baseLease.name
        from_date        = $a.fdate
        match_basis      = $r.basis
        note             = "[Stage A deterministic] " + $posText + "; document date " + $dpart +
                           "; base lease resolved by " + $r.basis + "." + $gapNote +
                           " Filename-derived, NOT document-verified -- confirm before relying."
      })
    }
  }
}

Write-Output ""
Write-Output "=== proposed 'amends' edges ==="
Write-Output ("  tenant scopes with lease-family docs = " + $scopes.Count)
Write-Output ("  edges proposed                       = " + $edges.Count)
if ($edges.Count -gt 0) {
  Write-Output "  -- how each base lease was resolved --"
  $edges | Group-Object match_basis | Sort-Object Count -Descending | ForEach-Object {
    Write-Output ("   {0,4}  {1}" -f $_.Count, $_.Name)
  }
}
Write-Output ("  amendments left UNWIRED (fail-closed)= " + $unmatched.Count)
if ($unmatched.Count -gt 0) {
  Write-Output "  -- reasons --"
  $unmatched | Group-Object reason | Sort-Object Count -Descending | ForEach-Object {
    Write-Output ("   {0,4}  {1}" -f $_.Count, $_.Name)
  }
}
if ($ordConflicts.Count -gt 0) {
  Write-Output ""
  Write-Output ("  !! " + $ordConflicts.Count + " chain(s) where the filename ORDINAL order disagrees with the DATE order")
  Write-Output "     (a filing inconsistency worth a human look, not a script bug):"
  $ordConflicts | Select-Object -First 6 | ForEach-Object {
    Write-Output ("     base " + $_.base)
    Write-Output ("       by ordinal: " + $_.by_ordinal)
    Write-Output ("       by date   : " + $_.by_date)
  }
}
if ($ordGaps.Count -gt 0) {
  Write-Output ""
  Write-Output ("  (FYI, NOT a finding) " + $ordGaps.Count + " chain(s) whose filename ordinals are non-contiguous.")
  Write-Output "     This is USUALLY A NUMBERING ARTIFACT, not a document gap: parties leave middle"
  Write-Output "     amendments untitled ('Amendment of Lease') and then jump to a numbered one."
  Write-Output "     Nine West's 1,6,7,8 looked like a gap and was not. Use the EVIDENCE-BASED gap"
  Write-Output "     list from the recital pass below instead."
  $ordGaps | Sort-Object { ($_.missing -split ',').Count } -Descending | Select-Object -First 10 | ForEach-Object {
    $q = ''
    if ([int]$_.unordinaled_in_chain -gt 0) { $q = "  (" + $_.unordinaled_in_chain + " unordinaled amendment(s) here may be among them)" }
    Write-Output ("     " + $_.base)
    Write-Output ("       present ordinals: " + $_.present + "   MISSING: " + $_.missing + $q)
  }
}

# --- 4b. STAGE A2: corroborate against the DOCUMENTS themselves -----------
$recitalStats = @{
  fetched = 0; parsed = 0; confirmed = 0; conflict = 0; filename_only = 0
  resolved_successor = 0; ordinal_confirmed = 0; ordinal_disagreed = 0
}
$conflicts = New-Object System.Collections.Generic.List[object]
$realGaps = New-Object System.Collections.Generic.List[object]
$recitalCache = @{}

if (-not $SkipRecitals) {
  Write-Output ""
  Write-Output "=== Stage A2: reading the documents (recital parse, deterministic, no AI) ==="
  # only the lease instruments in scopes that actually have amendments
  $scopesWithAmd = @{}
  foreach ($g in $scopes) {
    if (@($g.Group | Where-Object { $_.subtype -eq $AMENDMENT_SUBTYPE }).Count -gt 0) { $scopesWithAmd[$g.Name] = $true }
  }
  $needIds = New-Object System.Collections.Generic.List[string]
  foreach ($c in $classified) {
    if ($c.scope -and $scopesWithAmd.ContainsKey($c.scope) -and
        ($c.subtype -eq $AMENDMENT_SUBTYPE -or $c.subtype -eq $ORIGINAL_SUBTYPE)) {
      $needIds.Add($c.id)
    }
  }
  Write-Output ("  lease instruments to check = " + $needIds.Count)
  # NOTE: kind='text' chunk_index does NOT start at 0 -- the text layer is written
  # at idxBase = max(chunk_index)+1, so it begins at 1000+ and the base differs per
  # document. Never filter on an absolute chunk_index (a `lt.6` filter silently
  # returned zero rows). Fetch the LOWEST N per document with order+limit instead.
  $failed = 0
  for ($i = 0; $i -lt $needIds.Count; $i++) {
    $docId = $needIds[$i]
    $url = "$BASE/rest/v1/document_chunks?select=chunk_index,content&kind=eq.text&document_id=eq.$docId&order=chunk_index.asc&limit=6"
    $rows = $null
    for ($try = 1; $try -le 3; $try++) {
      $raw = (& curl.exe -s "$url" -H "apikey: $KEY" -H "Authorization: Bearer $KEY") -join "`n"
      if ($raw -and -not ($raw -match '"message"\s*:' -and $raw -match '"code"')) {
        try { $rows = @((ConvertFrom-Json -InputObject $raw) | ForEach-Object { $_ }); break } catch { $rows = $null }
      }
      Start-Sleep -Seconds (2 * $try)
    }
    if ($null -eq $rows) { $failed++; continue }
    if ($rows.Count -eq 0) { continue }   # no text layer for this document
    $txt = (($rows | Sort-Object chunk_index | ForEach-Object { $_.content }) -join ' ')
    $recitalCache[$docId] = Parse-Recital $txt
    $recitalStats.fetched++
    if ($recitalCache[$docId].had_recital) { $recitalStats.parsed++ }
    if (($i + 1) % 150 -eq 0) { Write-Output ("  ... " + ($i + 1) + "/" + $needIds.Count + " checked") }
  }
  if ($failed -gt 0) { Write-Output ("  WARN: " + $failed + " text fetches failed after retries") }
  Write-Output ("  documents with a text layer = " + $recitalStats.fetched +
                ";  recital parsed = " + $recitalStats.parsed)

  $origByScope = @{}
  # deduped, for the same reason section 4 dedupes: an OCR twin is not a second lease
  foreach ($g in $scopes) { $origByScope[$g.Name] = Get-DedupedOriginals @($g.Group | Where-Object { $_.subtype -eq $ORIGINAL_SUBTYPE }) }
  $byId = @{}
  foreach ($c in $classified) { $byId[$c.id] = $c }

  # (a) check every filename-derived edge against its own document
  $keep = New-Object System.Collections.Generic.List[object]
  foreach ($ed in $edges) {
    $r = $null
    if ($recitalCache.ContainsKey($ed.from_document_id)) { $r = $recitalCache[$ed.from_document_id] }
    $baseDoc = $byId[$ed.to_document_id]
    if (-not $r -or -not $r.had_recital -or -not $r.base_date) {
      $ed.match_basis = $ed.match_basis + '; FILENAME ONLY (no recital in text layer)'
      $ed.note = $ed.note + ' No document text available to corroborate this edge.'
      $recitalStats.filename_only++
      $keep.Add($ed); continue
    }
    if (Test-DateNear $r.base_date $baseDoc.fdate 5) {
      $ed.match_basis = $ed.match_basis + '; DOCUMENT-CONFIRMED'
      $ed.note = $ed.note + ' DOCUMENT-CONFIRMED: the amendment recites its lease as dated ' +
                 $r.base_date + ', matching the base document.'
      $recitalStats.confirmed++
      if ($r.self_ordinal) {
        if ($ed.stated_ordinal -and [int]$ed.stated_ordinal -ne [int]$r.self_ordinal) {
          $recitalStats.ordinal_disagreed++
          $ed.note = $ed.note + ' WARNING: filename says ordinal ' + $ed.stated_ordinal +
                     ' but the document titles itself amendment ' + $r.self_ordinal + '.'
        } else {
          $recitalStats.ordinal_confirmed++
          $ed.seq = $r.self_ordinal
          $ed.note = $ed.note + ' Ordinal confirmed by the document title (' + $r.self_ordinal + ').'
        }
      }
      $keep.Add($ed); continue
    }
    $recitalStats.conflict++
    $conflicts.Add([pscustomobject]@{
      amendment = $ed.from_name; filename_base = $ed.to_name
      recited_base_date = $r.base_date; base_filename_date = $baseDoc.fdate; scope = $ed.scope
    })
  }
  $edges = $keep

  # (b) rescue the successor-party rejects using the recited base-lease date --
  # the JAG Footwear / Jones Retail case: the filename records the operating
  # entity, the recital records the lease.
  $stillUnmatched = New-Object System.Collections.Generic.List[object]
  foreach ($um in $unmatched) {
    $doc = @($classified | Where-Object { $_.name -eq $um.amendment -and $_.scope -eq $um.scope })
    $resolvedIt = $false
    if ($doc.Count -eq 1 -and $recitalCache.ContainsKey($doc[0].id)) {
      $r = $recitalCache[$doc[0].id]
      if ($r.base_date) {
        $cands = @($origByScope[$um.scope] | Where-Object { Test-DateNear $r.base_date $_.fdate 5 })
        if ($cands.Count -eq 1) {
          $a = $doc[0]; $baseLease = $cands[0]
          $sq = $a.ord
          if ($r.self_ordinal) { $sq = $r.self_ordinal }
          $succ = ''
          if ($r.successor_to) { $succ = " Document names the tenant successor-in-interest to '" + $r.successor_to + "'." }
          $edges.Add([pscustomobject]@{
            from_document_id = $a.id; to_document_id = $baseLease.id; relationship = 'amends'
            seq = $sq; stated_ordinal = $r.self_ordinal; party = $a.party; scope = $um.scope
            from_name = $a.name; to_name = $baseLease.name; from_date = $a.fdate
            match_basis = 'RECITAL-RESOLVED successor chain; DOCUMENT-CONFIRMED'
            note = "[Stage A2 document-corroborated] The filename party ('" + $a.party +
                   "') does not match the base lease, but this amendment's own recital dates its lease " +
                   $r.base_date + ", matching the base document." + $succ +
                   " Wired on the DOCUMENT's statement, not the filename."
          })
          $recitalStats.resolved_successor++
          $resolvedIt = $true
        }
      }
    }
    if (-not $resolvedIt) { $stillUnmatched.Add($um) }
  }
  $unmatched = $stillUnmatched

  # (b2) RE-SEQUENCE each assembled chain. Rescued amendments arrive after the
  # filename pass, so a chain can read 1,1,1,1,6,7,8 until every member is known.
  # chain_position = order by document date across the WHOLE chain; stated_ordinal
  # stays whatever the document calls itself. The two are reported separately --
  # they legitimately differ when the parties left middle amendments unnumbered.
  foreach ($fam in ($edges | Group-Object to_document_id)) {
    $members = @($fam.Group | Sort-Object @{Expression={
      if ($_.from_date) { $_.from_date } else { '9999-99-99' }
    }}, from_name)
    $pos = 0
    foreach ($ed in $members) {
      $pos++
      $ed.seq = $pos
      $ordText = 'no ordinal stated in the document or filename'
      if ($ed.stated_ordinal) { $ordText = 'document/filename states ordinal ' + $ed.stated_ordinal }
      $ed.note = $ed.note + ' CHAIN POSITION ' + $pos + ' of ' + $members.Count +
                 ' by document date (' + $ordText + ').'
    }
  }

  # (c) EVIDENCE-BASED gap detection: an instrument the documents RECITE that the
  # register does not hold. Unlike an ordinal gap, this is grounded in the text.
  foreach ($g in $scopes) {
    $inScope = @($g.Group)
    $present = @($inScope | Where-Object { $_.fdate } | ForEach-Object { $_.fdate })
    $seen = @{}
    foreach ($c in $inScope) {
      if (-not $recitalCache.ContainsKey($c.id)) { continue }
      $rc = $recitalCache[$c.id]
      foreach ($rd in @($rc.recited)) {
        if ($seen.ContainsKey($rd)) { continue }
        $seen[$rd] = $true
        # PLAUSIBILITY WINDOW: a recited prior instrument must post-date the lease
        # and pre-date the document reciting it. Without this, rent-schedule period
        # boundaries and option dates read as missing instruments.
        if ($rc.base_date -and $rd -lt $rc.base_date) { continue }
        if ($c.fdate) {
          $slack = ([datetime]::ParseExact($c.fdate, 'yyyy-MM-dd', $null)).AddDays(60).ToString('yyyy-MM-dd')
          if ($rd -gt $slack) { continue }
        }
        $hit = @($present | Where-Object { Test-DateNear $rd $_ 5 })
        if ($hit.Count -eq 0) {
          $realGaps.Add([pscustomobject]@{
            recited_date = $rd; recited_by = $c.name; scope = $g.Name
            reciting_doc_date = $c.fdate; chain_base_date = $rc.base_date
          })
        }
      }
    }
  }

  Write-Output ""
  Write-Output "  -- corroboration result --"
  Write-Output ("  edges DOCUMENT-CONFIRMED          = " + $recitalStats.confirmed)
  Write-Output ("  edges rescued from successor pile = " + $recitalStats.resolved_successor + "  (recital-resolved)")
  Write-Output ("  edges left FILENAME-ONLY          = " + $recitalStats.filename_only + "  (no text layer)")
  Write-Output ("  edges DROPPED on recital conflict = " + $recitalStats.conflict)
  Write-Output ("  ordinals confirmed by document    = " + $recitalStats.ordinal_confirmed +
                ";  disagreed = " + $recitalStats.ordinal_disagreed)
  Write-Output ("  FINAL edge count                  = " + $edges.Count)
  Write-Output ("  amendments still unwired          = " + $unmatched.Count)
  if ($conflicts.Count -gt 0) {
    Write-Output ""
    Write-Output "  !! recital/filename CONFLICTS (nothing wired for these):"
    $conflicts | Select-Object -First 8 | ForEach-Object {
      Write-Output ("     " + $_.amendment)
      Write-Output ("       recital dates the lease " + $_.recited_base_date + " but the filename base is dated " + $_.base_filename_date + " (" + $_.filename_base + ")")
    }
  }
  if ($realGaps.Count -gt 0) {
    Write-Output ""
    Write-Output ("  !! " + $realGaps.Count + " RECITED-BUT-NOT-FOUND instruments (candidates, each needs a human)")
    Write-Output "     TWO possible explanations per row, and this pass cannot tell them apart:"
    Write-Output "       (a) the instrument is genuinely missing from the register, or"
    Write-Output "       (b) the reciting document states the WRONG DATE for a document we do hold."
    Write-Output "     Both are real defects, but they need opposite fixes -- go find the doc, vs"
    Write-Output "     correct the citation. Confirmed example of (b): Wild Wing Cafe's 2nd Amendment"
    Write-Output "     recites its First Amendment as 'dated July 22, 2022'; the filed First Amendment"
    Write-Output "     is dated July 22, 2020. Confirmed example of (a): Nine West's General Assignment"
    Write-Output "     and Assumption Agreement dated January 1, 2003 is recited but not in the register."
    $realGaps | Select-Object -First 10 | ForEach-Object {
      Write-Output ("     instrument dated " + $_.recited_date + " -- recited by " + $_.recited_by)
    }
  }
} else {
  Write-Output ""
  Write-Output "!! -SkipRecitals: edges are FILENAME-DERIVED ONLY and have NOT been checked against"
  Write-Output "   the documents. Stage A alone produced a false finding exactly this way."
  foreach ($ed in $edges) { $ed.match_basis = $ed.match_basis + '; FILENAME ONLY (recital check skipped)' }
}

# --- 5. missing-source worklist, split into actionable classes ------------
$missing = @($classified | Where-Object { -not $_.sha -and $_.path })
$mTemp = @($missing | Where-Object { $_.path -match '(?i)\\Temp\\claude\\|\\scratchpad\\' })
$mReal = @($missing | Where-Object { $_.path -notmatch '(?i)\\Temp\\claude\\|\\scratchpad\\' })
Write-Output ""
Write-Output ("=== missing-source worklist (content_sha256 null) = " + $missing.Count + " ===")
Write-Output ("  class 1: ingested from a TEMP/scratchpad path that no longer exists = " + $mTemp.Count)
Write-Output "           (these were never file-server documents; the register points at deleted temp files)"
Write-Output ("  class 2: real file-server paths whose file moved or was renamed     = " + $mReal.Count)
Write-Output "  top class-2 folders:"
@($mReal | Group-Object { Split-Path $_.path -Parent } | Sort-Object Count -Descending | Select-Object -First 10) | ForEach-Object {
  Write-Output ("  {0,5}  {1}" -f $_.Count, $_.Name)
}

# --- 6. reports -----------------------------------------------------------
$missCsv  = "$ReportDir\cre_missing_sources.csv"
$edgeCsv  = "$ReportDir\cre_proposed_edges.csv"
$unmCsv   = "$ReportDir\cre_unwired_amendments.csv"
$subCsv   = "$ReportDir\cre_doc_subtypes.csv"
$missing    | Select-Object id, property_id, subtype, name, path, @{N='class';E={ if ($_.path -match '(?i)\\Temp\\claude\\|\\scratchpad\\') { 'temp_path' } else { 'file_moved' } }} | Export-Csv -Path $missCsv -NoTypeInformation -Encoding UTF8
$edges      | Select-Object seq, stated_ordinal, from_date, party, relationship, match_basis, from_name, to_name, from_document_id, to_document_id, scope | Export-Csv -Path $edgeCsv -NoTypeInformation -Encoding UTF8
$gapCsv = "$ReportDir\cre_ordinal_gaps_UNRELIABLE.csv"
$ordGaps | Select-Object base, present, missing, unordinaled_in_chain, scope | Export-Csv -Path $gapCsv -NoTypeInformation -Encoding UTF8
$realGapCsv = "$ReportDir\cre_recited_missing_documents.csv"
$conflictCsv = "$ReportDir\cre_recital_conflicts.csv"
$realGaps  | Select-Object recited_date, recited_by, reciting_doc_date, chain_base_date, scope | Export-Csv -Path $realGapCsv -NoTypeInformation -Encoding UTF8
$conflicts | Select-Object amendment, recited_base_date, base_filename_date, filename_base, scope | Export-Csv -Path $conflictCsv -NoTypeInformation -Encoding UTF8
$unmatched  | Select-Object reason, party, amendment, scope, originals_in_scope | Export-Csv -Path $unmCsv -NoTypeInformation -Encoding UTF8
$classified | Where-Object { $_.subtype } | Select-Object id, subtype, family, via_folder, name | Export-Csv -Path $subCsv -NoTypeInformation -Encoding UTF8
Write-Output ""
Write-Output "reports:"
Write-Output ("  proposed edges      -> " + $edgeCsv)
Write-Output ("  unwired amendments  -> " + $unmCsv)
Write-Output ("  RECITED-BUT-MISSING -> " + $realGapCsv + "   (evidence-based document gaps)")
Write-Output ("  recital conflicts   -> " + $conflictCsv)
Write-Output ("  ordinal gaps        -> " + $gapCsv + "   (UNRELIABLE, see note above)")
Write-Output ("  missing sources     -> " + $missCsv)
Write-Output ("  subtype assignments -> " + $subCsv)

if (-not $Apply) {
  Write-Output ""
  Write-Output "DRY RUN -- nothing written. Re-run with -Apply to write doc_subtype + edges."
  return
}

# --- 7. write (only with -Apply) ------------------------------------------
function PostRows($url, $rows, $prefer) {
  if ($rows.Count -eq 0) { return 0 }
  $written = 0
  for ($i = 0; $i -lt $rows.Count; $i += 200) {
    $end = [math]::Min($i + 199, $rows.Count - 1)
    $chunk = @($rows[$i..$end])
    $json = $chunk | ConvertTo-Json -Depth 3
    if ($chunk.Count -eq 1) { $json = "[$json]" }
    [System.IO.File]::WriteAllText($TMP, $json, $utf8NoBom)
    $ok = $false
    for ($try = 1; $try -le 4; $try++) {
      $resp = & curl.exe -s -X POST $url -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Prefer: $prefer" --data-binary "@$TMP"
      if (-not ($resp -match '"message"\s*:' -and $resp -match '"code"')) {
        # count what actually PERSISTED: return=minimal can 201 without persisting
        $written += ([regex]::Matches([string]$resp, '"id"\s*:')).Count
        $ok = $true; break
      }
      $head = [string]$resp
      if ($head.Length -gt 300) { $head = $head.Substring(0,300) }
      Write-Output ("  POST retry $try" + ": " + $head)
      Start-Sleep -Seconds (5 * $try)
    }
    if (-not $ok) { Write-Output ("  WARN: chunk dropped (" + $chunk.Count + " rows)") }
  }
  return $written
}

# 7a. doc_subtype -- upsert-merge on id. doc_type/title echoed because an upsert
# is INSERT..ON CONFLICT and must satisfy the table's NOT NULL columns.
$subRows = @($classified | Where-Object { $_.subtype -and $_.subtype -ne $_.prior_subtype } | ForEach-Object {
  @{ id = $_.id; doc_type = $_.doc_type; title = $_.title; doc_subtype = $_.subtype }
})
Write-Output ""
Write-Output ("writing doc_subtype for " + $subRows.Count + " documents ...")
$w1 = PostRows "$BASE/rest/v1/documents?on_conflict=id" $subRows "resolution=merge-duplicates,return=representation"
Write-Output ("  persisted = " + $w1)

# 7b. edges -- idempotent on unique(from_document_id,to_document_id,relationship)
$edgeRows = @($edges | ForEach-Object {
  @{ from_document_id = $_.from_document_id; to_document_id = $_.to_document_id; relationship = $_.relationship; note = $_.note }
})
Write-Output ("writing " + $edgeRows.Count + " 'amends' edges ...")
$w2 = PostRows "$BASE/rest/v1/document_relationships?on_conflict=from_document_id,to_document_id,relationship" $edgeRows "resolution=merge-duplicates,return=representation"
Write-Output ("  persisted = " + $w2)
Write-Output ""
Write-Output "APPLY COMPLETE. Verify on /doc-control and spot-check edges before relying on them."
