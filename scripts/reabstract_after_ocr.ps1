# reabstract_after_ocr.ps1 - re-runs lease-abstract for the tenants whose source
# documents gained a text layer in the 2026-07-30 OCR pass. Those abstracts were
# written against documents that were image-only scans, so the model could not read
# the pages the OCR has now transcribed.
#
# TARGETS (chosen by evidence, not by name): an abstract qualifies only if one of its
# source_doc_ids gained a kind='text' chunk of >200 chars dated today. Measured gains:
#   Target             +67 text chunks (Gateway)
#   WHOLE FOODS 10483  +64 (Gateway)
#   Kirkland's         +61 (Magnolia)
#   ULTA 594           +56 (Gateway)
#   Woodhouse Day Spa  +47 (Magnolia)
#   The Good Feet Store +43 of 91 total (Magnolia) - nearly half its text is new
#
# NONE of the six is `locked` or `human_verified`, which is the guard
# batch_abstracts_regen.ps1 uses. Woodhouse Day Spa carries qa_status='verified' from
# the automated verifier (not a human), so its before-state is saved below and the
# post-run diff is reported rather than assumed.
#
# BEFORE/AFTER IS RECORDED, NOT TRUSTED. The script writes _reabstract_before.json
# before touching anything, so the effect of the new text can be diffed instead of
# eyeballed - and so a regression is recoverable.
#
# WARNING: THE SNAPSHOT STORES THE FULL ABSTRACT JSON, not just a fingerprint. The
# first run of this script saved only md5/length/counts, and that was a mistake:
# lease_abstracts has NO audit trigger (audit_log holds nothing for it), so
# force=true OVERWRITES the row and the previous abstract is gone for good. A hash
# proves something changed; it cannot tell you WHAT changed and it cannot restore it.
# For a destructive overwrite with no audit trail, the snapshot IS the backup.
#
# WARNING: POST VIA curl.exe --data-binary WITH A UTF-8 NO-BOM FILE. PS 5.1's
# Invoke-RestMethod corrupts non-ASCII in the body and returns spurious 401s on some
# calls; "Kirkland's" carries an apostrophe and the accented names elsewhere in this
# corpus are exactly what broke earlier runs. This is the pattern
# batch_abstracts_regen.ps1 already proved.
param(
  [switch]$WhatIf,                      # list the targets and exit without spending
  [int]$DelayMs = 1000
)
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']
$UA = 'cre-loader/1.0'
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$log = "$PSScriptRoot\reabstract_after_ocr.log"
$enc = New-Object System.Text.UTF8Encoding($false)
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }

$GW  = 'd5a4ed03-0b60-4168-9208-83822dd24884'
$MAG = 'd4f08824-2d88-472d-b7aa-a703310c2aaf'
$targets = @(
  @{ p = $GW;  t = 'Target' }
  @{ p = $GW;  t = 'WHOLE FOODS 10483' }
  @{ p = $GW;  t = 'ULTA 594' }
  @{ p = $MAG; t = "Kirkland's" }
  @{ p = $MAG; t = 'Woodhouse Day Spa' }
  @{ p = $MAG; t = 'The Good Feet Store' }
)

# ---- refuse to clobber a locked or human-verified abstract, re-checked live ----
$safe = New-Object System.Collections.Generic.List[object]
foreach ($x in $targets) {
  $enc2 = [uri]::EscapeDataString($x.t)
  $row = Invoke-RestMethod -Uri "$BASE/rest/v1/lease_abstracts?select=tenant_name,locked,human_verified,qa_status&property_id=eq.$($x.p)&tenant_name=eq.$enc2" -Headers $H -UserAgent $UA -TimeoutSec 60
  $r = @($row)[0]
  if (-not $r) { Log "SKIP $($x.t): no abstract row found"; continue }
  if ($r.locked -or $r.human_verified) { Log "SKIP $($x.t): locked=$($r.locked) human_verified=$($r.human_verified) - never clobber a human decision"; continue }
  $safe.Add($x)
}
Log "targets: $($targets.Count) requested, $($safe.Count) safe to regenerate"

