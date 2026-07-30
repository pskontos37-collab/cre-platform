# dryrun_argus4.ps1 - READ-ONLY extract of the 'Argus Assumptions' tab from ALL CF Model
# VERSIONS in every property folder under K:\ASSTMGMT\ACQUISITIONS.
#
# WHY v4 EXISTS: v3 took only the NEWEST model per folder, so usable vintages collapsed to
# 2017-2026 and the longitudinal series was thrown away. v4 opens every version, which turns
# the DB from "what do we assume" into "how have our assumptions moved by vintage".
#
# CHANGES vs v3 -- all four matter, none is cosmetic:
#   1. NO EARLY BREAK. v3 stopped at the first candidate holding an Argus tab. v4 opens every
#      selected file and emits a row for each, tab or no tab.
#   2. SAME-DAY VARIANTS COLLAPSE. '_Base Case' / '_v2' / '_MHS v2' saved on the same date are
#      ONE underwrite, not three comps (a 25-version folder would otherwise carry 25x the
#      weight in every median). Selection = one file per (folder, model_date), top-ranked by
#      the same order v3 used: template-shaped name first, then larger file.
#   3. FORCE-INCLUDE WHAT IS ALREADY LOADED. 88 of the 1,013 files v3 loaded into prod are NOT
#      the scenario winner for their (folder, date) -- 46 of them carry parse_status OK. If v4
#      dropped them, load_comps.ps1's read-back (table count == what the run built) would fail
#      and those rows would orphan. The candidate set is therefore a strict SUPERSET of
#      dryrun3_workbooks.csv, and the log names every force-add.
#   4. FILENAME-DATE CLAMP. v3 accepted years to 2035, so 'CF Model_Bella Terra_5-31-2029
#      BASE CASE.xlsx' loaded as a 2029 model. Clamp to current year + 1; a rejected date
#      falls back to the file's mtime year, same as an undated filename.
#
# Also: rows accumulate in List[object] and flush by APPEND. v3's '$arr += row' is O(n^2) and
# v4 builds ~4x the cells, where that cost stops being theoretical.
#
# Never writes to K:. Opens every workbook READ-ONLY, with links and macros suppressed.
param(
  [string[]]$States = @(),          # empty = every property state/market folder
  [int]$Limit = 0,                  # cap folders (smoke test)
  [int]$MaxWorkbooks = 0,           # cap total opens (smoke test)
  [double]$MaxMB = 60,
  [switch]$Resume,                  # skip (state,prop,file) already in dryrun4_workbooks.csv
  [string]$Tag = ''                 # output suffix, for a side-by-side smoke test
)
$ErrorActionPreference = 'Continue'
$SP   = $PSScriptRoot
$Root = 'K:\ASSTMGMT\ACQUISITIONS'
$Log  = Join-Path $SP ("dryrun_argus4$Tag.log")
function L($m){ $s = "$(Get-Date -Format 'HH:mm:ss')  $m"; Write-Host $s; $s | Out-File $Log -Append -Encoding ascii }
if(-not $Resume){ '' | Out-File $Log -Encoding ascii }

# top-level folders that are not property/deal folders
$NOT_PROPERTY = @('Admin & Miscellaneous','Asset Management Meetings','Israel Powerpoint Templates',
                  'Letters of Intent','Market Reports','Marketing Examples','MRW','Presentations',
                  'TBP Accomplishments 091423','Test State','1 Pipeline')

# ---------- 1. candidate selection ----------
$inv = Import-Csv (Join-Path $SP 'acq_inventory.csv')
$cand = $inv | Where-Object {
  $_.prop -ne '(root)' -and $NOT_PROPERTY -notcontains $_.state -and
  $_.ext -match '^\.xls' -and $_.name -match '(?i)cf model|cash ?flow' -and
  ($States.Count -eq 0 -or $States -contains $_.state)
}
$YMAX = (Get-Date).Year + 1
function Get-NameDate($n){
  $m = [regex]::Match($n, '(\d{1,2})[-\.](\d{1,2})[-\.](\d{2,4})')
  if(-not $m.Success){ return $null }
  try{
    $mo=[int]$m.Groups[1].Value; $dy=[int]$m.Groups[2].Value; $yr=[int]$m.Groups[3].Value
    if($yr -lt 100){ $yr += 2000 }
    # clamp: a filename date past next year is a typo, not a forecast vintage
    if($mo -lt 1 -or $mo -gt 12 -or $dy -lt 1 -or $dy -gt 31 -or $yr -lt 1995 -or $yr -gt $YMAX){ return $null }
    return (Get-Date -Year $yr -Month $mo -Day $dy -Hour 0 -Minute 0 -Second 0)
  } catch { return $null }
}
$JUNK = '(?i)export|statement|combined|10 ?year|10 ?yr|summary only|argus cash flow'

