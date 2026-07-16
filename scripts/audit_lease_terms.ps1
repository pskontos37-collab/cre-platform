# audit_lease_terms.ps1 - FULL-PORTFOLIO lease-term audit. For EVERY active lease,
# gathers every term-bearing document in the corpus (original lease, all amendments,
# exercise/extension notices, memoranda, estoppels - REGARDLESS of document age; the
# Jersey Mike's miss proved a 2021 amendment governs a 2026 expiration), has Claude
# determine the GOVERNING expiration with the source cited, and diffs it against the
# structured data (leases.expiration_date + lease_options).
#
# REPORT ONLY - this script never writes to the database. Output is a human-review
# JSONL + console discrepancy table. Apply fixes only after review, per the standing
# process (spec: docs/COTENANCY-RISK-RADAR-SPEC.md).
#
# Modes:
#   (default)   audit all active leases -> lease_term_audit.jsonl (resumable)
#   -Limit <n>  cap leases processed this run
param([int]$Limit = 0)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']; $AK = $cfg['ANTHROPIC_API_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$OUT = "$PSScriptRoot\lease_term_audit.jsonl"
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Nz($v) { if ($v -is [string] -and $v.Trim() -ne '') { return $v.Trim() } return $null }

# ---- leases + tenants + options ----
$leases = Invoke-RestMethod -Uri "$BASE/rest/v1/leases?select=id,property_id,tenant_id,commencement_date,expiration_date,leased_sf,tenants(name,trade_name,file_aliases),lease_options(option_type,notice_deadline,term_if_exercised_months,is_exercised,notes)&status=eq.active&order=property_id&limit=500" -Headers $H -UserAgent $UA -TimeoutSec 120
Write-Output ("active leases: {0}" -f @($leases).Count)

$props = Invoke-RestMethod -Uri "$BASE/rest/v1/properties?select=id,name&limit=200" -Headers $H -UserAgent $UA -TimeoutSec 60
$pname = @{}; foreach ($p in $props) { $pname[$p.id] = $p.name }

# ---- documents, pulled once per property, term-bearing candidates only ----
$docsByProp = @{}
foreach ($propId in (@($leases) | Select-Object -ExpandProperty property_id -Unique)) {
  $all = @(); $off = 0
  while ($true) {
    $page = Invoke-RestMethod -Uri "$BASE/rest/v1/documents?select=id,file_name,file_path,title,file_mtime,tenant_id&property_id=eq.$propId&order=id&limit=1000&offset=$off" -Headers $H -UserAgent $UA -TimeoutSec 120
    $all += @($page); if (@($page).Count -lt 1000) { break }; $off += 1000
  }
  # term-bearing candidates
  $docsByProp[$propId] = @($all | Where-Object {
    $_.file_name -match '(?i)LSE|lease|AMD|amend|Ext|Renew|Exercise|MEMO|Non-Renewal|Termin|EST|estoppel|assignment|ASSN'
  })
  Write-Output ("{0}: {1} docs, {2} term-bearing" -f $pname[$propId], @($all).Count, @($docsByProp[$propId]).Count)
}

$done = @{}
if (Test-Path -LiteralPath $OUT) {
  foreach ($line in [IO.File]::ReadAllLines($OUT, $utf8)) {
    if ($line) { $done[(($line | ConvertFrom-Json).lease_id)] = $true }
  }
}
$todo = @($leases | Where-Object { -not $done.ContainsKey($_.id) })
if ($Limit -gt 0) { $todo = @($todo | Select-Object -First $Limit) }
Write-Output ("already audited: {0}   to do: {1}" -f $done.Count, $todo.Count)

$tool = @{
  name = 'submit_audit'
  description = 'Submit the governing lease term determined from the documents.'
  input_schema = @{
    type = 'object'
    properties = @{
      governing_expiration = @{ type = @('string', 'null'); description = 'YYYY-MM-DD current lease expiration per the LATEST executed term-bearing document. null only if truly undeterminable.' }
      source = @{ type = @('string', 'null'); description = 'file name of the document that establishes the governing expiration' }
      confidence = @{ type = 'string'; enum = @('high', 'medium', 'low'); description = 'high only when an executed amendment/notice/lease states the date or an unambiguous term length from a known date' }
      db_matches = @{ type = 'boolean'; description = 'true if the database expiration equals the governing expiration' }
      options_remaining = @{ type = @('integer', 'null'); description = 'renewal options still unexercised per the latest documents' }
      next_option_notice = @{ type = @('string', 'null'); description = 'YYYY-MM-DD next renewal-option notice deadline, if determinable' }
      option_data_matches = @{ type = @('boolean', 'null'); description = 'whether the DB option state agrees with the documents; null if cannot tell' }
      tenant_leaving = @{ type = 'boolean'; description = 'true if the documents show a non-renewal, termination, or closure notice for the CURRENT term' }
      note = @{ type = @('string', 'null'); description = 'one-sentence explanation, citing document dates' }
      needs_document_read = @{ type = 'boolean'; description = 'true if the summaries are insufficient and a human/deeper pass should read the actual PDFs' }
    }
    required = @('confidence', 'db_matches', 'tenant_leaving', 'needs_document_read')
  }
}

