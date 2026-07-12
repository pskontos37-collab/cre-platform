# extract_notice_addresses.ps1 - pulls the TENANT legal-notice address out of each
# lease's "Notices" clause and seeds it into tenant_contacts (migration 20240069,
# contact_type='legal_notice', source='ai_extraction') for the /contacts page.
#
# Grounding: iterates the lease_abstracts (one row per property+tenant, already
# carrying source_doc_ids = the governing lease + amendments). For each, it pulls
# the document_chunks of those docs that mention "notice", feeds them to Claude
# with a forced-JSON tool, and captures where notices TO the tenant must be sent
# (primary recipient + any "with a copy to"), with the lease section cited.
#
# Two modes:
#   (default)  EXTRACT: append one line per abstract to notice_addresses.jsonl.
#              Resumable - abstracts already in the JSONL are skipped.
#   -Load      LOAD: upsert the extracted recipients into tenant_contacts. Re-runnable
#              and SAFE: for each tenant it replaces only its own prior
#              ai_extraction rows that are NOT yet verified - manual rows and
#              staff-verified rows are never touched.
#
# Requires the tenant_contacts table (run migration 20240069 first for -Load).
param([switch]$Load, [int]$Limit = 0)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']; $AK = $cfg['ANTHROPIC_API_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$OUT = "$PSScriptRoot\notice_addresses.jsonl"
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Nz($v) { if ($v -is [string] -and $v.Trim() -ne '') { return $v.Trim() } return $null }

