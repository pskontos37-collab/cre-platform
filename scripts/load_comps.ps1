# load_comps.ps1 - normalize the Argus-Assumptions extract into the comps schema (mig 20240137).
#
# DEFAULT IS A DRY RUN. Nothing is written without -Apply, matching extract_underwriting.ps1.
#
# Input  : the read-only extract produced by dryrun_argus3.ps1 --
#            dryrun3_workbooks.csv / dryrun3_assumptions.csv / dryrun3_globals.csv
# Output : comps.source_property / source_document / assumption_set / assumption
#
# Idempotent by construction: every id is a deterministic UUID derived from its natural
# key, and writes use Prefer: resolution=merge-duplicates. Re-running updates in place
# instead of duplicating, so a partial run can simply be re-run.
#
# Loader gotchas honoured (reference-supabase-loaders):
#   - sb_secret_ is rejected on browser-like User-Agents -> curl.exe with an explicit UA.
#   - Prefer: return=minimal can 201 without persisting -> return=representation + a
#     read-back count at the end.
#   - PGRST102: a bulk array insert needs IDENTICAL keys on every object -> every row is
#     built from a fixed key template, nulls included.
#   - No ?? operator in PS 5.1; script is ASCII; locals are named distinctly from $BASE/$SECRET.
param(
  [switch]$Apply,
  [string]$CsvDir  = 'C:\Users\pskontos\Desktop\Software\acq_inventory',
  [string]$EnvFile = 'C:\Users\pskontos\Desktop\Software\cre-platform\.env',
  [int]$BatchSize  = 500,
  [int]$Limit      = 0,
  # Which extract to read. 'dryrun4' = ALL model versions (the current canonical extract);
  # 'dryrun3' = the superseded newest-per-folder extract, kept so an older run is reproducible.
  [ValidateSet('dryrun3','dryrun4')]
  [string]$Prefix  = 'dryrun4',
  # dryrun_argus4 writes incrementally, so a CSV exists long before the extract has finished.
  # Loading a PARTIAL extract is not merely incomplete: comps.lookup_assumptions defaults to the
  # LATEST version per property (mig 20240153), so a missing newer version silently promotes an
  # older model to 'latest' and changes the answer the panel gives. Refuse unless overridden.
  [switch]$AllowPartial
)
$ErrorActionPreference = 'Stop'
$SP  = $PSScriptRoot
$LOG = Join-Path $SP ("logs\load_comps_" + (Get-Date -Format 'yyyy-MM-dd_HHmm') + ".log")
if(-not (Test-Path (Split-Path $LOG))){ New-Item -ItemType Directory -Path (Split-Path $LOG) | Out-Null }
function L($m){ $s="$(Get-Date -Format 'HH:mm:ss')  $m"; Write-Host $s; $s | Out-File $LOG -Append -Encoding ascii }
L ("START  Apply=" + $Apply + "  CsvDir=" + $CsvDir)

# ---------------------------------------------------------------- config
$cfg=@{}; Get-Content $EnvFile | ForEach-Object { if($_ -match '^([A-Z_]+)=(.*)$'){ $cfg[$Matches[1]]=$Matches[2].Trim('"') } }
$BASE   = $cfg['VITE_SUPABASE_URL']
$SECRET = $cfg['SUPABASE_SECRET_KEY']
$UA     = 'cre-loader/1.0'
if(-not $BASE -or -not $SECRET){ throw 'Missing VITE_SUPABASE_URL / SUPABASE_SECRET_KEY in .env' }

# ---------------------------------------------------------------- helpers
$MD5 = [System.Security.Cryptography.MD5]::Create()
function DetId([string]$s){
  # deterministic UUID from a natural key -> idempotent re-runs, no id round-trips
  $b = $MD5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($s))
  $b[6] = ($b[6] -band 0x0f) -bor 0x30
  $b[8] = ($b[8] -band 0x3f) -bor 0x80
  return (New-Object System.Guid(,$b)).ToString()
}
function Nums([string]$s){
  if([string]::IsNullOrWhiteSpace($s)){ return @() }
  return @([regex]::Matches($s,'-?\d+(?:\.\d+)?') | ForEach-Object { [double]$_.Value })
}
function NullOr($v){ if($null -eq $v -or "$v" -eq ''){ return $null }; return $v }

# "None" is an ASSERTION OF ZERO by the model author; "-", "", "n/a", "varies" are not
# assertions at all. Conflating them would badly bias any median (1,794 free-rent cells
# say None -- dropping them instead of scoring them as 0 would overstate typical free rent).
function IsExplicitZero([string]$s){ return ($s -match '^(?i)\s*(none|no|nil)\s*$') }
function IsAbsent([string]$s){ return ([string]::IsNullOrWhiteSpace($s) -or ($s -match '^(?i)\s*(-+|n/?a|tbd|varies|various|see notes?)\s*$')) }