$n = 0; $disc = 0; $fail = 0
foreach ($ls in $todo) {
  $n++
  $t = $ls.tenants
  $prop = $pname[$ls.property_id]

  # match this tenant's documents: direct tenant_id link, or TENANTS folder token match
  $names = @(); if (Nz $t.name) { $names += $t.name }; if (Nz $t.trade_name) { $names += $t.trade_name }
  foreach ($a in @($t.file_aliases)) { if (Nz $a) { $names += $a } }
  $tokens = @()
  foreach ($nm in $names) {
    $tk = ((($nm -split ',')[0]) -replace "[^A-Za-z0-9' ]", ' ') -replace '\s+', ' '
    $tk = $tk.Trim()
    if ($tk.Length -ge 4) { $tokens += $tk }
    $first = ($tk -split ' ')[0]
    if ($first.Length -ge 5) { $tokens += $first }
  }
  $tokens = @($tokens | Select-Object -Unique)
  $docs = @($docsByProp[$ls.property_id] | Where-Object {
    $d = $_
    if ($d.tenant_id -eq $ls.tenant_id) { $true }
    else {
      $folder = $null
      if ($d.file_path -match 'TENANTS\\([^\\]+)\\') { $folder = $Matches[1] }
      if ($folder) {
        $hit = $false
        foreach ($tk in $tokens) { if ($folder -like ('*' + $tk + '*')) { $hit = $true; break } }
        $hit
      } else { $false }
    }
  })
  if (@($docs).Count -gt 40) {
    # keep the most informative: sort by mtime desc, cap 40
    $docs = @($docs | Sort-Object { $_.file_mtime } -Descending | Select-Object -First 40)
  }

  $optLines = @()
  foreach ($o in @($ls.lease_options)) {
    $optLines += ("- {0}: notice_deadline={1} exercised={2} term_months={3} notes={4}" -f $o.option_type, $o.notice_deadline, $o.is_exercised, $o.term_if_exercised_months, $o.notes)
  }
  $docLines = @()
  foreach ($d in (@($docs) | Sort-Object { $_.file_mtime })) {
    $ttl = ("" + $d.title); if ($ttl.Length -gt 260) { $ttl = $ttl.Substring(0, 260) }
    $docLines += ("- [{0}] {1}: {2}" -f $d.file_mtime, $d.file_name, $ttl)
  }

  $usr = @"
Property: $prop
Tenant: $($t.name) (trade: $($t.trade_name))
DATABASE says: commencement $($ls.commencement_date), expiration $($ls.expiration_date), $($ls.leased_sf) SF
DATABASE options:
$($optLines -join "`n")

DOCUMENTS on file (chronological; each line = [file date] file name: AI summary):
$($docLines -join "`n")
"@
  $sys = 'You audit commercial lease terms for a landlord. Determine the CURRENT governing expiration from the LATEST executed term-bearing document (amendments and exercise notices override the original lease; an assignment does not change the term unless it says so; estoppels only confirm). Old documents still govern if nothing newer supersedes them. Dates YYYY-MM-DD. Be conservative with confidence.'
  $payload = @{ model = 'claude-fable-5'; max_tokens = 900; system = $sys
                tools = @($tool); tool_choice = @{ type = 'tool'; name = 'submit_audit' }
                messages = @(@{ role = 'user'; content = $usr }) } | ConvertTo-Json -Depth 12
  $tmp = "$env:TEMP\audit_body.json"; [IO.File]::WriteAllText($tmp, $payload, $utf8)
  try {
    $resp = $null
    foreach ($try in 1..3) {
      try {
        $resp = Invoke-RestMethod -Uri 'https://api.anthropic.com/v1/messages' -Method Post -Headers @{ 'x-api-key' = $AK; 'anthropic-version' = '2023-06-01'; 'content-type' = 'application/json' } -InFile $tmp -TimeoutSec 240
        break
      } catch { if ($try -eq 3) { throw } Start-Sleep -Seconds (6 * $try) }
    }
    $v = ($resp.content | Where-Object { $_.type -eq 'tool_use' } | Select-Object -First 1).input
    $isDisc = (-not $v.db_matches) -or $v.tenant_leaving -or ($v.option_data_matches -eq $false)
    $rec = [ordered]@{
      lease_id = $ls.id; tenant = $t.name; property = $prop
      db_expiration = $ls.expiration_date; docs_considered = @($docs).Count
      audit = $v; discrepancy = $isDisc; applied = $false
    }
    [IO.File]::AppendAllText($OUT, (($rec | ConvertTo-Json -Depth 10 -Compress) + "`n"), $utf8)
    if ($isDisc) {
      $disc++
      Write-Output ("DISCREPANCY [{0}] {1} @ {2}: DB {3} vs docs {4} - {5}" -f $v.confidence, $t.name, $prop, $ls.expiration_date, $v.governing_expiration, $v.note)
    }
    if ($n % 10 -eq 0) { Write-Output ("...{0}/{1} ({2} discrepancies so far)" -f $n, $todo.Count, $disc) }
  } catch {
    $fail++
    Write-Output ("[{0}/{1}] {2}: FAILED {3}" -f $n, $todo.Count, $t.name, $_.Exception.Message)
  }
}
Write-Output ("AUDIT COMPLETE. leases={0} discrepancies={1} failures={2} -> {3}" -f $n, $disc, $fail, $OUT)
Write-Output 'Review the JSONL with a human before ANY database writes.'