$all = New-Object System.Collections.Generic.List[object]
foreach($r in $cand){
  $nd  = Get-NameDate $r.name
  $eff = if($nd){ $nd } else { [datetime]"$($r.year)-01-01" }
  $all.Add([pscustomobject]@{
    state=$r.state; prop=$r.prop; name=$r.name; mb=[double]$r.mb
    path=(Join-Path (Join-Path (Join-Path $Root $r.state) $r.prop) $r.relpath)
    eff=$eff; ymd=$eff.ToString('yyyy-MM-dd')
    date_source=$(if($nd){'filename'}else{'mtime_year'})
    junk=$(if($r.name -match $JUNK){1}else{0})
    istemplate=$(if($r.name -match '(?i)cf model'){0}else{1})
  })
}
# one non-junk representative per (folder, model_date)
$pick = @{}
$dropped = 0
foreach($g in ($all | Where-Object { $_.junk -eq 0 } | Group-Object state,prop,ymd)){
  $top = $g.Group | Sort-Object istemplate, @{e='mb';Descending=$true}, name | Select-Object -First 1
  $pick["$($top.state)|$($top.prop)|$($top.name)"] = $top
  $dropped += ($g.Count - 1)
}
$junkCount = @($all | Where-Object { $_.junk -eq 1 }).Count
# force-include every file already loaded into prod by v3 (superset guarantee)
$forced = 0
$wb3path = Join-Path $SP 'dryrun3_workbooks.csv'
if(Test-Path $wb3path){
  $byKey = @{}
  foreach($x in $all){ $byKey["$($x.state)|$($x.prop)|$($x.name)"] = $x }
  foreach($r in (Import-Csv $wb3path)){
    if($States.Count -gt 0 -and $States -notcontains $r.state){ continue }
    $k = "$($r.state)|$($r.prop)|$($r.file)"
    if($pick.ContainsKey($k)){ continue }
    if($byKey.ContainsKey($k)){ $pick[$k] = $byKey[$k]; $forced++; L "  force-add (already in prod): $k" }
    else { L "  WARN already-loaded file not in inventory, cannot re-open: $k" }
  }
}
L ("SELECTION  candidates=$($all.Count)  junk-named=$junkCount  same-day duplicates dropped=$dropped  force-added=$forced  -> selected=$($pick.Count)")

# distinct dated versions per folder, for the versions_in_folder column
$verPerFolder = @{}
foreach($v in $pick.Values){
  $fk = "$($v.state)|$($v.prop)"
  if(-not $verPerFolder.ContainsKey($fk)){ $verPerFolder[$fk] = @{} }
  $verPerFolder[$fk][$v.ymd] = $true
}
$folders = @()
foreach($g in ($pick.Values | Group-Object state,prop)){
  $ordered = @($g.Group | Sort-Object @{e='eff';Descending=$true}, name)
  $folders += [pscustomobject]@{
    state=$g.Group[0].state; prop=$g.Group[0].prop
    versions=$verPerFolder["$($g.Group[0].state)|$($g.Group[0].prop)"].Count
    cands=$ordered
  }
}
$folders = $folders | Sort-Object state, prop
if($Limit -gt 0){ $folders = $folders | Select-Object -First $Limit }
# -Property with a scriptblock does not work in PS 5.1; project first, then sum.
$totalOpens = ($folders | ForEach-Object { $_.cands.Count } | Measure-Object -Sum).Sum
L "START folders=$($folders.Count) selected_workbooks=$totalOpens resume=$($Resume.IsPresent)"

# ---------- 2. name matching (identical to v3 -- the validator is not what changed) ----------
$ABBR = @{ 'blvd'='boulevard'; 'rd'='road'; 'st'='street'; 'ave'='avenue'; 'dr'='drive'
           'ctr'='center'; 'cntr'='center'; 'centre'='center'; 'sq'='square'; 'pkwy'='parkway'
           'hwy'='highway'; 'mkt'='market'; 'plz'='plaza'; 'ln'='lane'; 'ct'='court'; 'pt'='point' }
