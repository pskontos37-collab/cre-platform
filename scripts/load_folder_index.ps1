# load_folder_index.ps1 - aggregates acq_inventory.csv (one row per file on
# K:\ASSTMGMT\ACQUISITIONS) into comps.folder_index (one row per deal folder,
# migration 20240203) so /pipeline can answer "have we looked at this before?".
#
# Default is DRY RUN (prints the aggregate summary); -Apply upserts via
# PostgREST (on_conflict market,folder_name; idempotent, re-runnable after a
# fresh inventory scan). Also links source_property_id by exact
# (market, folder_name) match against comps.source_property.
#
#   .\scripts\load_folder_index.ps1            # dry run
#   .\scripts\load_folder_index.ps1 -Apply
param([switch]$Apply, [string]$CsvPath = '')
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY"; 'Accept-Profile' = 'comps' }
$HW = @{ apikey = $KEY; Authorization = "Bearer $KEY"; 'Content-Profile' = 'comps'; 'Content-Type' = 'application/json'; Prefer = 'resolution=merge-duplicates,return=minimal' }

if (-not $CsvPath) { $CsvPath = Join-Path (Split-Path $repo -Parent) 'acq_inventory\acq_inventory.csv' }
if (-not (Test-Path $CsvPath)) { throw "inventory csv not found: $CsvPath" }
# The scan date stamps inventoried_at; the CSV itself is the source of truth.
$invDate = (Get-Item $CsvPath).LastWriteTime.ToString('yyyy-MM-dd')

# Same non-property top-level folders dryrun_argus3/4 exclude, same (root) rule.
$NOT_PROPERTY = @('Admin & Miscellaneous','Asset Management Meetings','Israel Powerpoint Templates',
                  'Letters of Intent','Market Reports','Marketing Examples','MRW','Presentations',
                  'TBP Accomplishments 091423','Test State','1 Pipeline')

function New-DetId([string]$s) {
  # deterministic uuid from md5 (same idiom as load_comps.ps1)
  $md5 = [System.Security.Cryptography.MD5]::Create()
  $b = $md5.ComputeHash([Text.Encoding]::UTF8.GetBytes($s))
  $hex = -join ($b | ForEach-Object { $_.ToString('x2') })
  return '{0}-{1}-{2}-{3}-{4}' -f $hex.Substring(0,8), $hex.Substring(8,4), $hex.Substring(12,4), $hex.Substring(16,4), $hex.Substring(20,12)
}

# norm for matching: lowercase, strip punctuation, collapse spaces (mirrors the
# spirit of comps.norm_label without needing a DB round-trip per row).
function Norm([string]$s) {
  $t = $s.ToLowerInvariant()
  $t = $t -replace '[^a-z0-9 ]', ' '
  $t = $t -replace '\s+', ' '
  return $t.Trim()
}

Write-Output "reading $CsvPath ..."
$inv = Import-Csv $CsvPath
Write-Output ("rows: {0}" -f $inv.Count)

$agg = @{}
foreach ($r in $inv) {
  if ($r.prop -eq '(root)') { continue }
  if ($NOT_PROPERTY -contains $r.state) { continue }
  $k = $r.state + '|' + $r.prop
  if (-not $agg.ContainsKey($k)) {
    $agg[$k] = [pscustomobject]@{
      market = $r.state; folder = $r.prop; files = 0; mb = 0.0
      y0 = $null; y1 = $null; cf = 0; om = 0; rr = 0; lease = 0; argus = 0
    }
  }
  $a = $agg[$k]
  $a.files++
  $mb = 0.0; [void][double]::TryParse($r.mb, [ref]$mb); $a.mb += $mb
  $y = 0; [void][int]::TryParse($r.year, [ref]$y)
  if ($y -ge 1980 -and $y -le 2027) {
    if ($null -eq $a.y0 -or $y -lt $a.y0) { $a.y0 = $y }
    if ($null -eq $a.y1 -or $y -gt $a.y1) { $a.y1 = $y }
  }
  $n = $r.name; $ext = $r.ext.ToLowerInvariant()
  if ($ext -match '^\.xls' -and $n -match '(?i)^(?!~\$)(cf model|cash ?flow model)') { $a.cf++ }
  elseif ($ext -in @('.avux', '.sf')) { $a.argus++ }
  elseif ($n -match '(?i)rent.?roll') { $a.rr++ }
  elseif ($ext -eq '.pdf' -and $n -match '(?i)(offering|teaser|flyer|\bom\b|o\.m\.)') { $a.om++ }
  elseif ($ext -in @('.pdf', '.doc', '.docx') -and $n -match '(?i)(lease|amendment|\blse\b|estoppel|snda|guaranty)') { $a.lease++ }
}
Write-Output ("deal folders: {0}" -f $agg.Count)

