# backfill_text_embeddings.ps1 - add Voyage vectors to kind='text' chunks that were
# stored content-only (skipEmbed=1). See [[project-corpus-text-layer]].
#
# WHY: bulk embedded inserts during reindex blew the edge wall (HNSW maintenance on
# the big embedding_voyage index). skipEmbed stored chunks WITHOUT vectors so FTS +
# the abstractor work immediately; this backfills the SEMANTIC vectors afterward.
#
# PROD-SAFETY: each UPDATE triggers HNSW maintenance, which strains the shared
# compute tier. Run THROTTLED and OFF-HOURS (or after a temporary compute bump).
# Self-resuming: only processes rows where embedding_voyage IS NULL. Ctrl-C safe.
#
#   .\backfill_text_embeddings.ps1 -Batch 64 -DelayMs 1500
param(
  [int]$Batch = 64,        # chunks embedded per Voyage call (<=128) and per progress tick
  [int]$DelayMs = 1200,    # sleep between batches - protects the live prod DB
  [int]$Limit = 0          # 0 = until none remain; >0 = stop after N chunks (testing)
)
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$cfg = @{}
foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match '=' })) { $k, $v = $l -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$BASE = $cfg['VITE_SUPABASE_URL']; $KEY = $cfg['SUPABASE_SECRET_KEY']; $VOYAGE = $cfg['VOYAGE_API_KEY']
$MODEL = if ($cfg['VOYAGE_MODEL']) { $cfg['VOYAGE_MODEL'] } else { 'voyage-3-large' }
$UA = 'cre-loader/1.0'
$amp = [char]38
$H = @{ apikey = $KEY; Authorization = "Bearer $KEY" }
$log = "$PSScriptRoot\backfill_text_embeddings.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; $line | Out-File $log -Append -Encoding utf8; Write-Output $line }

$enc = New-Object System.Text.UTF8Encoding($false)
function VoyageEmbed($texts) {
  # POST via curl.exe with a UTF-8 --data-binary file: PowerShell 5.1's
  # Invoke-RestMethod corrupts non-ASCII in a string body (OCR text has section
  # symbols / curly quotes), which Voyage rejects with a 400. curl sends exact bytes.
  $body = @{ input = $texts; model = $MODEL; input_type = 'document'; output_dimension = 1024 } | ConvertTo-Json -Compress -Depth 4
  $tmp = "$PSScriptRoot\_voy_body.json"
  for ($a = 1; $a -le 5; $a++) {
    [System.IO.File]::WriteAllText($tmp, $body, $enc)
    $resp = & curl.exe -s -X POST 'https://api.voyageai.com/v1/embeddings' -H "Authorization: Bearer $VOYAGE" -H 'Content-Type: application/json' --data-binary "@$tmp"
    try {
      $j = $resp | ConvertFrom-Json
      if ($j.data) {
        $out = New-Object 'object[]' $texts.Count
        foreach ($d in $j.data) { $out[$d.index] = $d.embedding }
        return $out
      }
    } catch {}
    if ($a -eq 5) { throw "Voyage embed failed: " + $resp.Substring(0, [Math]::Min(200, $resp.Length)) }
    Start-Sleep -Seconds (5 * $a)   # transient / 429 backoff
  }
}

$total = 0
while ($true) {
  # Keyset-free: the IS NULL filter means processed rows drop out of the result set,
  # so a plain LIMIT page always returns the next unembedded chunks.
  $sel = "select=id,content" + $amp + "kind=eq.text" + $amp + "embedding_voyage=is.null" + $amp + "limit=$Batch"
  $rows = Invoke-RestMethod -Uri "$BASE/rest/v1/document_chunks?$sel" -Headers $H -UserAgent $UA -TimeoutSec 90
  if (-not $rows -or $rows.Count -eq 0) { Log "no more unembedded text chunks - done"; break }

  $texts = @($rows | ForEach-Object { if ($_.content) { $_.content.Substring(0, [Math]::Min(32000, $_.content.Length)) } else { ' ' } })
  try { $vecs = VoyageEmbed $texts } catch { Log "Voyage failed, backing off: $($_.Exception.Message)"; Start-Sleep -Seconds 30; continue }

  # PATCH via curl.exe too: PS 5.1 Invoke-RestMethod returns 401 on these writes
  # even with the correct apikey/Authorization/UA, while curl with the same headers
  # succeeds (204). Body is pure-ASCII (the vector literal), so no encoding concern.
  $ok = 0
  $ptmp = "$PSScriptRoot\_patch_body.json"
  for ($i = 0; $i -lt $rows.Count; $i++) {
    if (-not $vecs[$i]) { continue }
    $lit = '[' + ($vecs[$i] -join ',') + ']'
    $patch = @{ embedding_voyage = $lit } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($ptmp, $patch, $enc)
    $code = & curl.exe -s -w '%{http_code}' -X PATCH -A $UA -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -H 'Prefer: return=minimal' --data-binary "@$ptmp" "$BASE/rest/v1/document_chunks?id=eq.$($rows[$i].id)"
    if ($code -match '20[04]') { $ok++ } else { Log "PATCH http=$code id=$($rows[$i].id)" }
  }
  $total += $ok
  Log "batch: embedded $ok/$($rows.Count) (running total $total)"
  if ($Limit -gt 0 -and $total -ge $Limit) { Log "hit -Limit $Limit, stopping"; break }
  if ($DelayMs -gt 0) { Start-Sleep -Milliseconds $DelayMs }
}
Log "backfill complete: $total chunks embedded this run"
