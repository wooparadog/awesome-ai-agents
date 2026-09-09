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
  path=$(jq -r '.transcript//empty' "$run")
  [ -f "$path" ] || { complete=false; continue; }
  key=$(printf '%s' "$path" | sha256sum | cut -d ' ' -f1)
  cursor="$STATE/cursors/$key.json"
  [ -f "$cursor" ] || printf '{"offset":0,"model":null}' > "$cursor"
  offset=$(jq '.offset' "$cursor"); size=$(stat -c %s "$path")
  inode=$(stat -c '%d:%i' "$path")
  discard=$(jq -r '.discard//false' "$cursor")
  if [ "$size" -lt "$offset" ] || [ "$(jq -r '.inode//empty' "$cursor")" != "$inode" ]; then offset=0; discard=false; fi
  [ "$size" -gt "$offset" ] || continue
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
  agent=$(jq -r '.agent' "$run"); sid=$(jq -r '.native_session_id' "$run"); rid=$(jq -r '.run_id' "$run")
  model=$(jq -r '.model//empty' "$cursor")
  if ! jq -Rnc --arg agent "$agent" --arg session "$sid" --arg run "$rid" --arg model "$model" -f "$ROOT/usage.jq" < "$work/complete" > "$work/parsed"; then
    : > "$STATE/dropped.invalid-$key"
    complete=false
    continue
  fi
  if jq -se 'any(.[]; .invalid)' "$work/parsed" >/dev/null; then : > "$STATE/dropped.invalid-$key"; fi
  jq -c '.records[] | select(.model!="<synthetic>")' "$work/parsed" > "$work/records"
  jq -sc 'range(0;length;64) as $i | {kind:"usage",records:.[$i:$i+64]}' "$work/records" > "$work/batches"
  while IFS= read -r record; do
    # Stable identity across retries and copied records; provider dedup happens centrally.
    id=$(printf '%s' "$record" | sha256sum | cut -d ' ' -f1)
    file="$STATE/outbox/usage-$id.json"
    printf '%s' "$record" > "$work/item"
    mv "$work/item" "$file"
  done < "$work/batches"
  finalmodel=$model
  [ ! -s "$work/parsed" ] || finalmodel=$(tail -n 1 "$work/parsed" | jq -r '.model//empty')
  jq -n --argjson offset "$((offset+bytes))" --arg model "$finalmodel" --arg inode "$inode" '{offset:$offset,model:$model,inode:$inode}' > "$work/cursor"
  mv "$work/cursor" "$cursor"
  [ "$((offset+bytes))" -ge "$size" ] || complete=false
done

if [ "$complete" = true ]; then : > "$STATE/usage-ready"; else rm -f "$STATE/usage-ready"; fi