# comps linkage by exact (market, folder_name). PAGINATED: PostgREST silently
# caps any select at max-rows (1,000 here) regardless of a larger limit param -
# the documented trap that once skipped completed work in the re-brief runner.
$sel = [uri]::EscapeDataString('id,market,folder_name')
$pmapIdx = @{}
$fetched = 0
for ($off = 0; ; $off += 1000) {
  $page = Invoke-RestMethod -Uri "$BASE/rest/v1/source_property?select=$sel&order=id&limit=1000&offset=$off" -Headers $H -UserAgent $UA -TimeoutSec 120
  foreach ($p in $page) { $pmapIdx[$p.market + '|' + $p.folder_name] = $p.id }
  $fetched += @($page).Count
  if (@($page).Count -lt 1000) { break }
}
Write-Output ("comps source properties fetched: {0}" -f $fetched)
if ($fetched -lt 1013) { throw "source_property fetch short: $fetched (expected >= 1013)" }

$rows = @()
$linked = 0
foreach ($a in $agg.Values) {
  $spid = $null
  $lk = $a.market + '|' + $a.folder
  if ($pmapIdx.ContainsKey($lk)) { $spid = $pmapIdx[$lk]; $linked++ }
  $rows += ,@{
    id = New-DetId ('folder_index|' + $lk)
    market = $a.market; folder_name = $a.folder; norm_name = (Norm $a.folder)
    n_files = $a.files; total_mb = [math]::Round($a.mb, 1)
    first_year = $a.y0; last_year = $a.y1
    n_cf_models = $a.cf; n_oms = $a.om; n_rent_rolls = $a.rr
    n_lease_docs = $a.lease; n_argus = $a.argus
    source_property_id = $spid; inventoried_at = $invDate
  }
}
Write-Output ("prepared {0} rows ({1} linked to loaded comps)" -f $rows.Count, $linked)
$top = $rows | Sort-Object { -1 * $_.n_files } | Select-Object -First 5
foreach ($t in $top) { Write-Output ("  sample: {0}\{1}  files={2} cf={3} om={4} years={5}-{6}" -f $t.market, $t.folder_name, $t.n_files, $t.n_cf_models, $t.n_oms, $t.first_year, $t.last_year) }

if (-not $Apply) { Write-Output 'DRY RUN - rerun with -Apply to upsert.'; exit 0 }

$batch = 500
for ($i = 0; $i -lt $rows.Count; $i += $batch) {
  $chunk = $rows[$i..([Math]::Min($i + $batch - 1, $rows.Count - 1))]
  $body = ConvertTo-Json @($chunk) -Depth 6
  $tmp = "$PSScriptRoot\_folder_index_body.json"
  [System.IO.File]::WriteAllText($tmp, $body, (New-Object System.Text.UTF8Encoding($false)))
  $out = & curl.exe -s -w "`n%{http_code}" -X POST "$BASE/rest/v1/folder_index?on_conflict=market,folder_name" `
    -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Profile: comps' `
    -H 'Content-Type: application/json' -H 'Prefer: resolution=merge-duplicates,return=minimal' `
    -A $UA --data-binary "@$tmp"
  $code = ($out -split "`n")[-1]
  if ($code -notmatch '^2') { throw "batch at $i failed: HTTP $code :: $out" }
  Write-Output ("upserted {0}/{1}" -f ([Math]::Min($i + $batch, $rows.Count)), $rows.Count)
}
Remove-Item "$PSScriptRoot\_folder_index_body.json" -ErrorAction SilentlyContinue

# read-back: reported count must equal what this run built (PS 5.1: read the
# Content-Range header via Invoke-WebRequest; -ResponseHeadersVariable is v6+)
$resp = Invoke-WebRequest -Uri "$BASE/rest/v1/folder_index?select=id&limit=1" -Headers ($H + @{ Prefer = 'count=exact' }) -UserAgent $UA -TimeoutSec 60 -UseBasicParsing
$total = ([string]$resp.Headers['Content-Range'] -split '/')[-1]
Write-Output ("read-back total: {0} (built {1})" -f $total, $rows.Count)
if ([int]$total -ne $rows.Count) { throw "read-back mismatch: table has $total, run built $($rows.Count)" }
Write-Output 'DONE.'