$STOP = @('the','and','for','llc','lp','inc','of','at','cf','model','und','underwriting','draft',
          'final','rev','copy','v1','v2','v3','xls','xlsx','analysis','acquisition','proforma','pro',
          'forma','summary','review','assumptions','assumption','argus','cash','flow','statement',
          'export','combined','year','yr','file','changes','noteable','notable','update','updated')
$WEAK = @('north','south','east','west','place','plaza','center','square','park','village','commons',
          'shops','shoppes','crossing','crossings','point','pointe','ridge','creek','station','market',
          'town','mall','building','tower','office','retail','centre','corner','corners','gateway',
          'landing','walk','pavilion','promenade','junction','heights','hills','lake','lakes','valley',
          'view','grove','springs','oaks','main','street','road','avenue','drive','boulevard','old','new')
$ROLE = @('broker','brokers','seller','sellers','buyer','lender','our','ours','internal','house',
          'inhouse','mjw','wilkow','conservative','aggressive','downside','upside','bull','bear','base',
          'case','sensitivity','scenario','original','revised','mgmt','management','leasing','tenant',
          'tenants','property','asset','subject','deal','current','proposed','adjusted','combined')
$ROMAN = @{ 'i'='1';'ii'='2';'iii'='3';'iv'='4';'v'='5';'vi'='6';'vii'='7';'viii'='8';'ix'='9';'x'='10' }

function Tok($s){
  if([string]::IsNullOrWhiteSpace($s)){ return @() }
  $t = ($s.ToLower() -replace '[^a-z0-9]+',' ').Trim() -split '\s+'
  $out=@()
  foreach($w in $t){
    if($ROMAN.ContainsKey($w)){ $out += $ROMAN[$w]; continue }
    if($w.Length -lt 3 -and $w -notmatch '^\d+$'){ continue }
    if($STOP -contains $w){ continue }
    if($ABBR.ContainsKey($w)){ $w = $ABBR[$w] }
    $out += $w
  }
  return ($out | Select-Object -Unique)
}
function Lev($a,$b){
  $n=$a.Length; $m=$b.Length
  if($n -eq 0){ return $m }; if($m -eq 0){ return $n }
  $prev = 0..$m
  for($i=1;$i -le $n;$i++){
    $cur = New-Object 'int[]' ($m+1); $cur[0]=$i
    for($j=1;$j -le $m;$j++){
      $c = if($a[$i-1] -eq $b[$j-1]){0}else{1}
      $cur[$j] = [Math]::Min([Math]::Min($cur[$j-1]+1, $prev[$j]+1), $prev[$j-1]+$c)
    }
    $prev = $cur
  }
  return $prev[$m]
}
function Fuzzy-Shared($a,$b){
  $hits=@()
  foreach($x in $a){
    if($x.Length -lt 6){ continue }
    foreach($y in $b){
      if($y.Length -lt 6){ continue }
      if([Math]::Abs($x.Length-$y.Length) -gt 2){ continue }
      if((Lev $x $y) -le 2){ $hits += "$x~$y" }
    }
  }
  return $hits
}
function Compact($s){ return (($s.ToLower() -replace '[^a-z0-9]','')) }
function Initialisms($s){
  $t = ($s.ToLower() -replace '[^a-z0-9]+',' ').Trim() -split '\s+'
  $w=@()
  foreach($x in $t){
    if($ROMAN.ContainsKey($x)){ $w += $ROMAN[$x]; continue }
    if($STOP -contains $x){ continue }
    if($x.Length -eq 0){ continue }
    $w += $x
  }
  $out=@()
  for($k=2;$k -le $w.Count;$k++){
    $s2=''
    for($i=0;$i -lt $k;$i++){ $p=$w[$i]; $s2 += $(if($p -match '^\d+$'){$p}else{$p.Substring(0,1)}) }
    if($s2.Length -ge 3){ $out += $s2 }
  }
  return ($out | Select-Object -Unique)
}
function Is-Initialism($folder,$header){
  $fc = Compact $folder; $hc = Compact $header
  foreach($c in (Initialisms $header)){ if($fc -eq $c -or $fc.StartsWith($c)){ return $true } }
  foreach($c in (Initialisms $folder)){ if($hc -eq $c -or $hc.StartsWith($c)){ return $true } }
  return $false
}
function Verdict($folder,$header){
  if([string]::IsNullOrWhiteSpace($header)){ return @('NO_HEADER','','') }
  $a = Tok $folder; $b = Tok $header
  if($a.Count -eq 0){ return @('UNTESTABLE','','') }
  $roleHit = @($b | Where-Object { $ROLE -contains $_ })
  $bNamey  = @($b | Where-Object { $ROLE -notcontains $_ -and $WEAK -notcontains $_ })
  if($b.Count -eq 0 -or $bNamey.Count -eq 0){ return @('UNLABELED','',($roleHit -join '+')) }
  $ov     = @($a | Where-Object { $b -contains $_ })
  $strong = @($ov | Where-Object { $WEAK -notcontains $_ })
  if($strong.Count -ge 1){ return @('MATCH', ($strong -join '+'), ($roleHit -join '+')) }
  $fz = @(Fuzzy-Shared $a $b)
  if($fz.Count -ge 1){ return @('MATCH_FUZZY', ($fz -join '+'), ($roleHit -join '+')) }
  if(Is-Initialism $folder $header){ return @('MATCH_ABBREV', ("$folder~$header"), ($roleHit -join '+')) }
  if($ov.Count -ge 1){ return @('WEAK_MATCH', ($ov -join '+'), ($roleHit -join '+')) }
  return @('MISMATCH','',($roleHit -join '+'))
}