# Reimbursement spellings -> canonical. Expanded from what the first dry run surfaced in
# load_comps_unparsed.csv. This map is upserted into comps.reimbursement_vocab on -Apply so
# code and table cannot drift; further curation belongs in the TABLE, not here.
# Nothing is lost by folding a spelling into a canonical: raw_value is kept forever.
$VOCAB = @{
  'nnn'='nnn'; 'net'='net'; 'nnn + 15%'='nnn_plus_admin'; 'nnn+15%'='nnn_plus_admin'
  'base yr.'='base_year'; 'base year'='base_year'; 'new by'='base_year'; 'by stop'='base_year'
  'by gross'='base_year_gross'; 'fsg'='fsg'; 'none'='none'; 'varies'='varies'
  # --- added after dry run 1 ---
  'new base yr.'='base_year'; 'new base yr'='base_year'; 'by'='base_year'
  'cam+utl+ins+ret'='nnn'          # all four pools recovered = triple net
  'cam,tax,ins'='nnn'; 'ret,ins,cam'='nnn'; 'cam, tax, ins'='nnn'
  'cit+10%'='nnn_plus_admin'       # CAM/Insurance/Taxes plus a 10% admin load
  'nnn+15% admin'='nnn_plus_admin'; 'nnn+15% w/ trash'='nnn_plus_admin'; 'nnn+mgmt'='nnn_plus_admin'
  'fixed cam'='nnn'; 'fixed cam + nnn'='nnn'
  'gross'='modified_gross'
}
$VOCAB_NET = @{
  'nnn'=$true; 'net'=$true; 'nnn_plus_admin'=$true
  'base_year'=$false; 'base_year_gross'=$false; 'fsg'=$false; 'modified_gross'=$false
  'none'=$null; 'varies'=$null; 'unknown'=$null
}

# Percent metrics arrive as a fraction (0.75) in some models and as a percent (75) in
# others. Scale only when there is no % sign AND the value is <= 1.
function AsPct([double]$v, [string]$raw){
  if($raw -match '%'){ return $v }
  if($v -le 1){ return [math]::Round($v * 100, 4) }
  return $v
}

$EMPTY = [ordered]@{
  value_kind='unparsed'; unit=$null; recurrence=$null
  num_value=$null; num_new=$null; num_renew=$null; num_min=$null; num_max=$null
  at_year=$null; vocab_value=$null
}
function NewVal { $h=[ordered]@{}; foreach($k in $EMPTY.Keys){ $h[$k]=$EMPTY[$k] }; return $h }

# Mirror of the DB's CHECK constraints. Some cells hold prose, not assumptions -- e.g. a
# rent-bump cell reading "Assumed to vacate upon expiration in 2021" yields 2021, which the
# database correctly rejects as a percentage. Rather than learn that from a failed batch,
# enforce the same invariants here and downgrade a violator to 'unparsed' (raw_value is
# still kept, so nothing is lost and the cell surfaces for review).
function Sanitize($v, [string]$metric){
  $bad = $false
  switch($v.value_kind){
    'scalar'         { if($null -eq $v.num_value -or $null -ne $v.num_new -or $null -ne $v.num_min){ $bad=$true } }
    'new_renew_pair' { if($null -eq $v.num_new -or $null -ne $v.num_value -or $null -ne $v.num_min){ $bad=$true } }
    'range'          { if($null -eq $v.num_min -or $null -eq $v.num_max -or $v.num_max -lt $v.num_min -or $null -ne $v.num_value){ $bad=$true } }
    'at_year'        { if($null -eq $v.num_value -or $null -eq $v.at_year){ $bad=$true } }
    'vocab'          { if([string]::IsNullOrWhiteSpace($v.vocab_value)){ $bad=$true } }
  }
  # percentages live on 0-100 (assumption_pct_range_ck)
  if($v.unit -eq 'pct' -or $v.unit -eq 'pct_of_rent'){
    foreach($f in @('num_value','num_new','num_renew','num_min','num_max')){
      $x = $v[$f]
      if($null -ne $x -and ($x -lt 0 -or $x -gt 100)){ $bad=$true }
    }
  }
  # renewal probability is never a fraction of a percent (assumption_pct_scale_ck)
  if($metric -eq 'renewal_probability' -and $null -ne $v.num_value -and $v.num_value -ne 0 -and $v.num_value -lt 1){ $bad=$true }
  if($bad){
    $c = NewVal; $c.value_kind='unparsed'; return $c
  }
  return $v
}

