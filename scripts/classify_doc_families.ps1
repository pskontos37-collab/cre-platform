param(
  [switch]$Apply,
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
# FAIL-CLOSED: an amendment is wired only when exactly ONE same-party original
# exists in scope. Zero or several -> no edge, and the case is reported for a
# human. A wrong edge is worse than a missing one.
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
  $origAll = @($g.Group | Where-Object { $_.subtype -eq $ORIGINAL_SUBTYPE })
  $origs = New-Object System.Collections.Generic.List[object]
  foreach ($grp in ($origAll | Group-Object { $_.party + '|' + [string]$_.fdate })) {
    $pick = @($grp.Group | Where-Object { -not $_.is_ocr })
    if ($pick.Count -eq 0) { $pick = @($grp.Group) }
    $origs.Add($pick[0])
  }
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
    $base = $fam.Group[0].base
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
          base = $base.name; scope = $g.Name
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
          base = $base.name; scope = $g.Name
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
        to_document_id   = $base.id
        relationship     = 'amends'
        seq              = $seqVal
        stated_ordinal   = $a.ord
        party            = $a.party
        scope            = $g.Name
        from_name        = $a.name
        to_name          = $base.name
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
  Write-Output ("  !! " + $ordGaps.Count + " chain(s) with MISSING intermediate amendments (document gap)")
  Write-Output "     the register holds a later amendment but not the ones before it:"
  $ordGaps | Sort-Object { ($_.missing -split ',').Count } -Descending | Select-Object -First 10 | ForEach-Object {
    $q = ''
    if ([int]$_.unordinaled_in_chain -gt 0) { $q = "  (" + $_.unordinaled_in_chain + " unordinaled amendment(s) here may be among them)" }
    Write-Output ("     " + $_.base)
    Write-Output ("       present ordinals: " + $_.present + "   MISSING: " + $_.missing + $q)
  }
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
$edges      | Select-Object seq, stated_ordinal, party, relationship, match_basis, from_name, to_name, from_document_id, to_document_id, scope | Export-Csv -Path $edgeCsv -NoTypeInformation -Encoding UTF8
$gapCsv = "$ReportDir\cre_chain_gaps.csv"
$ordGaps | Select-Object base, present, missing, unordinaled_in_chain, scope | Export-Csv -Path $gapCsv -NoTypeInformation -Encoding UTF8
$unmatched  | Select-Object reason, party, amendment, scope, originals_in_scope | Export-Csv -Path $unmCsv -NoTypeInformation -Encoding UTF8
$classified | Where-Object { $_.subtype } | Select-Object id, subtype, family, via_folder, name | Export-Csv -Path $subCsv -NoTypeInformation -Encoding UTF8
Write-Output ""
Write-Output "reports:"
Write-Output ("  proposed edges      -> " + $edgeCsv)
Write-Output ("  unwired amendments  -> " + $unmCsv)
Write-Output ("  incomplete chains   -> " + $gapCsv)
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
