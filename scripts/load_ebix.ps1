# load_ebix.ps1 - seed the COI tracker from an Ebix "MJ Wilkow Report" xlsx.
# Reads the "Any Deficiencies" tab (the actionable non-compliant master list),
# maps each Ebix property to a platform property (platform-modeled properties
# only - the rest stay on Ebix per the v1 scope decision), classifies each
# insured party as tenant (matched to a lease roster) or vendor, derives a
# lifecycle status + deficiency list from the Ebix MajorDef text, and upserts
# into public.coi_certificates with source='ebix_import'.
#
# Re-runnable: deletes prior source='ebix_import' rows first, so pointing it at
# a fresh export at cutover fully refreshes the seed.
#   .\load_ebix.ps1 -Path "C:\Users\pskontos\Desktop\MJ Wilkow Report 09.08.2025.xlsx"
param(
  [Parameter(Mandatory=$true)][string]$Path,
  [string]$Sheet = 'Any Deficiencies'
)
$ErrorActionPreference = 'Stop'

$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) {
  $k,$v = $l -split '=',2; $cfg[$k.Trim()] = $v.Trim()
}
$base = $cfg['VITE_SUPABASE_URL']
$jwt  = $cfg['SUPABASE_SERVICE_JWT']
if (-not $base -or -not $jwt) { throw "missing VITE_SUPABASE_URL / SUPABASE_SERVICE_JWT in .env" }
$H = @{ apikey = $jwt; Authorization = "Bearer $jwt"; 'Content-Type' = 'application/json' }

# --- Ebix property name (substring, case-insensitive) -> platform property id.
# Sub-entities/phases collapse to the single platform property (East Gate I-VI,
# Meridian II/III, the four Waterfront sub-centers). Penn Center -> Office and
# all Southlands -> Retail are v1 calls where Ebix does not disambiguate.
$PROP = @(
  @{ m = 'chapel hills east'; id = '7fc45bb1-1917-4619-9415-8ca666e4653f' },
  @{ m = 'cherry creek';      id = '4dd56eb8-d2f6-48f5-a09e-00585c329b5d' },
  @{ m = 'east gate';         id = '3c66605b-f947-45a8-aa27-4d95ae3c554d' },
  @{ m = 'port chester';      id = 'd5a4ed03-0b60-4168-9208-83822dd24884' },
  @{ m = 'midway plantation'; id = '00000000-0000-0000-0000-000000000010' },
  @{ m = 'midtown commons';   id = '00000000-0000-0000-0000-000000000011' },
  @{ m = 'magnolia park';     id = 'd4f08824-2d88-472d-b7aa-a703310c2aaf' },
  @{ m = 'meridian plaza';    id = 'e7d9a97e-668c-4a50-a966-92ce919f1f95' },
  @{ m = 'miracle mile';      id = '9d25ff35-ab62-4b6a-9e76-c0306a95b142' },
  @{ m = 'one east erie';     id = '87c85b3a-2704-4114-b7b0-ce65a2e971e0' },
  @{ m = 'parker ranch';      id = '8c73d962-5271-4202-bb05-0ec7dc9b358d' },
  @{ m = 'penn center';       id = '7edf27f6-f268-4376-93e1-4db67e053480' },
  @{ m = 'southland';         id = 'ac1c355f-ae29-4981-9f65-3aa33739613d' },
  @{ m = 'mililani';          id = '63036a6e-406a-4016-a8f8-cf9d73e073ea' },
  @{ m = 'waterfront';        id = 'cb1fd6c0-159f-42ed-b677-85b776c0d98b' }
)
# Focus scope: only the fully-built-out JV assets - Gateway (Port Chester),
# Knightdale (KM East + West), Magnolia (Magnolia Park). Other platform
# properties stay on Ebix for now. Set $FOCUS = @() to include all mapped props.
$FOCUS = @(
  'd5a4ed03-0b60-4168-9208-83822dd24884',   # Gateway Port Chester
  '00000000-0000-0000-0000-000000000010',   # KM East
  '00000000-0000-0000-0000-000000000011',   # KM West
  'd4f08824-2d88-472d-b7aa-a703310c2aaf'     # Magnolia Park
)
function Map-Property($name) {
  $n = ("" + $name).ToLower()
  foreach ($p in $PROP) {
    if ($n.Contains($p.m)) {
      if ($FOCUS.Count -and ($FOCUS -notcontains $p.id)) { return $null }
      return $p.id
    }
  }
  return $null
}
function Norm($s) { return (("" + $s).ToLower() -replace '[^a-z0-9]','') }

