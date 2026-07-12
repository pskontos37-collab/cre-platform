#!/usr/bin/env bash
# Resumable PDF backfill: extract + embed each unique doc via pdf-extract (Haiku).
set -u
SP="/c/Users/pskontos/AppData/Local/Temp/claude/C--Users-pskontos-Desktop-Software/c9d09617-ceab-4ad8-9e65-cb51a8403010/scratchpad"
set -a && source /c/Users/pskontos/Desktop/Software/cre-platform/.env && set +a
LOG="$SP/backfill_progress.log"
IDS="$SP/backfill_ids.txt"
DONE="$SP/backfill_done.txt"
RESP="$SP/_resp.json"

echo "$(date '+%H:%M:%S') DIAG url=[${VITE_SUPABASE_URL:-UNSET}] anon_len=${#VITE_SUPABASE_ANON_KEY} secret_len=${#SUPABASE_SECRET_KEY}" >> "$LOG"

# Build the already-processed set (documents.file_path = drive:<id>)
curl -s "$VITE_SUPABASE_URL/rest/v1/documents?select=file_path&file_path=like.drive:*" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" --max-time 90 \
  | grep -oE 'drive:[A-Za-z0-9_-]+' | sed 's/drive://' | sort -u > "$DONE"

total=$(wc -l < "$IDS" | tr -d ' '); n=0; ok=0; skip=0; err=0
echo "$(date '+%H:%M:%S') START total=$total already_done=$(wc -l < "$DONE" | tr -d ' ')" >> "$LOG"

while IFS= read -r id; do
  id="${id%$'\r'}"          # defensive: strip any trailing CR
  [ -z "$id" ] && continue
  n=$((n+1))
  if grep -qxF "$id" "$DONE"; then skip=$((skip+1)); continue; fi
  http=$(curl -s -o "$RESP" -w "%{http_code}" -X POST \
        "$VITE_SUPABASE_URL/functions/v1/pdf-extract?driveId=$id&store=1&model=claude-haiku-4-5" \
        -H "Authorization: Bearer $VITE_SUPABASE_ANON_KEY" -H "apikey: $VITE_SUPABASE_ANON_KEY" \
        -H "Content-Type: application/json" --max-time 200)
  rc=$?
  if grep -q '"success": true' "$RESP"; then ok=$((ok+1)); echo "$id" >> "$DONE"
  else err=$((err+1)); echo "$(date '+%H:%M:%S') ERR $id http=$http rc=$rc :: $(head -c 140 "$RESP")" >> "$LOG"; fi
  if [ $((n % 25)) -eq 0 ]; then echo "$(date '+%H:%M:%S') progress $n/$total ok=$ok skip=$skip err=$err" >> "$LOG"; fi
done < "$IDS"

echo "$(date '+%H:%M:%S') DONE processed_now=$ok skipped=$skip errors=$err" >> "$LOG"
