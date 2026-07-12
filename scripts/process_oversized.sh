#!/usr/bin/env bash
set -u
SP="/c/Users/pskontos/AppData/Local/Temp/claude/C--Users-pskontos-Desktop-Software/c9d09617-ceab-4ad8-9e65-cb51a8403010/scratchpad"
set -a && source /c/Users/pskontos/Desktop/Software/cre-platform/.env && set +a
LOG="$SP/oversized.log"
echo "$(date '+%H:%M:%S') ===== OVERSIZED PASS START =====" >> "$LOG"

# Rebuild full done-set from DB (paginated, PostgREST caps at 1000/page)
> "$SP/db_done2.txt"
for start in 0 1000 2000 3000; do
  curl -s "$VITE_SUPABASE_URL/rest/v1/documents?select=file_path&file_path=like.drive:*&order=file_path" \
    -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" \
    -H "Range-Unit: items" -H "Range: $start-$((start+999))" --max-time 120 \
    | grep -oE 'drive:[A-Za-z0-9_-]+' | sed 's/drive://' >> "$SP/db_done2.txt"
done
sort -u "$SP/db_done2.txt" -o "$SP/db_done2.txt"
sed 's/\r$//' "$SP/backfill_ids.txt" | sed '/^$/d' | sort -u | comm -23 - "$SP/db_done2.txt" > "$SP/missing2.txt"
echo "$(date '+%H:%M:%S') remaining to process: $(wc -l < "$SP/missing2.txt")" >> "$LOG"

ok=0; err=0
while IFS= read -r id; do
  id="${id%$'\r'}"; [ -z "$id" ] && continue
  resp=$(curl -s -X POST "$VITE_SUPABASE_URL/functions/v1/pdf-extract?driveId=$id&store=1&model=claude-haiku-4-5" \
    -H "Authorization: Bearer $VITE_SUPABASE_ANON_KEY" -H "apikey: $VITE_SUPABASE_ANON_KEY" \
    -H "Content-Type: application/json" --max-time 600)
  if printf '%s' "$resp" | grep -q '"success": true'; then
    ok=$((ok+1))
    info=$(printf '%s' "$resp" | grep -oE '"(page_count|was_split|segments|embedded_chunks)"[: ]*[^,}]*' | tr '\n' ' ')
    echo "$(date '+%H:%M:%S') OK  $id :: $info" >> "$LOG"
  else
    err=$((err+1))
    echo "$(date '+%H:%M:%S') ERR $id :: $(printf '%s' "$resp" | head -c 200)" >> "$LOG"
  fi
done < "$SP/missing2.txt"
echo "$(date '+%H:%M:%S') ===== OVERSIZED PASS DONE ok=$ok err=$err =====" >> "$LOG"