function Normalize([string]$metric, [string]$raw){
  $v = NewVal
  $t = "$raw".Trim()
  if(IsAbsent $t){ $v.value_kind='none'; return $v }

  switch -Regex ($metric) {

    '^reimbursement_method$' {
      $k = $t.ToLower().Trim()
      if($VOCAB.ContainsKey($k)){ $v.value_kind='vocab'; $v.vocab_value=$VOCAB[$k] }
      else { $v.value_kind='unparsed' }   # surfaces the uncurated spellings for comps.reimbursement_vocab
      return $v
    }

    '^renewal_probability$' {
      if(IsExplicitZero $t){ $v.value_kind='scalar'; $v.unit='pct'; $v.num_value=0; return $v }
      $n = Nums $t
      if($n.Count -lt 1){ return $v }
      $v.value_kind='scalar'; $v.unit='pct'; $v.num_value = AsPct $n[0] $t
      return $v
    }

    '^(inflation_general|inflation_market|inflation_expense|general_vacancy|static_vacancy|management_fee)$' {
      if(IsExplicitZero $t){ $v.value_kind='scalar'; $v.unit='pct'; $v.num_value=0; return $v }
      $n = Nums $t
      if($n.Count -lt 1){ return $v }
      $v.value_kind='scalar'; $v.unit='pct'; $v.num_value = AsPct $n[0] $t
      return $v
    }

    '^capital_reserves$' {
      if(IsExplicitZero $t){ $v.value_kind='scalar'; $v.unit='usd_psf'; $v.num_value=0; $v.recurrence='annual'; return $v }
      $n = Nums $t
      if($n.Count -lt 1){ return $v }
      $v.value_kind='scalar'; $v.unit='usd_psf'; $v.num_value=$n[0]; $v.recurrence='annual'
      return $v
    }

    '^downtime_months$' {
      if(IsExplicitZero $t){ $v.value_kind='scalar'; $v.unit='months'; $v.num_value=0; return $v }
      $n = Nums $t
      if($n.Count -lt 1){ return $v }
      $x = $n[0]; if($t -match '(?i)year|yr'){ $x = $x * 12 }
      if($x -lt 0 -or $x -gt 120){ return $v }
      $v.value_kind='scalar'; $v.unit='months'; $v.num_value=$x
      return $v
    }

    '^term_length$' {
      if(IsExplicitZero $t){ $v.value_kind='none'; return $v }
      $n = Nums $t
      if($n.Count -lt 1){ return $v }
      $x = $n[0]; if($t -match '(?i)year|yr'){ $x = $x * 12 }
      if($x -lt 1 -or $x -gt 600){ return $v }
      $v.value_kind='scalar'; $v.unit='months'; $v.num_value=$x
      return $v
    }

    '^market_rent$' {
      if(IsExplicitZero $t){ $v.value_kind='none'; return $v }
      $n = Nums $t
      if($n.Count -ge 2 -and $t -match '\d\s*(?:-|to)\s*\$?\s*\d'){
        $lo=[math]::Min($n[0],$n[1]); $hi=[math]::Max($n[0],$n[1])
        if($hi -le 0 -or $hi -gt 500){ return $v }
        $v.value_kind='range'; $v.unit='usd_psf'; $v.num_min=$lo; $v.num_max=$hi
        return $v
      }
      if($n.Count -lt 1){ return $v }
      # a stated market rent of 0 is a placeholder, not a $0/SF market. Recording it as a
      # scalar zero would drag every median down; treat it as not asserted.
      if($n[0] -eq 0){ $v.value_kind='none'; return $v }
      if($n[0] -lt 0 -or $n[0] -gt 500){ return $v }
      $v.value_kind='scalar'; $v.unit='usd_psf'; $v.num_value=$n[0]
      return $v
    }

    '^tenant_improvements$' {
      if(IsExplicitZero $t){ $v.value_kind='new_renew_pair'; $v.unit='usd_psf'; $v.num_new=0; $v.num_renew=0; return $v }
      $n = Nums $t
      # new/renew is written with either separator: '$40 / $0' and '$40 - $0' both occur.
      # Unlike market_rent a hyphen here is NOT a range -- a TI allowance of "40 down to 0"
      # is not a thing; it is new-lease $40, renewal $0.
      if($t -match '[/-]' -and $n.Count -ge 2){
        $v.value_kind='new_renew_pair'; $v.unit='usd_psf'; $v.num_new=$n[0]; $v.num_renew=$n[1]; return $v
      }
      if($n.Count -eq 1){ $v.value_kind='scalar'; $v.unit='usd_psf'; $v.num_value=$n[0]; return $v }
      return $v
    }

    '^leasing_commissions$' {
      $u = $null
      if($t -match '%'){ $u='pct_of_rent' } elseif($t -match '\$'){ $u='usd_psf' }
      if(IsExplicitZero $t){ $v.value_kind='new_renew_pair'; $v.unit='pct_of_rent'; $v.num_new=0; $v.num_renew=0; return $v }
      if($null -eq $u){ return $v }        # no % and no $ -> genuinely ambiguous, leave unparsed
      $n = Nums $t
      if($t -match '[/-]' -and $n.Count -ge 2){
        $v.value_kind='new_renew_pair'; $v.unit=$u; $v.num_new=$n[0]; $v.num_renew=$n[1]; return $v
      }
      if($n.Count -eq 1){ $v.value_kind='scalar'; $v.unit=$u; $v.num_value=$n[0]; return $v }
      return $v
    }

    '^rent_abatements$' {
      if(IsExplicitZero $t){ $v.value_kind='new_renew_pair'; $v.unit='months'; $v.num_new=0; $v.num_renew=0; return $v }
      $n = Nums $t
      if($t -match '[/-]' -and $n.Count -ge 2){
        $v.value_kind='new_renew_pair'; $v.unit='months'; $v.num_new=$n[0]; $v.num_renew=$n[1]; return $v
      }
      if($n.Count -eq 1){ $v.value_kind='scalar'; $v.unit='months'; $v.num_value=$n[0]; return $v }
      return $v
    }

    '^rental_rate_increase$' {
      if(IsExplicitZero $t){ $v.value_kind='scalar'; $v.unit='pct'; $v.num_value=0; $v.recurrence='annual'; return $v }
      $n = Nums $t
      if($n.Count -lt 1){ return $v }
      # '10% in Y6' / '10% in year 6' -> a one-time step at a stated year
      $ym = [regex]::Match($t,'(?i)(?:in\s*)?y(?:ea)?r?\s*(\d{1,2})')
      if($ym.Success -and $t -match '%'){
        $v.value_kind='at_year'; $v.unit='pct'; $v.num_value=$n[0]
        $v.at_year=[int]$ym.Groups[1].Value; $v.recurrence='one_time'
        return $v
      }
      if($t -match '\$'){ $v.value_kind='scalar'; $v.unit='usd_psf'; $v.num_value=$n[0]; $v.recurrence='annual'; return $v }
      $v.value_kind='scalar'; $v.unit='pct'; $v.num_value = AsPct $n[0] $t; $v.recurrence='annual'
      return $v
    }
  }
  return $v
}

