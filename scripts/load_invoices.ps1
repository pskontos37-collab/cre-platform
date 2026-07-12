$ErrorActionPreference = "Stop"
$cfg = @{}; foreach ($l in (Get-Content "C:\Users\pskontos\Desktop\Software\cre-platform\.env" | Where-Object { $_ -match "=" })) { $k,$v = $l -split '=',2; $cfg[$k.Trim()]=$v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$inv = [System.Globalization.CultureInfo]::InvariantCulture
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }

function Dt($s)  { if ([string]::IsNullOrWhiteSpace($s)) { return $null }; try { return ([datetime]::Parse($s,$inv)).ToString('yyyy-MM-dd') } catch { return $null } }
function Dtt($s) { if ([string]::IsNullOrWhiteSpace($s)) { return $null }; try { return ([datetime]::Parse($s,$inv)).ToString('yyyy-MM-ddTHH:mm:ss') } catch { return $null } }
function Num($s) { if ([string]::IsNullOrWhiteSpace($s)) { return $null }; try { return [decimal]::Parse(($s -replace '[\$,]',''),$inv) } catch { return $null } }
function IntOrNull($s) { if ([string]::IsNullOrWhiteSpace($s)) { return $null }; try { return [int]$s } catch { return $null } }
$enc = New-Object System.Text.UTF8Encoding($false)
$TMP = "C:\Users\pskontos\AppData\Local\Temp\claude\C--Users-pskontos-Desktop-Software\4813eb50-3027-4b15-81ea-2a63a5f0357b\scratchpad\_post.json"
function Post($table, $rows, $prefer) {
  if ($rows.Count -eq 0) { return @() }
  $out = @()
  for ($i=0; $i -lt $rows.Count; $i += 500) {
    $chunk = @($rows[$i..([Math]::Min($i+499,$rows.Count-1))])
    $json = $chunk | ConvertTo-Json -Depth 6
    if ($chunk.Count -eq 1) { $json = "[$json]" }
    [System.IO.File]::WriteAllText($TMP, $json, $enc)
    $resp = & curl.exe -s -X POST "$BASE/rest/v1/$table" `
              -H "apikey: $KEY" -H "Authorization: Bearer $KEY" `
              -H "Content-Type: application/json" -H "Prefer: $prefer" `
              --data-binary "@$TMP"
    if ($resp -match '"message"\s*:' -and $resp -match '"code"') { throw "POST $table failed: $resp" }
    if ($prefer -match 'representation' -and $resp) {
      $parsed = $resp | ConvertFrom-Json
      if ($parsed) { $out += $parsed }
    }
  }
  return $out
}

# entity -> property uuid (full owned map; only the entities in $files are loaded/deleted this run)
$PROP = @{
  '0532' = '00000000-0000-0000-0000-000000000010'   # KM East
  '0531' = '00000000-0000-0000-0000-000000000011'   # KM West
  '0800' = 'd4f08824-2d88-472d-b7aa-a703310c2aaf'    # Magnolia Park
  '0840' = 'd5a4ed03-0b60-4168-9208-83822dd24884'    # Gateway Port Chester
}
$files = @(
  @{ path = "C:\Users\pskontos\Downloads\Magnolia Invoice List 2.csv"; entity = '0800' },
  @{ path = "C:\Users\pskontos\Downloads\Gateway Invoices.csv"; entity = '0840' }
)

# ---- Pass 1: collect rows, build vendor set ----
$allRows = @()
$vendors = @{}   # normalized -> @{name; avid}
foreach ($f in $files) {
  $d = Import-Csv $f.path
  foreach ($row in $d) { $row | Add-Member -NotePropertyName _entity -NotePropertyValue $f.entity -Force }
  $allRows += $d
  foreach ($row in $d) {
    $vn = $row.'Vendor Name'
    if (-not [string]::IsNullOrWhiteSpace($vn)) {
      $norm = $vn.Trim().ToLower()
      if (-not $vendors.ContainsKey($norm)) { $vendors[$norm] = @{ name = $vn.Trim(); avid = $row.'Vendor ID' } }
    }
  }
}
Write-Output ("rows=" + $allRows.Count + " unique_vendors=" + $vendors.Count)

# ---- Insert vendors (upsert on normalized_name) ----
$vrows = foreach ($k in $vendors.Keys) { @{ name = $vendors[$k].name; normalized_name = $k; avid_vendor_id = $vendors[$k].avid } }
$vres = Post 'vendors?on_conflict=normalized_name' @($vrows) 'resolution=merge-duplicates,return=representation'
$vmap = @{}; foreach ($v in $vres) { $vmap[$v.normalized_name] = $v.id }
Write-Output ("vendors upserted=" + $vmap.Count)

# ---- Build invoice headers (one per Invoice ID) + distributions ----
$seen = @{}
$invRows = @()
$distByInvoice = @{}   # avid_invoice_id -> list of distribution hashtables (without invoice_id yet)
foreach ($row in $allRows) {
  $aid = $row.'Invoice ID'
  if ([string]::IsNullOrWhiteSpace($aid)) { continue }
  # extract code dimensions
  $codes = @(); $glAcct = $null; $glDesc = $null; $propCode = $null
  for ($i=1; $i -le 15; $i++) {
    $g = $row."Code $i Group Name"; $val = $row."Code $i Value"; $desc = $row."Code $i Description"
    if (-not [string]::IsNullOrWhiteSpace($g) -or -not [string]::IsNullOrWhiteSpace($val)) {
      $codes += @{ group = $g; value = $val; desc = $desc }
      if ($g -match 'Account') { if (-not $glAcct) { $glAcct = $val; $glDesc = $desc } }
      if ($g -match 'Property') { if (-not $propCode) { $propCode = $val } }
    }
  }
  $entity = if ($propCode) { $propCode } else { $row._entity }
  $propId = $PROP[$entity]; if (-not $propId) { $propId = $PROP[$row._entity] }

  # distribution (one per row) — skip blank/summary lines with no amount (amount is NOT NULL in DB)
  $amt = (Num $row.'Distribution Amount')
  if ($null -ne $amt) {
    if (-not $distByInvoice.ContainsKey($aid)) { $distByInvoice[$aid] = @() }
    $distByInvoice[$aid] += @{
      property_id = $propId
      distribution_number = (IntOrNull $row.'Distribution Number')
      distribution_desc = $row.'Distribution Description'
      amount = $amt
      gl_account_code = $glAcct
      gl_account_desc = $glDesc
      property_code = $propCode
      codes = $codes
    }
  }

  # invoice header (first occurrence wins)
  if (-not $seen.ContainsKey($aid)) {
    $seen[$aid] = $true
    $vid = $null; $vn = $row.'Vendor Name'; if (-not [string]::IsNullOrWhiteSpace($vn)) { $vid = $vmap[$vn.Trim().ToLower()] }
    $invRows += @{
      property_id = $propId
      vendor_id = $vid
      avid_invoice_id = $aid
      invoice_number = $row.'Invoice Number'
      invoice_type = $row.'Invoice Type'
      invoice_state = $row.'Invoice State'
      batch_name = $row.'Batch Name'
      entity_code = $entity
      posting_date = (Dt $row.'Posting Date')
      invoice_date = (Dt $row.'Invoice Date')
      due_date = (Dt $row.'Invoice Due Date')
      payment_terms = $row.'Payment Terms'
      entered_date = (Dtt $row.'Entered Date')
      entered_by = $row.'Entered By'
      approval_date = (Dtt $row.'Approval Date')
      approved_by = $row.'Approved By'
      workflow = $row.'Workflow'
      workflow_step = $row.'WorkFlow Step'
      memo = $row.'Memo'
      po_number = $row.'PO Number'
      work_order_number = $row.'Work Order Number'
      service_start_date = (Dt $row.'Service Start Date')
      service_end_date = (Dt $row.'Service End Date')
      previous_balance = (Num $row.'Previous Balance')
      invoice_subtotal = (Num $row.'Invoice Subtotal')
      shipping_cost = (Num $row.'Shipping Cost')
      tax = (Num $row.'Tax')
      misc_cost = (Num $row.'Misc Cost')
      discount = (Num $row.'Discount')
      invoice_total = (Num $row.'Invoice Total')
      invoice_url = $row.'Invoice URL'
      image_url = $row.'Image URL'
      accounting_system = $row.'Accounting System'
    }
  }
}
Write-Output ("invoice headers=" + $invRows.Count + " invoices_with_dists=" + $distByInvoice.Count)

# ---- Insert invoices (upsert on avid_invoice_id), get ids ----
$ires = Post 'invoices?on_conflict=avid_invoice_id' @($invRows) 'resolution=merge-duplicates,return=representation'
$imap = @{}; foreach ($iv in $ires) { $imap[$iv.avid_invoice_id] = $iv.id }
Write-Output ("invoices upserted=" + $imap.Count)

# ---- Build + insert distributions with invoice_id ----
$distRows = @()
foreach ($aid in $distByInvoice.Keys) {
  $iid = $imap[$aid]; if (-not $iid) { continue }
  foreach ($dd in $distByInvoice[$aid]) { $dd['invoice_id'] = $iid; $distRows += $dd }
}
Write-Output ("distribution rows to insert=" + $distRows.Count)
# distributions have no natural unique key; delete existing only for the properties loaded THIS run
# (scoped so re-running for Magnolia/Gateway never wipes KM's distributions), then re-insert.
$loadedProps = @($files | ForEach-Object { $PROP[$_.entity] } | Where-Object { $_ } | Sort-Object -Unique)
foreach ($p in $loadedProps) {
  & curl.exe -s -X DELETE "$BASE/rest/v1/invoice_distributions?property_id=eq.$p" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" | Out-Null
}
$null = Post 'invoice_distributions' @($distRows) 'return=minimal'
Write-Output "DONE invoices+distributions"