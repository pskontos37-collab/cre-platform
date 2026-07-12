#!/usr/bin/env bash
# Parallel resumable PDF backfill: N concurrent workers over disjoint shards.
set -u
SP="/c/Users/pskontos/AppData/Local/Temp/claude/C--Users-pskontos-Desktop-Software/c9d09617-ceab-4ad8-9e65-cb51a8403010/scratchpad"
set -a && source /c/Users/pskontos/Desktop/Software/cre-platform/.env && set +a
WORKERS=6
IDS="$SP/backfill_ids.txt"
LOG="$SP/parallel.log"
DONE_ALL="$SP/done_all.txt"
REMAIN="$SP/remaining.txt"

echo "$(date '+%H:%M:%S') ===== PARALLEL START (workers=$WORKERS) =====" >> "$LOG"

# 1. Rebuild done-set from the DB (documents already extracted)
curl -s "$VITE_SUPABASE_URL/rest/v1/documents?select=file_path&file_path=like.drive:*" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" --max-time 120 \
  | grep -oE 'drive:[A-Za-z0-9_-]+' | sed 's/drive://' | sort -u > "$DONE_ALL"

# 2. Remaining = ids - done
sed 's/\r$//' "$IDS" | sed '/^$/d' | sort -u | comm -23 - "$DONE_ALL" > "$REMAIN"
total=$(wc -l < "$REMAIN" | tr -d ' ')
echo "$(date '+%H:%M:%S') done_already=$(wc -l < "$DONE_ALL" | tr -d ' ') remaining=$total" >> "$LOG"

# 3. Shard remaining into WORKERS disjoint files (round-robin)
for w in $(seq 0 $((WORKERS-1))); do : > "$SP/shard_$w.txt"; done
awk -v n="$WORKERS" -v sp="$SP" '{ print > (sp "/shard_" (NR % n) ".txt") }' "$REMAIN"

# 4. Worker: process its shard
worker() {
  local w=$1 ok=0 err=0 resp
  while IFS= read -r id; do
    id="${id%$'\r'}"; [ -z "$id" ] && continue
    resp=$(curl -s -X POST \
      "$VITE_SUPABASE_URL/functions/v1/pdf-extract?driveId=$id&store=1&model=claude-haiku-4-5" \
      -H "Authorization: Bearer $VITE_SUPABASE_ANON_KEY" -H "apikey: $VITE_SUPABASE_ANON_KEY" \
      -H "Content-Type: application/json" --max-time 200)
    if printf '%s' "$resp" | grep -q '"success": true'; then
      ok=$((ok+1))
    else
      err=$((err+1))
      echo "$(date '+%H:%M:%S') w$w ERR $id :: $(printf '%s' "$resp" | head -c 120)" >> "$LOG"
    fi
    if [ $(((ok+err) % 25)) -eq 0 ]; then echo "$(date '+%H:%M:%S') w$w ok=$ok err=$err" >> "$LOG"; fi
  done < "$SP/shard_$w.txt"
  echo "$(date '+%H:%M:%S') w$w DONE ok=$ok err=$err" >> "$LOG"
}

# 5. Launch all workers concurrently, wait for all
for w in $(seq 0 $((WORKERS-1))); do worker "$w" & done
wait
echo "$(date '+%H:%M:%S') ===== PARALLEL COMPLETE =====" >> "$LOG"