# scope_kind from the source column header
$SPACE_RX = '(?i)^(retail|office|industrial|anchor|inline|shop|shops|pad|restaurant|junior|jr\.?\s*anchor|small\s*shop|large|flex|medical|lab|warehouse|spec|speculative|vacant|major|mini|big\s*box|grocery|outparcel|second\s*gen|new\s*lease|renewal)\b'
function ScopeKind([string]$label){
  if([string]::IsNullOrWhiteSpace($label)){ return 'unknown' }
  if($label -match '(?i)^(suite|ste\.?|unit|space)\s*[-#]?\s*\w+'){ return 'suite' }
  if($label -match $SPACE_RX){ return 'space_category' }
  if($label -match '(?i)^col\d+$'){ return 'unknown' }
  return 'tenant'
}

# ---------------------------------------------------------------- load CSVs
# Refuse a half-written extract before reading anything (see -AllowPartial above). The extractor
# logs a 'DONE ...' line only after its final flush, so that line is the completeness signal.
$extractLog = Join-Path $CsvDir ("dryrun_argus" + $Prefix.Substring($Prefix.Length-1) + ".log")
if(Test-Path $extractLog){
  $doneLine = @(Select-String -Path $extractLog -Pattern '^\S+\s+DONE ' | Select-Object -Last 1)
  if($doneLine.Count -eq 0){
    if(-not $AllowPartial){
      L "REFUSING TO LOAD - $extractLog has no 'DONE' line, so the extract is still running or died."
      L "  A partial load would promote an older model to 'latest' for any property whose newer"
      L "  version has not been extracted yet, silently changing what the panel reports."
      L "  Re-run once the extract finishes, or pass -AllowPartial if you truly mean to."
      throw 'extract incomplete'
    }
    L 'WARN -AllowPartial: loading an extract with no DONE line'
  } else {
    L ("extract complete: " + $doneLine[0].Line.Trim())
  }
} else {
  L "WARN no extract log at $extractLog - cannot confirm completeness"
  if(-not $AllowPartial){ throw 'extract log missing; pass -AllowPartial to override' }
}

$wb = Import-Csv (Join-Path $CsvDir ($Prefix + '_workbooks.csv'))
$as = Import-Csv (Join-Path $CsvDir ($Prefix + '_assumptions.csv'))
$gl = Import-Csv (Join-Path $CsvDir ($Prefix + '_globals.csv'))
if($Limit -gt 0){ $wb = $wb | Select-Object -First $Limit }
L ("csv[$Prefix]: workbooks={0}  assumption_cells={1}  global_cells={2}" -f $wb.Count,$as.Count,$gl.Count)

$MATCHY = @('MATCH','MATCH_FUZZY','MATCH_ABBREV')
$ROOT   = 'K:\ASSTMGMT\ACQUISITIONS'

# ---------------------------------------------------------------- build rows
$propRows=@{}; $docRows=@{}; $setRows=@{}; $factRows=@()
$setIdByDocKey=@{}; $setValidation=@{}