# ---------------- EXTRACT mode ----------------
if (-not $Load) {
  $abs = Invoke-RestMethod -Uri "$BASE/rest/v1/lease_abstracts?select=id,property_id,tenant_name,source_doc_ids&status=eq.complete&order=tenant_name" -Headers $H -UserAgent $UA -TimeoutSec 120
  Write-Output ("abstracts: {0}" -f $abs.Count)

  $props = Invoke-RestMethod -Uri "$BASE/rest/v1/properties?select=id,name&limit=200" -Headers $H -UserAgent $UA -TimeoutSec 60
  $pname = @{}; foreach ($p in $props) { $pname[$p.id] = $p.name }

  $done = @{}
  if (Test-Path -LiteralPath $OUT) {
    foreach ($line in [IO.File]::ReadAllLines($OUT, $utf8)) {
      if ($line) { $done[(($line | ConvertFrom-Json).abstract_id)] = $true }
    }
  }
  $todo = @($abs | Where-Object { -not $done.ContainsKey($_.id) })
  if ($Limit -gt 0) { $todo = @($todo | Select-Object -First $Limit) }
  Write-Output ("already extracted: {0}   to do: {1}" -f $done.Count, $todo.Count)

  $tool = @{
    name = 'submit_notice'
    description = 'Submit the notice address(es) for notices sent TO the tenant under this lease.'
    input_schema = @{
      type = 'object'
      properties = @{
        found = @{ type = 'boolean'; description = 'true ONLY if a Notices clause specifying where notices to the tenant go is actually present in the provided text' }
        section = @{ type = @('string', 'null'); description = 'lease/amendment section cited, e.g. "Sec. 27" or "Art. 24; 2nd Amd Sec. 3"' }
        recipients = @{
          type = 'array'
          description = 'each place a notice to the tenant must be sent, in the order the lease lists them'
          items = @{
            type = 'object'
            properties = @{
              copy_to = @{ type = 'boolean'; description = 'true if this is a "with a copy to" secondary recipient (e.g. tenant counsel)' }
              company = @{ type = @('string', 'null'); description = 'entity/name to address (often the tenant legal name or a parent/counsel firm)' }
              attn = @{ type = @('string', 'null'); description = 'the Attn: line, e.g. "General Counsel" or "Real Estate Dept"' }
              address_line1 = @{ type = @('string', 'null') }
              address_line2 = @{ type = @('string', 'null') }
              city = @{ type = @('string', 'null') }
              state = @{ type = @('string', 'null'); description = 'two-letter state code' }
              zip = @{ type = @('string', 'null') }
              email = @{ type = @('string', 'null'); description = 'ONLY if the lease permits notice by email to this address' }
            }
            required = @('copy_to')
          }
        }
      }
      required = @('found')
    }
  }

  $n = 0; $ok = 0; $none = 0; $fail = 0
  foreach ($ab in $todo) {
    $n++
    $prop = $pname[$ab.property_id]; if (-not $prop) { $prop = 'unknown property' }
    # governing docs -> chunks mentioning "notice"
    $ids = @($ab.source_doc_ids) | Where-Object { $_ }
    $body = ''
    if ($ids.Count -gt 0) {
      $inlist = ($ids -join ',')
      $noticeEsc = [uri]::EscapeDataString('*notice*')
      try {
        # Verbatim text chunks that mention "notice" (the Notices article + noise like
        # "option notice period"). We then score toward the ADDRESS block so the real
        # clause survives the length cap rather than being crowded out.
        $rows = Invoke-RestMethod -Uri "$BASE/rest/v1/document_chunks?select=document_id,chunk_index,content&document_id=in.($inlist)&kind=eq.text&content=ilike.$noticeEsc&order=document_id,chunk_index&limit=120" -Headers $H -UserAgent $UA -TimeoutSec 120
        # Fall back to any-kind chunks if there is no text layer for these docs.
        if (-not $rows -or @($rows).Count -eq 0) {
          $rows = Invoke-RestMethod -Uri "$BASE/rest/v1/document_chunks?select=document_id,chunk_index,content&document_id=in.($inlist)&content=ilike.$noticeEsc&order=document_id,chunk_index&limit=40" -Headers $H -UserAgent $UA -TimeoutSec 120
        }
        $strong = @('addressed to','if to tenant','if to landlord','copy to','certified mail','registered mail','postage prepaid','return receipt','overnight courier','shall be in writing','deemed to have been given','deemed given','delivered personally','attn','attention:')
        $scored = @()
        $ord = 0
        foreach ($r in @($rows)) {
          $lc = ("" + $r.content).ToLower()
          $sc = 0
          foreach ($m in $strong) { if ($lc.Contains($m)) { $sc += 10 } }
          $scored += [pscustomobject]@{ ord = $ord; score = $sc; content = $r.content }
          $ord++
        }
        # keep the 12 best-scoring chunks, then restore reading order for coherence
        $keep = @($scored | Sort-Object -Property @{Expression='score';Descending=$true}, @{Expression='ord';Descending=$false} | Select-Object -First 12)
        foreach ($k in ($keep | Sort-Object ord)) { $body += "`n" + $k.content }
      } catch { }
    }
    if (-not $body.Trim()) {
      # no notice-bearing text on hand (likely scanned / no text layer) - record as not found
      $rec = [ordered]@{ abstract_id = $ab.id; property_id = $ab.property_id; tenant_name = $ab.tenant_name; source_doc_ids = $ids; extraction = @{ found = $false; note = 'no notice text in corpus' } }
      [IO.File]::AppendAllText($OUT, (($rec | ConvertTo-Json -Depth 10 -Compress) + "`n"), $utf8)
      $none++
      continue
    }
    if ($body.Length -gt 13000) { $body = $body.Substring(0, 13000) }

    $prompt = @"
You are extracting the LEGAL NOTICE ADDRESS for a commercial retail lease so the landlord's team can send
default notices and estoppel requests to the right place without re-reading the lease.

PROPERTY: $prop
TENANT: $($ab.tenant_name)

Below are excerpts from the lease and its amendments that mention "notice". Find the clause that states where
notices sent TO THE TENANT must be delivered. Capture EACH recipient the lease lists (the primary tenant
address plus any "with a copy to" recipient such as the tenant's counsel or corporate real-estate department).
Set copy_to=true for the secondary "copy to" recipients. Use the two-letter state code. A later amendment that
changes the notice address SUPERSEDES the original - use the most recent address. Extract ONLY what is written;
never invent an address. If the excerpts do not actually contain a tenant-notice clause, set found=false.

Do NOT return the LANDLORD's notice address. Call submit_notice with your result.

LEASE NOTICE EXCERPTS:
$body
"@
    $req = @{
      model = 'claude-sonnet-5'
      max_tokens = 900
      tools = @($tool)
      tool_choice = @{ type = 'tool'; name = 'submit_notice' }
      messages = @(@{ role = 'user'; content = $prompt })
    } | ConvertTo-Json -Depth 14
    $x = $null
    for ($try = 1; $try -le 3; $try++) {
      try {
        $r = Invoke-RestMethod -Method Post -Uri 'https://api.anthropic.com/v1/messages' -Headers @{ 'x-api-key' = $AK; 'anthropic-version' = '2023-06-01' } -ContentType 'application/json' -Body ($utf8.GetBytes($req)) -TimeoutSec 180
        $tu = $r.content | Where-Object { $_.type -eq 'tool_use' } | Select-Object -First 1
        $x = $tu.input
        break
      } catch {
        $e = if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
        if ($try -lt 3 -and ($e -match '429|529|overloaded')) { Start-Sleep -Seconds (15 * $try); continue }
        Write-Output ("FAIL {0} :: {1}" -f $ab.tenant_name, $e.Substring(0, [Math]::Min(160, $e.Length)))
        $fail++
        break
      }
    }
    if ($null -eq $x) { continue }
    $rec = [ordered]@{ abstract_id = $ab.id; property_id = $ab.property_id; tenant_name = $ab.tenant_name; source_doc_ids = $ids; extraction = $x }
    [IO.File]::AppendAllText($OUT, (($rec | ConvertTo-Json -Depth 12 -Compress) + "`n"), $utf8)
    if ($x.found -and $x.recipients) { $ok++ } else { $none++ }
    if ($n % 10 -eq 0) { Write-Output ("{0}/{1}  with-address {2}  none {3}  failed {4}" -f $n, $todo.Count, $ok, $none, $fail) }
  }
  Write-Output ("DONE extract  {0}/{1}  with-address {2}  none {3}  failed {4}" -f $n, $todo.Count, $ok, $none, $fail)
  exit 0
}

# ---------------- LOAD mode ----------------
if (-not (Test-Path -LiteralPath $OUT)) { throw "no extract file at $OUT - run extract mode first" }

# Map (property_id, lowercased tenant name) -> {tenant_id, lease_id} so extracted
# rows link back to the structured records where the names line up.
$link = @{}
$leases = Invoke-RestMethod -Uri "$BASE/rest/v1/leases?select=id,property_id,tenant_id,tenants(name,trade_name)&limit=2000" -Headers $H -UserAgent $UA -TimeoutSec 120
foreach ($l in $leases) {
  foreach ($nm in @($l.tenants.trade_name, $l.tenants.name)) {
    if ($nm) { $link["$($l.property_id)::$($nm.ToLower())"] = @{ tenant_id = $l.tenant_id; lease_id = $l.id } }
  }
}

$ins = 0; $tenants = 0; $skipped = 0
foreach ($line in [IO.File]::ReadAllLines($OUT, $utf8)) {
  if (-not $line) { continue }
  $rec = $line | ConvertFrom-Json
  $x = $rec.extraction
  if (-not $x.found -or -not $x.recipients) { $skipped++; continue }
  $recips = @($x.recipients) | Where-Object { $_.company -or $_.address_line1 -or $_.city -or $_.email }
  if ($recips.Count -eq 0) { $skipped++; continue }
  $tenants++

  $propId = $rec.property_id
  $tname = $rec.tenant_name
  $lk = $link["$propId::$($tname.ToLower())"]
  $sec = Nz $x.section
  $docs = @($rec.source_doc_ids) | Where-Object { $_ }

  # SAFE re-run: delete only THIS tenant's unverified ai_extraction notice rows.
  $tEsc = [uri]::EscapeDataString($tname)
  $delH = $H + @{ Prefer = 'return=minimal' }
  Invoke-RestMethod -Method Delete -Uri "$BASE/rest/v1/tenant_contacts?property_id=eq.$propId&tenant_name=eq.$tEsc&contact_type=eq.legal_notice&source=eq.ai_extraction&verified=eq.false" -Headers $delH -UserAgent $UA -TimeoutSec 120 | Out-Null

  $payload = @()
  foreach ($rp in $recips) {
    $payload += [ordered]@{
      property_id    = $propId
      tenant_id      = if ($lk) { $lk.tenant_id } else { $null }
      lease_id       = if ($lk) { $lk.lease_id } else { $null }
      tenant_name    = $tname
      contact_type   = 'legal_notice'
      company        = Nz $rp.company
      attn           = Nz $rp.attn
      email          = Nz $rp.email
      address_line1  = Nz $rp.address_line1
      address_line2  = Nz $rp.address_line2
      city           = Nz $rp.city
      state          = Nz $rp.state
      zip            = Nz $rp.zip
      copy_to        = [bool]$rp.copy_to
      is_primary     = (-not [bool]$rp.copy_to)
      source         = 'ai_extraction'
      source_section = $sec
      source_doc_ids = $docs
      verified       = $false
    }
  }
  # return=representation: return=minimal can silently fail to persist (loader gotcha).
  $insH = $H + @{ 'Content-Type' = 'application/json'; Prefer = 'return=representation' }
  $b = ($payload | ConvertTo-Json -Depth 10)
  if ($payload.Count -eq 1) { $b = "[$b]" }   # keep a single row as a JSON array
  Invoke-RestMethod -Method Post -Uri "$BASE/rest/v1/tenant_contacts" -Headers $insH -UserAgent $UA -Body ($utf8.GetBytes($b)) -TimeoutSec 120 | Out-Null
  $ins += $payload.Count
}
Write-Output ("DONE load  tenants-with-notice {0}  rows-inserted {1}  skipped-none {2}" -f $tenants, $ins, $skipped)
