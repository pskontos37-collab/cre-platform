# extract_rm_matrix.ps1 - pulls the repair & maintenance responsibility allocation
# out of each lease and seeds lease_rm_matrix (migration 20240084) so the
# /workorders panel can show "per the lease, X is landlord/tenant responsibility"
# with the verbatim quote + section cite.
#
# Grounding: iterates lease_abstracts (one row per property+tenant, carrying
# source_doc_ids = the governing lease + amendments). For each, pulls the
# verbatim text chunks of those docs that mention repair/maintenance language,
# scores them toward the actual R&M articles, and has Claude allocate each
# building system to landlord/tenant/shared with quotes. Amendments supersede.
#
# Two modes (same pattern as extract_notice_addresses.ps1):
#   (default)  EXTRACT: append one line per abstract to rm_matrix.jsonl. Resumable.
#   -Load      LOAD: upsert into lease_rm_matrix. Re-runnable and SAFE: replaces
#              only that tenant's prior UNVERIFIED ai_extraction rows; manual and
#              staff-verified rows are never touched. Requires migration 20240084.
param([switch]$Load, [int]$Limit = 0)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']; $AK = $cfg['ANTHROPIC_API_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$OUT = "$PSScriptRoot\rm_matrix.jsonl"
$utf8 = New-Object System.Text.UTF8Encoding($false)