foreach($r in $wb){
  $pKey = "$($r.state)|$($r.prop)"
  $propId  = DetId ("sp|"+$pKey)
  if(-not $propRows.ContainsKey($pKey)){
    $propRows[$pKey] = [ordered]@{
      id=$propId; market=$r.state; folder_name=$r.prop
      folder_path=(Join-Path (Join-Path $ROOT $r.state) $r.prop)
      normalized_name=($r.prop.ToLower() -replace '[^a-z0-9]+',' ').Trim()
      asset_class='unknown'; city=$null; state_code=$null
      pipeline_deal_id=$null; property_id=$null
      first_seen_year=$null; last_seen_year=$null
    }
  }
  $dKey = "$pKey|$($r.file)"
  $docId  = DetId ("sd|"+$dKey)
  $mdate = $null
  if($r.model_date -match '^\d{4}-\d{2}-\d{2}$'){
    $yr=[int]$r.model_date.Substring(0,4)
    # filename dates are typo-prone; clamp to a sane window (a 2029 model date was observed)
    if($yr -ge 1995 -and $yr -le ((Get-Date).Year + 1)){ $mdate = $r.model_date }
  }
  $ds = 'unknown'
  if($r.date_source -eq 'filename'){ $ds='filename' } elseif($r.date_source -eq 'mtime_year'){ $ds='file_mtime' }
  $docRows[$dKey] = [ordered]@{
    id=$docId; source_property_id=$propId; file_name=$r.file
    file_path=(Join-Path $propRows[$pKey].folder_path $r.file)
    file_mb=$(if($r.mb){[double]$r.mb}else{$null})
    doc_kind='cf_model'; model_date=$mdate; date_source=$ds
    versions_in_folder=$(if($r.versions){[int]$r.versions}else{$null})
    sheet_count=$(if($r.sheets){[int]$r.sheets}else{$null})
    counterparty=$null; nda_reference=$null
    document_id=$null; extract_run_id=$null
  }

  if($r.has_argus -ne 'True'){ continue }

  $verdict = $r.argus_verdict
  $val = 'unverified'
  if($MATCHY -contains $verdict){ $val='confirmed' }
  elseif($verdict -eq 'MISMATCH'){ $val='contaminated' }
  elseif($verdict -eq 'UNTESTABLE'){ $val='untestable' }
  elseif(($verdict -eq 'UNLABELED' -or $verdict -eq 'NO_HEADER') -and ($MATCHY -contains $r.secondary_verdict)){ $val='confirmed_secondary' }

  $tier='unknown'
  if($r.role_hint -match '(?i)broker'){ $tier='broker' }
  elseif($r.role_hint -match '(?i)seller'){ $tier='seller' }
  elseif($val -eq 'confirmed' -or $val -eq 'confirmed_secondary'){ $tier='internal' }

  $ps = switch ($r.parse_status) {
    'OK'           { 'ok' }
    'PARTIAL'      { 'partial' }
    'BLOCK_EMPTY'  { 'block_empty' }
    'NO_MLA_BLOCK' { 'no_block' }
    'ERROR'        { 'error' }
    default        { $null }
  }
  $ev = $r.evidence
  if($val -eq 'confirmed_secondary' -and $r.secondary_sheet){ $ev = "via sheet '$($r.secondary_sheet)': $($r.secondary_header)" }

  $setId = DetId ("as|$docId|Argus Assumptions")
  $setRows[$dKey] = [ordered]@{
    id=$setId; source_document_id=$docId; tab_name='Argus Assumptions'
    tab_header=(NullOr $r.argus_header); trust_tier=$tier; scope_axis='unknown'
    validation=$val; validation_evidence=(NullOr $ev)
    conflicting_name=$(if($val -eq 'contaminated'){ NullOr $r.argus_header } else { $null })
    conflicting_source_property_id=$null
    parse_status=$ps
    labels_found=$(if($r.labels_found){[int]$r.labels_found}else{$null})
    category_count=$(if($r.category_count){[int]$r.category_count}else{$null})
    reviewed_by=$null; reviewed_at=$null; review_note=$null
  }
  $setIdByDocKey[$dKey] = $setId
  $setValidation[$setId]  = $val
}
L ("built: source_property={0}  source_document={1}  assumption_set={2}" -f $propRows.Count,$docRows.Count,$setRows.Count)