# --- Build a tenant roster (normalized name -> tenant_id) per mapped property,
#     for tenant/vendor classification.
$mappedIds = $PROP.id | Sort-Object -Unique
$roster = @{}   # propId -> hashtable(normName -> tenantId)
foreach ($propId in $mappedIds) {
  $roster[$propId] = @{}
  $url = "$base/rest/v1/leases?property_id=eq.$propId&select=tenant_id,tenants(id,name,trade_name)"
  try {
    $rows = Invoke-RestMethod -Method Get -Uri $url -Headers $H
    foreach ($r in $rows) {
      $t = $r.tenants
      if (-not $t) { continue }
      foreach ($nm in @($t.name, $t.trade_name)) {
        $k = Norm $nm
        if ($k.Length -ge 4 -and -not $roster[$propId].ContainsKey($k)) { $roster[$propId][$k] = $t.id }
      }
    }
  } catch { Write-Output "  (roster fetch failed for ${propId}: $_)" }
}
function Classify($propId, $insured) {
  $n = Norm $insured
  if ($n.Length -lt 4) { return @{ type = 'vendor'; tid = $null } }
  $r = $roster[$propId]
  if ($r.ContainsKey($n)) { return @{ type = 'tenant'; tid = $r[$n] } }
  foreach ($k in $r.Keys) {
    if ($k.Length -ge 5 -and ($n.Contains($k) -or $k.Contains($n))) {
      return @{ type = 'tenant'; tid = $r[$k] }
    }
  }
  return @{ type = 'vendor'; tid = $null }
}

function Status-From($def) {
  $d = ("" + $def).Trim()
  if ($d -match '(?i)^COMPLIANT') { return 'compliant' }
  if ($d -match '(?i)We Do Not Have Current Insurance') { return 'missing' }
  if ($d -match '(?i)Expired Coverage') { return 'expired' }
  return 'deficient'
}
function Deficiencies-From($def) {
  $d = ("" + $def) -replace '&amp;','&'
  if ($d.Trim() -match '(?i)^COMPLIANT') { return @() }
  return @($d -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' } |
           ForEach-Object { @{ label = $_ } })
}

# --- Read the sheet.
Write-Output "Opening $Path ..."
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false; $excel.DisplayAlerts = $false
$wb = $excel.Workbooks.Open($Path, $false, $true)
$ws = $wb.Worksheets.Item($Sheet)
$last = $ws.Cells($ws.Rows.Count, 2).End(-4162).Row   # xlUp on col B (Insured)
Write-Output "Sheet '$Sheet': $($last-1) data rows"

$seen = @{}   # dedup key -> $true
$recs = @()
$unmapped = @{}
for ($r = 2; $r -le $last; $r++) {
  $vendorNum = $ws.Cells.Item($r,1).Text.Trim()
  $insured   = $ws.Cells.Item($r,2).Text.Trim()
  if (-not $insured) { continue }
  $propName  = $ws.Cells.Item($r,15).Text.Trim()
  $propId = Map-Property $propName
  if (-not $propId) { $unmapped[$propName] = 1; continue }

  $key = if ($vendorNum) { "$propId|$vendorNum" } else { "$propId|" + (Norm $insured) }
  if ($seen.ContainsKey($key)) { continue }
  $seen[$key] = $true

  $addr = @($ws.Cells.Item($r,3).Text.Trim(),
            ($ws.Cells.Item($r,4).Text.Trim() + ' ' + $ws.Cells.Item($r,5).Text.Trim() + ' ' + $ws.Cells.Item($r,6).Text.Trim()).Trim()
          ) | Where-Object { $_ -ne '' }
  $def = $ws.Cells.Item($r,14).Text
  $cls = Classify $propId $insured

  $recs += [ordered]@{
    property_id     = $propId
    party_type      = $cls.type
    party_name      = $insured
    tenant_id       = $cls.tid
    ebix_vendor_num = if ($vendorNum) { $vendorNum } else { $null }
    insured_name    = $insured
    insured_address = ($addr -join ', ')
    insured_contact = $ws.Cells.Item($r,7).Text.Trim()
    insured_email   = $ws.Cells.Item($r,9).Text.Trim()
    insured_phone   = $ws.Cells.Item($r,8).Text.Trim()
    producer_name   = $ws.Cells.Item($r,16).Text.Trim()
    producer_phone  = $ws.Cells.Item($r,19).Text.Trim()
    status          = Status-From $def
    deficiencies    = @(Deficiencies-From $def)
    source          = 'ebix_import'
    notes           = "Seeded from Ebix export ($([IO.Path]::GetFileName($Path))); Ebix status $($ws.Cells.Item($r,12).Text.Trim()) as of $($ws.Cells.Item($r,11).Text.Trim())"
  }
}
$wb.Close($false); $excel.Quit()
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null

Write-Output "Prepared $($recs.Count) certificate records across mapped properties."
if ($unmapped.Count) { Write-Output ("Skipped unmapped properties: " + (($unmapped.Keys | Sort-Object) -join '; ')) }

# --- Replace prior seed, then bulk insert.
Write-Output "Deleting prior ebix_import rows ..."
$delH = $H.Clone(); $delH['Prefer'] = 'return=minimal'
Invoke-RestMethod -Method Delete -Uri "$base/rest/v1/coi_certificates?source=eq.ebix_import" -Headers $delH | Out-Null

$insH = $H.Clone(); $insH['Prefer'] = 'return=minimal'
$batch = 150; $done = 0
for ($i = 0; $i -lt $recs.Count; $i += $batch) {
  $chunk = $recs[$i..([Math]::Min($i+$batch-1, $recs.Count-1))]
  $body = ConvertTo-Json -InputObject @($chunk) -Depth 6
  Invoke-RestMethod -Method Post -Uri "$base/rest/v1/coi_certificates" -Headers $insH -Body $body | Out-Null
  $done += $chunk.Count
  Write-Output "  inserted $done / $($recs.Count)"
}
Write-Output "Done. Seeded $done COI certificate records."