# ---------- 3. sheet helpers (identical to v3) ----------
function Get-Grid($ws){
  $ur = $ws.UsedRange
  $r = $ur.Rows.Count; $c = $ur.Columns.Count
  if($r -eq 1 -and $c -eq 1){ $g = New-Object 'object[,]' 2,2; $g[1,1] = $ur.Value2; return @($g,1,1) }
  return @($ur.Value2, $r, $c)
}
function CellS($g,$i,$j){ try{ $v=$g[$i,$j] } catch { return '' }; if($null -eq $v){ return '' }; return ("$v").Trim() }
function Find-Cell($g,$rows,$cols,$rx){
  for($i=1;$i -le $rows;$i++){ for($j=1;$j -le $cols;$j++){ $s=CellS $g $i $j; if($s -and $s -match $rx){ return @($i,$j) } } }
  return $null
}
function Find-InCol($g,$rows,$col,$rx,$from){
  for($i=$from;$i -le $rows;$i++){ $s=CellS $g $i $col; if($s -and $s -match $rx){ return $i } }
  return 0
}
function Header-From($g,$rows,$cols){
  $lim=[Math]::Min($rows,4)
  for($i=1;$i -le $lim;$i++){ for($j=1;$j -le $cols;$j++){
    $s=CellS $g $i $j
    if($s.Length -ge 4 -and $s -notmatch '^\d+([\.,]\d+)?$'){ return $s }
  } }
  return ''
}
function Corner-Header($ws){
  try{
    $rg = $ws.Range($ws.Cells(1,1), $ws.Cells(4,12))
    $v  = $rg.Value2
    for($i=1;$i -le 4;$i++){ for($j=1;$j -le 12;$j++){
      try{ $x=$v[$i,$j] } catch { $x=$null }
      if($null -ne $x){ $s=("$x").Trim(); if($s.Length -ge 4 -and $s -notmatch '^\d+([\.,]\d+)?$'){ return $s } }
    } }
  } catch {}
  return ''
}
$LABELS = @(
  @{k='renewal_probability'; rx='renewal\s*prob'}
  @{k='downtime_months';     rx='down\s*time|downtime'}
  @{k='market_rent';         rx='^market\s*rent'}
  @{k='reimbursement_method';rx='reimburse'}
  @{k='tenant_improvements'; rx='tenant\s*improve'}
  @{k='leasing_commissions'; rx='leasing\s*comm'}
  @{k='rent_abatements';     rx='rent\s*abate|free\s*rent'}
  @{k='term_length';         rx='term\s*length'}
  @{k='rental_rate_increase';rx='rental\s*rate\s*incr|rent\s*bump|increases'}
)