# ---- assumption facts (scoped) --------------------------------------------
$scopeTally=@{}; $kindTally=@{}; $unparsed=@{}
# Column POSITION, not the label, identifies a cell. A tab can repeat a header (two
# 'Retail' columns, or blanks), so keying the id on (set, metric, label) collides and
# Postgres rejects the whole batch with 21000 "ON CONFLICT DO UPDATE command cannot
# affect row a second time". dryrun_argus3 emits columns in order within each metric,
# so the running index per (set, metric) IS the true column position.
$emitIdx=@{}
foreach($r in $as){
  $dKey = "$($r.state)|$($r.prop)|$($r.file)"
  if(-not $setIdByDocKey.ContainsKey($dKey)){ continue }
  $setId = $setIdByDocKey[$dKey]
  $ek = "$setId|$($r.label)"
  if(-not $emitIdx.ContainsKey($ek)){ $emitIdx[$ek] = 0 } else { $emitIdx[$ek] = $emitIdx[$ek] + 1 }
  $colIdx = $emitIdx[$ek]
  $sk = ScopeKind $r.category
  $scopeTally[$sk] = [int]$scopeTally[$sk] + 1
  $n  = Sanitize (Normalize $r.label $r.raw_value) $r.label
  $kindTally[$n.value_kind] = [int]$kindTally[$n.value_kind] + 1
  if($n.value_kind -eq 'unparsed'){
    $uk = "$($r.label) :: $($r.raw_value)"
    $unparsed[$uk] = [int]$unparsed[$uk] + 1
  }
  $factRows += [ordered]@{
    id=(DetId ("a|$setId|$($r.label)|#$colIdx"))
    assumption_set_id=$setId; metric=$r.label
    scope_label=(NullOr $r.category); scope_kind=$sk; tenant_id=$null
    column_position=$colIdx
    raw_value=$r.raw_value
    value_kind=$n.value_kind; unit=$n.unit; recurrence=$n.recurrence
    num_value=$n.num_value; num_new=$n.num_new; num_renew=$n.num_renew
    num_min=$n.num_min; num_max=$n.num_max; at_year=$n.at_year; vocab_value=$n.vocab_value
    normalizer_version='load_comps/1.0'
  }
}
# ---- assumption facts (property-level globals) -----------------------------
foreach($r in $gl){
  $dKey = "$($r.state)|$($r.prop)|$($r.file)"
  if(-not $setIdByDocKey.ContainsKey($dKey)){ continue }
  $setId = $setIdByDocKey[$dKey]
  $n = Sanitize (Normalize $r.label $r.raw_value) $r.label
  $kindTally[$n.value_kind] = [int]$kindTally[$n.value_kind] + 1
  if($n.value_kind -eq 'unparsed'){
    $uk = "$($r.label) :: $($r.raw_value)"
    $unparsed[$uk] = [int]$unparsed[$uk] + 1
  }
  $factRows += [ordered]@{
    id=(DetId ("a|$setId|$($r.label)|__property__"))
    assumption_set_id=$setId; metric=$r.label
    scope_label='property'; scope_kind='property'; tenant_id=$null
    column_position=$null
    raw_value=$r.raw_value
    value_kind=$n.value_kind; unit=$n.unit; recurrence=$n.recurrence
    num_value=$n.num_value; num_new=$n.num_new; num_renew=$n.num_renew
    num_min=$n.num_min; num_max=$n.num_max; at_year=$n.at_year; vocab_value=$n.vocab_value
    normalizer_version='load_comps/1.0'
  }
}
L ("assumption rows built: {0}" -f $factRows.Count)

# ---- scope_axis per set (majority of its own columns) ----------------------
$byS=@{}
foreach($f in $factRows){
  if($f.scope_kind -eq 'property'){ continue }
  $s=$f.assumption_set_id
  if(-not $byS.ContainsKey($s)){ $byS[$s]=@{} }
  $byS[$s][$f.scope_kind] = [int]$byS[$s][$f.scope_kind] + 1
}
foreach($k in @($setRows.Keys)){
  $s = $setRows[$k].id
  if(-not $byS.ContainsKey($s)){ continue }
  $sc = [int]$byS[$s]['space_category']; $tn = [int]$byS[$s]['tenant'] + [int]$byS[$s]['suite']
  if($sc -gt 0 -and $tn -gt 0){ $setRows[$k].scope_axis = 'mixed' }
  elseif($sc -gt 0){ $setRows[$k].scope_axis = 'space_category' }
  elseif($tn -gt 0){ $setRows[$k].scope_axis = 'tenant_or_suite' }
}

# ---- resolve contaminated headers to the property they actually name --------
$STOPT=@('the','and','for','llc','lp','inc','argus','assumptions','assumption','cash','flow','underwriting','property')
$WEAKT=@('north','south','east','west','place','plaza','center','square','park','village','commons','shops','crossing','point','ridge','creek','station','market','town','mall','building','tower','office','retail','centre','corner','gateway','landing','walk','pavilion','junction','heights','hills','lake','valley','view','grove','springs','oaks','main','street','road','avenue','drive','boulevard','old','new')
function StrongTok($s){
  if([string]::IsNullOrWhiteSpace($s)){ return @() }
  return @((($s.ToLower() -replace '[^a-z0-9]+',' ').Trim() -split '\s+') | Where-Object { $_.Length -ge 3 -and $STOPT -notcontains $_ -and $WEAKT -notcontains $_ } | Select-Object -Unique)
}
$tokIdx=@{}
foreach($p in $propRows.Values){ foreach($t in (StrongTok $p.folder_name)){ if(-not $tokIdx.ContainsKey($t)){ $tokIdx[$t]=@() }; $tokIdx[$t] += $p.id } }
$resolved=0
foreach($k in @($setRows.Keys)){
  if($setRows[$k].validation -ne 'contaminated'){ continue }
  $hits=@(); foreach($t in (StrongTok $setRows[$k].conflicting_name)){ if($tokIdx.ContainsKey($t)){ $hits += $tokIdx[$t] } }
  $hits = @($hits | Select-Object -Unique | Where-Object { $_ -ne $docRows[$k].source_property_id })
  if($hits.Count -eq 1){ $setRows[$k].conflicting_source_property_id = $hits[0]; $resolved++ }
}
L ("contaminated sets resolved to a corpus property (unambiguous only): {0}" -f $resolved)

