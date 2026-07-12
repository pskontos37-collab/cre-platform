# reembed_voyage.ps1 - backfill document_chunks.embedding_voyage with voyage-3-large (1024-dim).
# Idempotent + resumable: only touches chunks where embedding_voyage IS NULL, so re-running
# continues where it left off. Reads keys from cre-platform\.env (never hard-coded).
#
# Pipeline per batch: fetch N null-embedding chunks -> Voyage /embeddings (input_type=document)
# -> set_voyage_embeddings RPC (one round-trip writes the whole batch).
$ErrorActionPreference = "Stop"
$repo = "C:\Users\pskontos\Desktop\Software\cre-platform"
$cfg = @{}; foreach ($l in (Get-Content "$repo\.env" | Where-Object { $_ -match "=" })) { $k,$v = $l -split '=',2; $cfg[$k.Trim()]=$v.Trim() }
$BASE=$cfg['VITE_SUPABASE_URL']; $KEY=$cfg['SUPABASE_SECRET_KEY']; $VK=$cfg['VOYAGE_API_KEY']
$MODEL = if ($cfg['VOYAGE_MODEL']) { $cfg['VOYAGE_MODEL'] } else { 'voyage-3-large' }
$DIMS = 1024
$BATCH = 24            # chunks per request (keeps batch tokens well under Voyage's cap)
$CAP = 12000          # max chars per chunk sent to embed (~3k tokens)
$enc = New-Object System.Text.UTF8Encoding($false)
$tmp = "$env:TEMP\_voyage_rpc.json"

function Get-NullChunks($n) {
  $u = "$BASE/rest/v1/document_chunks?select=id,content&embedding_voyage=is.null&limit=$n"
  $r = & curl.exe -s $u -H "apikey: $KEY" -H "Authorization: Bearer $KEY"
  if ($r -match '"code"' -and $r -match '"message"') { throw "GET chunks failed: $r" }
  return ($r | ConvertFrom-Json)
}

function Invoke-Voyage($texts) {
  for ($a=1; $a -le 6; $a++) {
    try {
      $body = @{ input=$texts; model=$MODEL; input_type='document'; output_dimension=$DIMS } | ConvertTo-Json -Compress -Depth 4
      $resp = Invoke-RestMethod -Method Post -Uri "https://api.voyageai.com/v1/embeddings" `
        -Headers @{ Authorization = "Bearer $VK" } -ContentType 'application/json' `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 120
      return $resp.data
    } catch {
      if ($a -eq 6) { throw }
      Start-Sleep -Seconds (5*$a)   # 429 / transient -> back off
    }
  }
}

$total = 0
while ($true) {
  $rows = Get-NullChunks $BATCH
  if (-not $rows -or $rows.Count -eq 0) { break }

  $texts = @(); foreach ($r in $rows) {
    $c = [string]$r.content; if (-not $c -or $c.Trim().Length -eq 0) { $c = "(no content)" }
    if ($c.Length -gt $CAP) { $c = $c.Substring(0,$CAP) }
    $texts += $c
  }

  $data = Invoke-Voyage $texts
  if ($data.Count -ne $rows.Count) { throw "Voyage returned $($data.Count) vectors for $($rows.Count) inputs" }

  $ids = @(); $vecs = @()
  for ($i=0; $i -lt $rows.Count; $i++) {
    $ids  += $rows[$i].id
    $vecs += ('[' + (($data[$i].embedding) -join ',') + ']')
  }
  $rpc = @{ p_ids=$ids; p_vecs=$vecs } | ConvertTo-Json -Compress -Depth 4
  [System.IO.File]::WriteAllText($tmp,$rpc,$enc)
  $wr = $null
  for ($a=1; $a -le 5; $a++) {
    $wr = & curl.exe -s -X POST "$BASE/rest/v1/rpc/set_voyage_embeddings" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" --data-binary "@$tmp"
    if (-not ($wr -match '"code"' -and $wr -match '"message"')) { break }
    if ($a -eq 5) { throw "RPC set_voyage_embeddings failed: $wr" }
    Start-Sleep -Seconds (3*$a)   # transient timeout / lock -> back off and retry
  }

  $total += $rows.Count
  Write-Output "$(Get-Date -Format HH:mm:ss)  embedded $total (last batch $($rows.Count), wrote=$wr)"
}
Write-Output "DONE. total embedded this run: $total"