# Does this cell text read as an assumption-row LABEL rather than a value? Driven off
# $LABELS so a new label is covered automatically, plus the header words that appear on
# the assumptions block but are not themselves extracted labels.
$LABEL_TEXT_EXTRA = '(?i)(^rental\s*rate$|annual\s*step|abate|^term\b|term\s*\(|^categor|reimburs|^market\s*rent$)'
function Looks-Like-LabelText($v){
  $t = ("" + $v).Trim()
  if($t.Length -eq 0){ return $false }
  if($t -notmatch '[A-Za-z]'){ return $false }        # a bare number is a value, never a label
  foreach($l in $LABELS){ if($t -match ("(?i)" + $l.rx)){ return $true } }
  if($t -match $LABEL_TEXT_EXTRA){ return $true }
  # prose sitting where a header belongs: several words and long. 'NNN', '5 Years' and
  # 'Gross' must NOT trip this, so require both a length and a word-count floor.
  # NOT reached from Bad-Category - see the note there.
  if($t.Length -gt 24 -and (@($t -split '\s+' | Where-Object { $_ })).Count -ge 5){ return $true }
  return $false
}

# ---------------------------------------------------------------------------
# COLUMN VALIDATION (added 2026-07-30 after 126 misaligned cells were traced here)
#
# The category columns are taken from every non-empty cell on the "Category" row
# from $lc+1 all the way to $cc - the FULL UsedRange width. When another table sits
# to the right of the assumptions block, its header row lines up and its headers
# become "categories". Values then read out of that foreign table.
#
# Observed, from dryrun4_assumptions.csv:
#   Sullivan Center      cat='Suite' val='350A' | cat='Start Date' val='44501'
#                        (44501 is an Excel date serial = 2021-11-05)
#                        also Tenant / RSF / Rental Rate / Annual Step / Term (Yr.)
#   175 West Jackson,    cat='Gateway' val='Liberty Travel' - that workbook's
#   One East Erie        "Category" row lists TENANTS, not space categories
#                        cat='Roll to market at rate of $90' - and prose
#
# The deny-list is deliberately restricted to STRUCTURAL HEADER LABELS. Two tempting
# heuristics were tried against the existing 100,588-row extract and BOTH were wrong,
# rejecting 4,943 rows that hold real values:
#   - "a header containing '$' is prose"  -> Argus modellers legitimately name a space
#     category by its rate: '$50 NNN - PH. 2' (135 rows), '$37.50 - State Street' (117),
#     '$11.75 Gross (Storage)' (65).
#   - "a header over 40 chars is prose"   -> a category is legitimately a multi-line
#     tenant roster: "Party City / Five Below / Shoe Carnival / Dollar Tree".
# So prose headers like 'Roll to market at rate of $90' are NOT filtered here. They are
# only reachable through the value==header rule below, which is evidence-based rather
# than shape-based. Header-labels-only rejects 271 rows (0.269%) and, verified against
# every distinct surviving category, loses nothing legitimate.
#
# Do not add a 'rental rate' / 'space' / 'total' / 'step' entry either: those ARE real
# Argus category names in this corpus. Only the four labels below actually leak.
#
# Anything rejected is counted and logged, never silently dropped - a silent filter
# would hide a layout change in a future workbook.
$DENY_CATEGORY = '(?i)^\s*(suite|suite\s*#|tenant|tenant\s*name|start\s*date|end\s*date|expir\w*|rsf|sq\.?\s*ft\.?|square\s*feet|lease\s*id|notes?|comments?|subtotal)\s*$'
function Bad-Category($name){
  if([string]::IsNullOrWhiteSpace($name)){ return $true }
  $t = ("" + $name).Trim()
  if($t -match $DENY_CATEGORY){ return $true }
  # A header that is itself an Excel date serial means the "Category" row was mis-detected
  # onto a date row (observed: cat='42947' carrying 43008..43343).
  if($t -match '^\d{5}$' -and [int]$t -ge 42000 -and [int]$t -le 46800){ return $true }
  # A header NAMED AFTER AN ASSUMPTION ROW ('Tenant \nImprovements', 'Term (Yr.)',
  # 'Rental Rate', 'Annual Step') means the Category row was mis-detected onto the
  # assumptions block's own labels. Note these carry embedded newlines from wrapped
  # Excel cells, so they never matched the structural list above. Reject via the label
  # vocabulary - but NOT via Looks-Like-LabelText's prose clause, which is deliberately
  # not applied to headers: a category is legitimately a long multi-line tenant roster.
  foreach($l in $LABELS){ if($t -match ("(?i)" + $l.rx)){ return $true } }
  if($t -match $LABEL_TEXT_EXTRA){ return $true }
  # A purely numeric header that is too large to be a suite number is a spilled dollar
  # total or serial, not a category: '10440000' carried TI -2146826265 (an Int32
  # underflow sentinel), '36500' carried TI 30436, '7879323.2' carried -0.15.
  # Suite-numbered and rent-tier categories are 4 digits or fewer ('8888', '9000',
  # '8900', '48', '36') and must survive, so the floor sits above them.
  if($t -match '^\d+$' -and $t.Length -le 9 -and [int64]$t -ge 20000){ return $true }
  if($t -match '^\d+\.\d+$'){ return $true }
  return $false
}

