#!/bin/sh
# Called outside hook latency budget; may also be run manually after configuration.
set -eu
umask 077
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
STATE=$1
exec 7>"$STATE/usage.lock"
flock -n 7 || exit 0
work=$(mktemp -d "$STATE/usage.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
complete=true
for run in "$STATE"/runs/*.json "$STATE"/history/*.json; do
  [ -f "$run" ] || continue
  closed=$(jq -r '.closed//false' "$run")
  # Closed executions stop collecting after their final complete scan. Very old
  # runs are outside the server's evidence window even if the local file vanished.
  if [ "$closed" = true ] && [ "$(stat -c %Y "$run")" -lt "$(( $(date +%s) - 7 * 86400 ))" ]; then continue; fi
  path=$(jq -r '.transcript//empty' "$run")
  agent=$(jq -r '.agent' "$run"); sid=$(jq -r '.native_session_id' "$run"); rid=$(jq -r '.run_id' "$run")
  if [ ! -f "$path" ] && [ "$agent" = codex ]; then
    path=$(find "${CODEX_HOME:-$HOME/.codex}/sessions" "${CODEX_HOME:-$HOME/.codex}/archived_sessions" \
      -type f -name "*${sid}*.jsonl" -print -quit 2>/dev/null || true)
  fi
  # End-only hooks and setup probes may never have had a transcript. They do not
  # make collection of all observed transcripts permanently incomplete.
  if [ -z "$path" ] && [ "$(jq -r '.closed//false' "$run")" = true ] &&
    [ -z "$(jq -r '.transcript//empty' "$run")" ]; then continue; fi
  [ -f "$path" ] || { complete=false; continue; }
  # Resumed executions may share a transcript. Each run must observe its usage;
  # provider record IDs still deduplicate the workspace totals at the collector.
  key=$(printf '%s\n%s' "$rid" "$path" | sha256sum | cut -d ' ' -f1)
  cursor="$STATE/cursors/$key.json"
  [ -f "$cursor" ] || printf '{"offset":0,"model":null}' > "$cursor"
  if [ "$closed" = true ] && [ "$(jq -r '.finalized//false' "$cursor")" = true ]; then continue; fi
  offset=$(jq '.offset' "$cursor"); size=$(stat -c %s "$path")
  mode=$(jq -r '.mode//"cumulative"' "$cursor")
  # Re-read existing Codex transcripts once to recover authoritative per-response
  # usage. Stable response IDs make replay safe, including copied transcripts.
  if [ "$agent" = codex ] && [ "$(jq -r '.version//0' "$cursor")" -lt 2 ]; then offset=0; fi
  inode=$(stat -c '%d:%i' "$path")
  discard=$(jq -r '.discard//false' "$cursor")
  if [ "$size" -lt "$offset" ] || [ "$(jq -r '.inode//empty' "$cursor")" != "$inode" ]; then offset=0; discard=false; mode=cumulative; fi
  if [ "$size" -le "$offset" ]; then
    if [ "$closed" = true ]; then jq '.finalized=true' "$cursor" > "$work/cursor"; mv "$work/cursor" "$cursor"; fi
    continue
  fi
  # Bounded chunk, retaining partial tail for the next scan.
  dd if="$path" iflag=skip_bytes,count_bytes skip="$offset" count=16777216 status=none > "$work/chunk"
  last=$(tail -c 1 "$work/chunk" | od -An -tu1 | tr -d ' ')
  if [ "$last" != 10 ]; then sed '$d' "$work/chunk" > "$work/complete"; else cp "$work/chunk" "$work/complete"; fi
  bytes=$(wc -c < "$work/complete")
  if [ "$bytes" -eq 0 ]; then
    if [ "$(wc -c < "$work/chunk")" -ge 16777216 ]; then
      : > "$STATE/dropped.oversized-$key"
      jq --arg inode "$inode" --argjson offset "$((offset+16777216))" '.offset=$offset|.inode=$inode|.discard=true' "$cursor" > "$work/cursor"
      mv "$work/cursor" "$cursor"
    fi
    complete=false
    continue
  fi
  if [ "$discard" = true ]; then sed '1d' "$work/complete" > "$work/rest"; mv "$work/rest" "$work/complete"; fi
  if [ "$agent" = codex ] && jq -Rse 'split("\n") | any(.[]; (try fromjson catch {}) | .type=="token_usage_record" and .payload.response_id!=null)' "$work/complete" >/dev/null; then mode=responses; fi
  model=$(jq -r '.model//empty' "$cursor")
  if [ "$offset" -eq 0 ]; then model=""; fi
  if ! jq -Rnc --arg agent "$agent" --arg session "$sid" --arg run "$rid" --arg model "$model" --arg mode "$mode" -f "$ROOT/usage.jq" < "$work/complete" > "$work/parsed"; then
    : > "$STATE/dropped.invalid-$key"
    complete=false
    continue
  fi
  if jq -se 'any(.[]; .invalid)' "$work/parsed" >/dev/null; then : > "$STATE/dropped.invalid-$key"; fi
  jq -c '.records[] | select(.model!="<synthetic>")' "$work/parsed" > "$work/records"
  jq -sc '(if .[0].provider=="anthropic" then unique_by(del(.occurred_at)) else . end) |
    range(0;length;64) as $i | {kind:"usage",records:.[$i:$i+64]}' "$work/records" > "$work/batches"
  while IFS= read -r record; do
    # Stable identity across retries and copied records; provider dedup happens centrally.
    id=$(printf '%s' "$record" | sha256sum | cut -d ' ' -f1)
    file="$STATE/outbox/usage-$id.json"
    printf '%s' "$record" > "$work/item"
    mv "$work/item" "$file"
  done < "$work/batches"
  finalmodel=$model
  [ ! -s "$work/parsed" ] || finalmodel=$(tail -n 1 "$work/parsed" | jq -r '.model//empty')
  jq -n --argjson offset "$((offset+bytes))" --argjson size "$size" --argjson closed "$closed" --arg model "$finalmodel" --arg inode "$inode" --arg mode "$mode" \
    '{offset:$offset,model:$model,inode:$inode,mode:$mode,version:2,finalized:($closed and $offset>=$size)}' > "$work/cursor"
  mv "$work/cursor" "$cursor"
  [ "$((offset+bytes))" -ge "$size" ] || complete=false
done

if [ "$complete" = true ]; then : > "$STATE/usage-ready"; else rm -f "$STATE/usage-ready"; fi
