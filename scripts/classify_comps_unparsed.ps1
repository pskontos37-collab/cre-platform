$csv = Import-Csv 'C:\Users\pskontos\Desktop\Software\acq_inventory\load_comps_unparsed.csv'
$rows = foreach ($r in $csv) {
  $parts = $r.metric_and_raw -split ' :: ', 2
  [pscustomobject]@{ count=[int]$r.count; metric=$parts[0]; raw=$(if($parts.Count -gt 1){$parts[1]}else{''}) }
}

# Excel date serials for 2015..2027 land roughly in 42000..46800. A bare integer in
# that band inside a rent/commission column is almost certainly a DATE that drifted
# from a neighbouring column, not a value.
function IsDateSerial($s) {
  $n = 0
  if ([int]::TryParse($s, [ref]$n)) { return ($n -ge 42000 -and $n -le 46800) }
  return $false
}
function Classify($metric, $raw) {
  $t = ($raw + '').Trim()
  if ($t -eq '') { return 'EMPTY' }
  if (IsDateSerial $t) { return 'MISALIGNED_date_serial' }
  # header/label text sitting in a data cell
  if ($t -match '^(Reimbursement Method|Leasing Commissions.*|total|Reimbursement)$') { return 'MISALIGNED_header_label' }
  $vocab = '(?i)(nnn|cam|net|gross|base|yr|year|stop|ret|tax|ins|mgmt|mgt|mf|admin|af|month|mos|fsg|prs|ticam|gu|cap|fixed|prior|increase|only|spec)'
  if ($t -match '(?i)^[0-9.]+\s*(month|mos)') { return 'UNIT_months_of_rent' }
  if ($t -match '(?i)^[0-9.]+\s*year') { return 'MISALIGNED_term_not_commission' }
  if ($t -match '^[0-9]*\.[0-9]{6,}$') { return 'MISALIGNED_bare_ratio' }
  if ($t -match '^[0-9]+[A-Z]$') { return 'MISALIGNED_name_or_suite' }

  # REIMBURSEMENT FAMILIES ARE TESTED BEFORE THE NAME HEURISTIC, on purpose. Running
  # the name check first mislabelled real vocabulary as tenant names: "BYS" (24 cells,
  # = Base Year Stop) is all-caps with no lowercase vocabulary hit, so it looked like
  # a proper noun. Ordering, not the patterns, was the bug.
  if ($metric -eq 'reimbursement_method') {
    # "New BY+E" is the single biggest spelling at 104 cells and reads as
    # New Base Year + Escalations. Requiring BY at string start missed it.
    $grossPat = '(?i)(base ?yr|base year|\bbys\b|expense stop|fsg|\bby\b\s*\+|\bby\b\s*ret|^by\b|new by)'
    $netPat   = '(?i)(nnn|net|^nn$|^n$|cam|ticam|prs|ret|tax|ins|pro ?rata|gross ?up)'
    if ($t -match '(?i)mod\.? ?net') { return 'MAP_modified (his call)' }
    if ($t -match $grossPat) { return 'MAP_gross_basestop (is_net=false)' }
    if ($t -match $netPat)   { return 'MAP_net (is_net=true)' }
    # header labels that leaked into this column
    if ($t -match '(?i)^(reimbursement|total)$') { return 'MISALIGNED_header_label' }
    if ($t -match '^[A-Z][A-Za-z&. ]+$' -and $t -notmatch $vocab) { return 'MISALIGNED_name_or_suite' }
    return 'AMBIGUOUS_needs_his_call'
  }

  # a proper-noun-looking string carrying no rate/unit vocabulary = a tenant or suite
  if ($t -match '^[A-Z][A-Za-z&. ]+$' -and $t -notmatch $vocab) { return 'MISALIGNED_name_or_suite' }
  if ($t -match "^[A-Z][A-Za-z&.' ]+$" -and $t -notmatch $vocab) { return 'MISALIGNED_name_or_suite' }
  if ($t -match '^[0-9.]+$') { return 'NUMERIC_needs_unit_decision' }
  return 'AMBIGUOUS_needs_his_call'
}

$out = foreach ($r in $rows) {
  [pscustomobject]@{ count=$r.count; metric=$r.metric; raw=$r.raw; klass=(Classify $r.metric $r.raw) }
}
"{0,-40} {1,7} {2,7}" -f 'CLASS','cells','spellings'
"-" * 58
$out | Group-Object klass | Sort-Object { ($_.Group | Measure-Object count -Sum).Sum } -Descending | ForEach-Object {
  "{0,-40} {1,7} {2,7}" -f $_.Name, ($_.Group | Measure-Object count -Sum).Sum, $_.Count
}
""
"TOTAL cells: " + ($out | Measure-Object count -Sum).Sum
""
"=== MISALIGNED examples (these must NOT be mapped - they are the wrong column) ==="
$out | Where-Object { $_.klass -like 'MISALIGNED*' } | Sort-Object count -Descending |
  Select-Object -First 16 | ForEach-Object { "  {0,4}  {1,-24} {2}" -f $_.count, $_.metric, $_.raw }
""
"=== AMBIGUOUS reimbursement (his call) ==="
$out | Where-Object { $_.klass -like 'AMBIGUOUS*' -and $_.metric -eq 'reimbursement_method' } |
  Sort-Object count -Descending | Select-Object -First 12 | ForEach-Object { "  {0,4}  {1}" -f $_.count, $_.raw }