$GLOBALS = @(
  @{k='inflation_general'; rx='^general$';         anchor='property\s*inflation'}
  @{k='inflation_market';  rx='^market$';          anchor='property\s*inflation'}
  @{k='inflation_expense'; rx='^expense$';         anchor='property\s*inflation'}
  @{k='general_vacancy';   rx='general\s*vacancy'; anchor=$null}
  @{k='static_vacancy';    rx='static\s*vacancy';  anchor=$null}
  @{k='management_fee';    rx='management\s*fee';  anchor=$null}
  @{k='capital_reserves';  rx='capital\s*reserve'; anchor=$null}
)

# ---------- 4. output (append-based: O(n), unlike v3's full rewrite) ----------
$fWb = Join-Path $SP "dryrun4_workbooks$Tag.csv"
$fAs = Join-Path $SP "dryrun4_assumptions$Tag.csv"
$fGl = Join-Path $SP "dryrun4_globals$Tag.csv"
$doneKeys = @{}
if($Resume -and (Test-Path $fWb)){
  foreach($r in (Import-Csv $fWb)){ $doneKeys["$($r.state)|$($r.prop)|$($r.file)"] = $true }
  L "RESUME: $($doneKeys.Count) workbooks already recorded, will be skipped"
} else {
  foreach($f in @($fWb,$fAs,$fGl)){ if(Test-Path $f){ Remove-Item $f -Force } }
}
$wbBuf = New-Object System.Collections.Generic.List[object]
$asBuf = New-Object System.Collections.Generic.List[object]
$glBuf = New-Object System.Collections.Generic.List[object]
$nWb=0; $nAs=0; $nGl=0
# Rejected-cell counters for the column validation. Reported at the end so a filter
# can never quietly swallow a workbook whose layout changed.
$script:nRejCol=0; $script:nRejVal=0
function Append($buf, $file){
  if($buf.Count -eq 0){ return }
  if(Test-Path $file){ $buf | Export-Csv $file -NoTypeInformation -Encoding UTF8 -Append }
  else { $buf | Export-Csv $file -NoTypeInformation -Encoding UTF8 }
  $buf.Clear()
}
function Flush {
  $script:nWb += $script:wbBuf.Count; $script:nAs += $script:asBuf.Count; $script:nGl += $script:glBuf.Count
  Append $script:wbBuf $script:fWb
  Append $script:asBuf $script:fAs
  Append $script:glBuf $script:fGl
}