$SYSTEMS = @('hvac','plumbing','electrical','roof','structure','storefront_doors_glass','interior','common_areas','parking_lot','signage','pest_control','landscaping','fire_life_safety','utilities','general')

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
    name = 'submit_rm_matrix'
    description = 'Submit the repair and maintenance responsibility allocation found in this lease.'
    input_schema = @{
      type = 'object'
      properties = @{
        found = @{ type = 'boolean'; description = 'true ONLY if the provided text actually contains repair/maintenance responsibility language' }
        items = @{
          type = 'array'
          description = 'one entry per building system the lease actually addresses - do NOT invent entries for systems the text does not cover'
          items = @{
            type = 'object'
            properties = @{
              system = @{ type = 'string'; enum = $SYSTEMS }
              responsible = @{ type = 'string'; enum = @('landlord','tenant','shared','unclear'); description = 'who the lease obligates to maintain/repair this system; shared = split duties (e.g. tenant maintains, landlord replaces); unclear = text is ambiguous' }
              summary = @{ type = 'string'; description = 'one short plain-language sentence stating the allocation' }
              quote = @{ type = 'string'; description = 'VERBATIM lease language supporting this, max ~400 chars - quote exactly, never paraphrase' }
              section = @{ type = @('string','null'); description = 'section cited, e.g. "Sec. 8.2" or "Art. 11; 1st Amd Sec. 5"' }
            }
            required = @('system','responsible','summary','quote')
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
    $ids = @($ab.source_doc_ids) | Where-Object { $_ }
    $body = ''
    if ($ids.Count -gt 0) {
      $inlist = ($ids -join ',')
      $orFilter = [uri]::EscapeDataString('(content.ilike.*maintain*,content.ilike.*repair*)')
      try {
        # Verbatim text chunks with repair/maintenance language, then score toward
        # the real R&M articles so they survive the length cap.
        $rows = Invoke-RestMethod -Uri "$BASE/rest/v1/document_chunks?select=document_id,chunk_index,content&document_id=in.($inlist)&kind=eq.text&or=$orFilter&order=document_id,chunk_index&limit=160" -Headers $H -UserAgent $UA -TimeoutSec 120
        if (-not $rows -or @($rows).Count -eq 0) {
          $rows = Invoke-RestMethod -Uri "$BASE/rest/v1/document_chunks?select=document_id,chunk_index,content&document_id=in.($inlist)&or=$orFilter&order=document_id,chunk_index&limit=60" -Headers $H -UserAgent $UA -TimeoutSec 120
        }
        $strong = @('landlord shall maintain','tenant shall maintain','landlord shall repair','tenant shall repair','at its sole cost','sole cost and expense','good order and repair','good condition and repair','roof','structural','foundation','hvac','heating, ventilat','air conditioning','plumbing','common area','ordinary wear and tear','repairs and replacements','keep and maintain','exterior walls')
        $scored = @()
        $ord = 0
        foreach ($r in @($rows)) {
          $lc = ("" + $r.content).ToLower()
          $sc = 0
          foreach ($m in $strong) { if ($lc.Contains($m)) { $sc += 10 } }
          $scored += [pscustomobject]@{ ord = $ord; score = $sc; content = $r.content }
          $ord++
        }
        $keep = @($scored | Sort-Object -Property @{Expression='score';Descending=$true}, @{Expression='ord';Descending=$false} | Select-Object -First 14)
        foreach ($k in ($keep | Sort-Object ord)) { $body += "`n" + $k.content }
      } catch { }
    }
    if (-not $body.Trim()) {
      $rec = [ordered]@{ abstract_id = $ab.id; property_id = $ab.property_id; tenant_name = $ab.tenant_name; source_doc_ids = $ids; extraction = @{ found = $false; note = 'no repair/maintenance text in corpus' } }
      [IO.File]::AppendAllText($OUT, (($rec | ConvertTo-Json -Depth 10 -Compress) + "`n"), $utf8)
      $none++
      continue
    }
    if ($body.Length -gt 16000) { $body = $body.Substring(0, 16000) }

    $prompt = @"
You are building a repair & maintenance RESPONSIBILITY MATRIX for a commercial retail lease so the
landlord's property managers can tell, when a tenant submits a work order, whether the lease makes it a
LANDLORD or TENANT responsibility.

PROPERTY: $prop
TENANT: $($ab.tenant_name)

Below are excerpts from the lease and its amendments that mention repair or maintenance. For EACH building
system the text actually addresses, state who is responsible. Typical retail allocations (landlord: roof,
structure, foundation, common areas, parking; tenant: interior, storefront, its own HVAC unit) vary by
lease - report ONLY what THIS lease says. Rules:
- quote must be VERBATIM from the excerpts (max ~400 chars per item). Never paraphrase inside quote.
- A later amendment that changes an allocation SUPERSEDES the original - report the current state and cite
  both sections.
- Use responsible='shared' when duties split (e.g. tenant maintains and repairs, landlord replaces;
  or landlord repairs but bills the cost back through CAM). Mention the split in summary.
- Use responsible='unclear' if the text is genuinely ambiguous. Never guess.
- Use system='general' for a blanket repairs clause that does not name a specific system.
- Skip systems the excerpts do not cover. If there is no real R&M language at all, set found=false.

Call submit_rm_matrix with your result.

LEASE EXCERPTS:
$body
"@
    $req = @{
      model = 'claude-sonnet-5'
      max_tokens = 3000
      tools = @($tool)
      tool_choice = @{ type = 'tool'; name = 'submit_rm_matrix' }
      messages = @(@{ role = 'user'; content = $prompt })
    } | ConvertTo-Json -Depth 16
    $x = $null
    for ($try = 1; $try -le 3; $try++) {
      try {
        $r = Invoke-RestMethod -Method Post -Uri 'https://api.anthropic.com/v1/messages' -Headers @{ 'x-api-key' = $AK; 'anthropic-version' = '2023-06-01' } -ContentType 'application/json' -Body ($utf8.GetBytes($req)) -TimeoutSec 240
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
    [IO.File]::AppendAllText($OUT, (($rec | ConvertTo-Json -Depth 14 -Compress) + "`n"), $utf8)
    if ($x.found -and $x.items) { $ok++ } else { $none++ }
    if ($n % 10 -eq 0) { Write-Output ("{0}/{1}  with-matrix {2}  none {3}  failed {4}" -f $n, $todo.Count, $ok, $none, $fail) }
  }
  Write-Output ("DONE extract  {0}/{1}  with-matrix {2}  none {3}  failed {4}" -f $n, $todo.Count, $ok, $none, $fail)
  exit 0
}

# ---------------- LOAD mode ----------------
if (-not (Test-Path -LiteralPath $OUT)) { throw "no extract file at $OUT - run extract mode first" }

# Map (property_id, lowercased tenant name) -> {tenant_id, lease_id}
$link = @{}
$leases = Invoke-RestMethod -Uri "$BASE/rest/v1/leases?select=id,property_id,tenant_id,tenants(name,trade_name)&limit=2000" -Headers $H -UserAgent $UA -TimeoutSec 120
foreach ($l in $leases) {
  foreach ($nm in @($l.tenants.trade_name, $l.tenants.name)) {
    if ($nm) { $link["$($l.property_id)::$($nm.ToLower())"] = @{ tenant_id = $l.tenant_id; lease_id = $l.id } }
  }
}

$ins = 0; $tenantsN = 0; $skipped = 0
foreach ($line in [IO.File]::ReadAllLines($OUT, $utf8)) {
  if (-not $line) { continue }
  $rec = $line | ConvertFrom-Json
  $x = $rec.extraction
  if (-not $x.found -or -not $x.items) { $skipped++; continue }
  $items = @($x.items) | Where-Object { $_.system -and $_.responsible -and ($SYSTEMS -contains $_.system) }
  if ($items.Count -eq 0) { $skipped++; continue }
  $tenantsN++

  $propId = $rec.property_id
  $tname = $rec.tenant_name
  $lk = $link["$propId::$($tname.ToLower())"]
  $docs = @($rec.source_doc_ids) | Where-Object { $_ }

  # SAFE re-run: delete only THIS tenant's unverified ai_extraction rows.
  $tEsc = [uri]::EscapeDataString($tname)
  $delH = $H + @{ Prefer = 'return=minimal' }
  Invoke-RestMethod -Method Delete -Uri "$BASE/rest/v1/lease_rm_matrix?property_id=eq.$propId&tenant_name=eq.$tEsc&source=eq.ai_extraction&verified=eq.false" -Headers $delH -UserAgent $UA -TimeoutSec 120 | Out-Null

  $payload = @()
  foreach ($it in $items) {
    $payload += [ordered]@{
      property_id    = $propId
      tenant_id      = if ($lk) { $lk.tenant_id } else { $null }
      lease_id       = if ($lk) { $lk.lease_id } else { $null }
      abstract_id    = $rec.abstract_id
      tenant_name    = $tname
      system         = $it.system
      responsible    = $it.responsible
      summary        = Nz $it.summary
      quote          = Nz $it.quote
      section_ref    = Nz $it.section
      source_doc_ids = $docs
      source         = 'ai_extraction'
      verified       = $false
    }
  }
  # return=representation: return=minimal can silently fail to persist (loader gotcha).
  $insH = $H + @{ 'Content-Type' = 'application/json'; Prefer = 'return=representation' }
  $b = ($payload | ConvertTo-Json -Depth 10)
  if ($payload.Count -eq 1) { $b = "[$b]" }
  Invoke-RestMethod -Method Post -Uri "$BASE/rest/v1/lease_rm_matrix" -Headers $insH -UserAgent $UA -Body ($utf8.GetBytes($b)) -TimeoutSec 120 | Out-Null
  $ins += $payload.Count
}
Write-Output ("DONE load  tenants-with-matrix {0}  rows-inserted {1}  skipped-none {2}" -f $tenantsN, $ins, $skipped)