# ---- exact folder_path link to pipeline_deals (never fuzzy: see The Village) -
$linked=0
try{
  $tmp = Join-Path $env:TEMP 'comps_deals.json'
  $code = curl.exe -s -o $tmp -w "%{http_code}" -H "apikey: $SECRET" -H "Authorization: Bearer $SECRET" -H "User-Agent: $UA" "$BASE/rest/v1/pipeline_deals?select=id,folder_path&folder_path=not.is.null"
  if($code -eq '200'){
    $parsed = (Get-Content $tmp -Raw | ConvertFrom-Json)
    $deals = @($parsed)
    $dmap=@{}
    foreach($d in $deals){ if($d.folder_path){ $dmap[$d.folder_path.TrimEnd('\').ToLower()] = $d.id } }
    foreach($p in $propRows.Values){
      $fp = $p.folder_path.TrimEnd('\').ToLower()
      if($dmap.ContainsKey($fp)){ $p.pipeline_deal_id = $dmap[$fp]; $linked++ }
    }
    L ("pipeline_deals with a folder_path: {0}; EXACT-path links made: {1}" -f $deals.Count,$linked)
  } else { L ("WARN could not read pipeline_deals (HTTP $code) - skipping deal links") }
} catch { L ("WARN deal-link step failed: " + $_.Exception.Message) }

# ---------------------------------------------------------------- report
$clean = @($factRows | Where-Object { $sv = $setValidation[$_.assumption_set_id]; $sv -eq 'confirmed' -or $sv -eq 'confirmed_secondary' })
L ""
L "================ NORMALIZATION REPORT ================"
L ("rows to write:  source_property {0} | source_document {1} | assumption_set {2} | assumption {3}" -f $propRows.Count,$docRows.Count,$setRows.Count,$factRows.Count)
L ("assumption rows on NON-quarantined sets: {0} ({1:P1})" -f $clean.Count, $(if($factRows.Count){$clean.Count/$factRows.Count}else{0}))
L "value_kind distribution:"
foreach($k in ($kindTally.Keys | Sort-Object { $kindTally[$_] } -Descending)){ L ("   {0,-16} {1,6}  ({2:P1})" -f $k,$kindTally[$k],($kindTally[$k]/$factRows.Count)) }
L "scope_kind distribution (scoped rows):"
foreach($k in ($scopeTally.Keys | Sort-Object { $scopeTally[$_] } -Descending)){ L ("   {0,-16} {1,6}" -f $k,$scopeTally[$k]) }
L "validation distribution (assumption_set):"
# Group-Object on an ordered hashtable must use a scriptblock: 'validation' is a KEY, not
# a property, so passing the bare name silently groups everything under one blank bucket.
$setRows.Values | Group-Object { $_.validation } | Sort-Object Count -Descending | ForEach-Object { L ("   {0,-20} {1,5}" -f $_.Name,$_.Count) }
L "trust_tier distribution (assumption_set):"
$setRows.Values | Group-Object { $_.trust_tier } | Sort-Object Count -Descending | ForEach-Object { L ("   {0,-20} {1,5}" -f $_.Name,$_.Count) }
L "scope_axis distribution (assumption_set):"
$setRows.Values | Group-Object { $_.scope_axis } | Sort-Object Count -Descending | ForEach-Object { L ("   {0,-20} {1,5}" -f $_.Name,$_.Count) }
L ("distinct unparsed raw forms: {0} (top 15)" -f $unparsed.Count)
foreach($k in ($unparsed.Keys | Sort-Object { $unparsed[$_] } -Descending | Select-Object -First 15)){ L ("   {0,5}x  {1}" -f $unparsed[$k],$k) }
$unparsed.GetEnumerator() | Sort-Object Value -Descending | Select-Object @{n='count';e={$_.Value}},@{n='metric_and_raw';e={$_.Key}} |
  Export-Csv (Join-Path $CsvDir 'load_comps_unparsed.csv') -NoTypeInformation -Encoding UTF8
L ("full unparsed list -> " + (Join-Path $CsvDir 'load_comps_unparsed.csv'))
L "======================================================"

# ---------------------------------------------------------------- write
function PostBatch($table, $rows, $conflictCols){
  $url = "$BASE/rest/v1/$table"
  if($conflictCols){ $url = "$url" + "?on_conflict=$conflictCols" }
  $payload = Join-Path $env:TEMP ("comps_" + $table + ".json")
  # A duplicate conflict key inside one request makes Postgres reject the ENTIRE batch
  # with 21000. Catch it here and say which key, instead of failing 2,000 rows in.
  if($conflictCols){
    $seenKey=@{}; $dupes=@(); $dedup=@()
    foreach($row in $rows){
      $kv = ($conflictCols -split ',' | ForEach-Object { "$($row[$_.Trim()])" }) -join '|'
      if($seenKey.ContainsKey($kv)){ $dupes += $kv } else { $seenKey[$kv]=$true; $dedup += $row }
    }
    if($dupes.Count -gt 0){
      L ("  WARN $table had {0} duplicate '{1}' values - kept first of each" -f $dupes.Count,$conflictCols)
      ($dupes | Select-Object -First 5) | ForEach-Object { L "    dup: $_" }
      $rows = $dedup
    }
  }
  $total = 0
  for($i=0; $i -lt $rows.Count; $i += $BatchSize){
    $slice = @($rows[$i..([Math]::Min($i+$BatchSize-1, $rows.Count-1))])
    # PGRST102: every object must carry identical keys -> ConvertTo-Json over ordered
    # hashtables built from one template guarantees that.
    $json = ConvertTo-Json -InputObject $slice -Depth 6
    if($slice.Count -eq 1){ $json = "[$json]" }
    [System.IO.File]::WriteAllText($payload, $json, (New-Object System.Text.UTF8Encoding($false)))
    $out = Join-Path $env:TEMP 'comps_resp.json'
    $code = curl.exe -s -o $out -w "%{http_code}" -X POST $url `
      -H "apikey: $SECRET" -H "Authorization: Bearer $SECRET" `
      -H "Content-Type: application/json" -H "Content-Profile: comps" `
      -H "Prefer: resolution=merge-duplicates,return=representation" `
      -H "User-Agent: $UA" --data-binary "@$payload"
    if($code -ne '200' -and $code -ne '201'){
      L ("  ERROR $table batch at $i -> HTTP $code")
      L ("  " + (Get-Content $out -Raw))
      throw "$table load failed"
    }
    $total += $slice.Count
    L ("  $table  $total/$($rows.Count)")
  }
}

if(-not $Apply){
  L "DRY RUN - nothing written. Re-run with -Apply once 'comps' is an exposed schema."
  return
}

# preflight: a new schema is invisible to PostgREST until it is exposed
$pf = Join-Path $env:TEMP 'comps_preflight.json'
$pfc = curl.exe -s -o $pf -w "%{http_code}" -H "apikey: $SECRET" -H "Authorization: Bearer $SECRET" -H "Accept-Profile: comps" -H "User-Agent: $UA" "$BASE/rest/v1/metric?select=key&limit=1"
if($pfc -ne '200'){
  L "PREFLIGHT FAILED - PostgREST cannot see schema 'comps' (HTTP $pfc):"
  L ("  " + (Get-Content $pf -Raw))
  L "FIX: Supabase Dashboard > Project Settings > API > Exposed schemas -> add 'comps', then re-run."
  throw 'comps schema not exposed'
}
L 'preflight ok - comps is exposed'

# keep comps.reimbursement_vocab in step with the map this run actually used
$vocabRows=@()
foreach($k in $VOCAB.Keys){
  $canon = $VOCAB[$k]
  $vocabRows += [ordered]@{ raw_key=$k; canonical=$canon; is_net=$VOCAB_NET[$canon]; notes='upserted by load_comps/1.0' }
}
PostBatch 'reimbursement_vocab' $vocabRows 'raw_key'

PostBatch 'source_property' @($propRows.Values) 'id'
PostBatch 'source_document' @($docRows.Values)  'id'
PostBatch 'assumption_set'  @($setRows.Values)  'id'
PostBatch 'assumption'      $factRows           'id'

# read back: return=minimal can 201 without persisting, so never trust the POST alone
# NOTE the ${tbl} braces. '?' is a LEGAL character in a PowerShell variable name (hence the
# automatic variable $?), so "$BASE/rest/v1/$tbl?select=id" parses '$tbl?select' as one
# undefined variable and silently requests /rest/v1/=id -> a 404 that looks like missing
# data on a table that is in fact fully populated. PostBatch escaped this only because it
# concatenates its query string separately.
$expected = @{
  source_property = $propRows.Count; source_document = $docRows.Count
  assumption_set  = $setRows.Count;  assumption      = $factRows.Count
}
$mismatch = $false
foreach($tbl in @('source_property','source_document','assumption_set','assumption')){
  $cf = Join-Path $env:TEMP 'comps_count.json'
  $hf = Join-Path $env:TEMP 'comps_count.hdr'
  $cc = curl.exe -s -o $cf -D $hf -w "%{http_code}" -H "apikey: $SECRET" -H "Authorization: Bearer $SECRET" `
        -H "Accept-Profile: comps" -H "Prefer: count=exact" -H "Range: 0-0" -H "User-Agent: $UA" "$BASE/rest/v1/${tbl}?select=id"
  $actual = $null
  $cr = (Select-String -Path $hf -Pattern '^content-range:\s*\S+/(\d+)' -AllMatches)
  if($cr){ $actual = [int]$cr.Matches[0].Groups[1].Value }
  $exp = $expected[$tbl]
  if($cc -ne '200' -and $cc -ne '206'){ L ("  read-back $tbl -> HTTP $cc  FAILED"); $mismatch=$true }
  elseif($actual -ne $exp){ L ("  read-back $tbl -> $actual rows, EXPECTED $exp  MISMATCH"); $mismatch=$true }
  else { L ("  read-back $tbl -> $actual rows  ok") }
}
if($mismatch){ throw 'read-back did not match what was sent' }
L 'DONE - all tables verified against what this run built'