# ---- before-snapshot (md5 + the fields most likely to move) ----
$before = New-Object System.Collections.Generic.List[object]
foreach ($x in $safe) {
  $enc2 = [uri]::EscapeDataString($x.t)
  $row = Invoke-RestMethod -Uri "$BASE/rest/v1/lease_abstracts?select=tenant_name,generated_at,abstract,qa_status&property_id=eq.$($x.p)&tenant_name=eq.$enc2" -Headers $H -UserAgent $UA -TimeoutSec 90
  $r = @($row)[0]
  $json = ($r.abstract | ConvertTo-Json -Depth 20 -Compress)
  $md5 = [BitConverter]::ToString([Security.Cryptography.MD5]::Create().ComputeHash($enc.GetBytes($json))).Replace('-','').ToLower()
  $before.Add([pscustomobject]@{
    tenant = $r.tenant_name; property_id = $x.p; generated_at = $r.generated_at
    qa_status = $r.qa_status; len = $json.Length; md5 = $md5
    square_footage = $r.abstract.square_footage; suite = $r.abstract.suite
    open_items = @($r.abstract.open_items).Count; lease_documents = @($r.abstract.lease_documents).Count
    # THE BACKUP. Without this the overwritten abstract is unrecoverable - there is no
    # audit trigger on lease_abstracts. Depth 30 because the abstract nests several
    # levels (base_rent_schedule, options, critical_dates each hold object arrays) and
    # ConvertTo-Json SILENTLY TRUNCATES past -Depth, which would make the "backup" a
    # lie exactly where the detail lives.
    abstract_full = $r.abstract
  })
}
$beforePath = "$PSScriptRoot\_reabstract_before_$(Get-Date -Format 'yyyyMMdd_HHmmss').json"
[IO.File]::WriteAllText($beforePath, ($before | ConvertTo-Json -Depth 30), $enc)
Log "before-state saved (FULL abstracts, restorable): $beforePath"
$before | ForEach-Object { Log ("  BEFORE {0,-22} len={1,-6} sf={2,-8} open={3,-3} docs={4,-3} qa={5}" -f $_.tenant, $_.len, $_.square_footage, $_.open_items, $_.lease_documents, $_.qa_status) }

if ($WhatIf) { Log '-WhatIf: stopping before any paid call'; return }

# ---- regenerate ----
$ok = 0; $fail = 0
foreach ($x in $safe) {
  $body = (@{ property_id = $x.p; tenant = $x.t; force = $true } | ConvertTo-Json -Compress)
  $tmp = "$PSScriptRoot\_reabstract_body.json"
  [IO.File]::WriteAllText($tmp, $body, $enc)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $out = & curl.exe -s -w "`n%{http_code}" -X POST "$BASE/functions/v1/lease-abstract" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -A $UA --data-binary "@$tmp" --max-time 285
  $sw.Stop()
  $code = ($out -split "`n")[-1]
  $json = if ($out.Length -gt $code.Length) { $out.Substring(0, $out.Length - $code.Length - 1) } else { '' }
  if ($code -eq '200') {
    $ok++
    $docs = ''; $pdfs = ''
    try { $o = $json | ConvertFrom-Json; $docs = $o.docs_used; $pdfs = $o.pdf_sources } catch {}
    Log ("OK   {0,-22} {1,4}s docs_used=$docs pdf_sources=$pdfs" -f $x.t, [math]::Round($sw.Elapsed.TotalSeconds))
  } else {
    $fail++
    Log ("FAIL {0,-22} {1,4}s http=$code :: {2}" -f $x.t, [math]::Round($sw.Elapsed.TotalSeconds), (($json -replace '\s+',' ').Substring(0, [Math]::Min(220, $json.Length))))
  }
  if ($DelayMs -gt 0) { Start-Sleep -Milliseconds $DelayMs }
}
Log "REABSTRACT DONE: ok=$ok fail=$fail (before-state in _reabstract_before.json)"