# ---------- 5. run ----------
function New-Excel {
  $a = New-Object -ComObject Excel.Application
  $a.Visible=$false; $a.DisplayAlerts=$false; $a.ScreenUpdating=$false
  $a.EnableEvents=$false; $a.AskToUpdateLinks=$false
  try{ $a.AutomationSecurity = 3 } catch {}
  return $a
}
function Kill-Excel($a){
  if($null -eq $a){ return }
  try{ $a.Quit() } catch {}
  try{ [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($a) } catch {}
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
$xl = New-Excel; $n=0; $opened=0; $skipped=0; $argusHits=0
$t0 = Get-Date
foreach($f in $folders){
  $n++
  $rank = 0
  foreach($c in $f.cands){
    $rank++
    $key = "$($f.state)|$($f.prop)|$($c.name)"
    if($doneKeys.ContainsKey($key)){ $skipped++; continue }
    if($MaxWorkbooks -gt 0 -and $opened -ge $MaxWorkbooks){ break }
    $row = [ordered]@{
      state=$f.state; prop=$f.prop; file=$c.name; model_date=$c.eff.ToString('yyyy-MM-dd')
      date_source=$c.date_source; versions=$f.versions; attempt=$rank; mb=$c.mb; sheets=0
      has_argus=$false; has_tbt=$false
      argus_header=''; argus_verdict=''; evidence=''; role_hint=''; rejected_columns=''
      secondary_header=''; secondary_sheet=''; secondary_verdict=''
      tbt_header=''; tbt_verdict=''
      categories=''; category_count=0; labels_found=0; parse_status=''; error=''
      version_rank=$rank; versions_in_folder=$f.versions
    }
    if($c.mb -gt $MaxMB){ $row.parse_status='SKIPPED_TOO_LARGE'; $wbBuf.Add([pscustomobject]$row); continue }
    if(-not (Test-Path -LiteralPath $c.path)){ $row.parse_status='FILE_MISSING'; $wbBuf.Add([pscustomobject]$row); continue }
    $opened++
    if($opened % 40 -eq 0){ Kill-Excel $xl; $xl = New-Excel }
    $wb=$null
    try{
      $wb = $xl.Workbooks.Open($c.path, 0, $true, [Type]::Missing, 'zzzz', 'zzzz', $true)
      $row.sheets = $wb.Sheets.Count
      $shA=$null; $shT=$null
      foreach($s in $wb.Sheets){
        $sn = "$($s.Name)".Trim()
        if($sn -match '(?i)^argus\s*assumption' -and $null -eq $shA){ $shA=$s }
        if($sn -match '(?i)tenant\s*by\s*tenant' -and $null -eq $shT){ $shT=$s }
      }
      $row.has_argus = ($null -ne $shA); $row.has_tbt = ($null -ne $shT)
      if($null -ne $shT){
        $row.tbt_header  = Corner-Header $shT
        $row.tbt_verdict = (Verdict $f.prop $row.tbt_header)[0]
      }
      if($null -eq $shA){
        $row.parse_status='NO_ARGUS_TAB'
      } else {
        $argusHits++
        $p = Get-Grid $shA; $g=$p[0]; $rr=$p[1]; $cc=$p[2]
        $row.argus_header = Header-From $g $rr $cc
        $v = Verdict $f.prop $row.argus_header
        $row.argus_verdict=$v[0]; $row.evidence=$v[1]; $row.role_hint=$v[2]
        if($row.argus_verdict -notin @('MATCH','MATCH_FUZZY','MATCH_ABBREV')){
          $best=$null
          foreach($s in $wb.Sheets){
            $sn="$($s.Name)".Trim()
            if($sn -match '(?i)^argus\s*assumption'){ continue }
            $h = Corner-Header $s
            if(-not $h){ continue }
            $v2 = Verdict $f.prop $h
            if($v2[0] -in @('MATCH','MATCH_FUZZY','MATCH_ABBREV')){ $best=@($h,$sn,$v2[0]); break }
            if($null -eq $best){ $best=@($h,$sn,$v2[0]) }
          }
          if($null -ne $best){ $row.secondary_header=$best[0]; $row.secondary_sheet=$best[1]; $row.secondary_verdict=$best[2] }
        }
        $anchor = Find-Cell $g $rr $cc 'renewal\s*prob'
        if($null -eq $anchor){ $row.parse_status='NO_MLA_BLOCK' }
        else {
          $lr=$anchor[0]; $lc=$anchor[1]; $catRow=0
          for($i=$lr; $i -ge [Math]::Max(1,$lr-8); $i--){ if((CellS $g $i $lc) -match '(?i)^categor'){ $catRow=$i; break } }
          $cols=@(); $names=@(); $rejCols=@()
          if($catRow -gt 0){
            for($j=$lc+1;$j -le $cc;$j++){
              $h=CellS $g $catRow $j
              if(-not $h){ continue }
              if(Bad-Category $h){ $rejCols += $h; continue }   # foreign table / prose header
              $cols+=$j; $names+=$h
            }
          }
          if($cols.Count -eq 0){ for($j=$lc+1;$j -le $cc;$j++){ if((CellS $g $lr $j)){ $cols+=$j; $names+=("col$j") } } }
          if($rejCols.Count -gt 0){ $script:nRejCol += $rejCols.Count; $row.rejected_columns = (($rejCols | Select-Object -First 8) -join ' | ') }
          $row.categories = (($names | Select-Object -First 12) -join ' | ')
          $row.category_count = $cols.Count
          $found=0
          foreach($lab in $LABELS){
            # Start BELOW the Category row, never at it. Starting AT $catRow let a
            # label regex match text inside the header row itself, so $r2 became
            # $catRow and every value read back was the column header. market_rent's
            # '^market\s*rent' and rental_rate_increase's 'increases' match header
            # text readily, so this was not a rare accident.
            # This is the ROOT-CAUSE fix. 100 rows in the previous extract had
            # raw_value identical to category, but only 33 of those were this defect -
            # the other 67 are workbooks that name a space category by its rent tier or
            # reimbursement type, where value==header is correct. Hence the narrow
            # Looks-Like-LabelText test below rather than a blanket value==header reject.
            $searchFrom = if($catRow -gt 0){ $catRow + 1 } else { 1 }
            $r2 = Find-InCol $g $rr $lc $("(?i)"+$lab.rx) $searchFrom
            if($r2 -eq 0){ continue }
            if($catRow -gt 0 -and $r2 -eq $catRow){ continue }   # belt and braces
            $any=$false
            for($k=0;$k -lt $cols.Count;$k++){
              $val = CellS $g $r2 $cols[$k]
              # A value identical to its own column header is SOMETIMES the header echoed
              # back - but not always, and the difference matters. Rejecting every
              # value==header match would have discarded 36 real numbers: Conejo Valley
              # Plaza and Shops at Kildeer name their space categories by rent tier, so
              # category '48' legitimately carries market_rent 48, and Park North's 'NNN'
              # category legitimately carries reimbursement_method NNN.
              # The true defect signature is narrower: the value is an ASSUMPTION LABEL
              # NAME ('Annual Step', 'Term (Yr.)', 'Tenant Improvements'), i.e. the header
              # row leaked into a data cell. Only that is refused.
              if($val -and ($val.Trim() -eq ("" + $names[$k]).Trim()) -and (Looks-Like-LabelText $val)){
                $script:nRejVal++; continue
              }
              if($val){
                $any=$true
                $asBuf.Add([pscustomobject]@{
                  state=$f.state; prop=$f.prop; file=$c.name; model_date=$row.model_date
                  argus_header=$row.argus_header; verdict=$row.argus_verdict
                  category=$names[$k]; label=$lab.k; raw_value=$val
                })
              }
            }
            if($any){ $found++ }
          }
          $row.labels_found=$found
          $row.parse_status = if($found -ge 6){'OK'} elseif($found -ge 1){'PARTIAL'} else {'BLOCK_EMPTY'}
          foreach($gl in $GLOBALS){
            $r3=0; $lcUse=0
            if($gl.anchor){
              $a2 = Find-Cell $g $rr $cc $("(?i)"+$gl.anchor)
              if($null -eq $a2){ continue }
              $r3 = Find-InCol $g ([Math]::Min($rr,$a2[0]+4)) $a2[1] $("(?i)"+$gl.rx) $a2[0]
              $lcUse = $a2[1]
            } else {
              $a3 = Find-Cell $g $rr $cc $("(?i)"+$gl.rx)
              if($null -eq $a3){ continue }
              $r3=$a3[0]; $lcUse=$a3[1]
            }
            if($r3 -eq 0){ continue }
            $val=''
            for($j=$lcUse+1;$j -le [Math]::Min($cc,$lcUse+3);$j++){ $x=CellS $g $r3 $j; if($x){ $val=$x; break } }
            if($val){ $glBuf.Add([pscustomobject]@{ state=$f.state; prop=$f.prop; file=$c.name; model_date=$row.model_date; label=$gl.k; raw_value=$val }) }
          }
        }
      }
      $wb.Close($false); $wb=$null
    } catch {
      $row.parse_status='ERROR'; $row.error=($_.Exception.Message -replace '[\r\n,]+',' ')
      if($null -ne $wb){ try{ $wb.Close($false) } catch {} }
    }
    $wbBuf.Add([pscustomobject]$row)
  }
  if($MaxWorkbooks -gt 0 -and $opened -ge $MaxWorkbooks){ L "  MaxWorkbooks reached"; break }
  if($n % 25 -eq 0){
    Flush
    $el = ((Get-Date) - $t0).TotalSeconds
    $rate = if($opened -gt 0){ $el / $opened } else { 0 }
    $left = ($totalOpens - $opened - $skipped) * $rate / 3600
    L ("  [$n/$($folders.Count)] opened=$opened argus=$argusHits cells=$nAs  {0:N2} s/wb  ETA {1:N1} h" -f $rate,$left)
  }
}
Kill-Excel $xl
Flush
L "DONE folders=$($folders.Count) opened=$opened skipped_resume=$skipped rows=$nWb assumption_cells=$nAs global_cells=$nGl argus_tabs=$argusHits"
L "COLUMN VALIDATION rejected_columns=$($script:nRejCol) rejected_header_values=$($script:nRejVal)  (see rejected_columns in the workbooks CSV for which headers were refused per file)"
L ("elapsed {0:N1} min" -f ((Get-Date)-$t0).TotalMinutes)
