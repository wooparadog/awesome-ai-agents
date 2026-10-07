#!/bin/sh
# Linux: POSIX shell, curl, jq, coreutils and util-linux flock. No daemon.
set -eu
umask 077
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
CONFIG=${AI_AGENTS_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/ai-agents}
STATE=${AI_AGENTS_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/ai-agents}
mkdir -p "$CONFIG" "$STATE/outbox" "$STATE/runs" "$STATE/quarantine" "$STATE/cursors" "$STATE/history"
uuid() { cat /proc/sys/kernel/random/uuid; }
now() { date +%s%3N; }
atomic() { dest=$1; cat > "$dest.tmp.$$"; mv "$dest.tmp.$$" "$dest"; }
error() { printf '%s\n' "$*" >&2; exit 1; }
case ${1:-help} in
  init)
    [ "$#" -eq 4 ] || error 'usage: reporter.sh init HTTPS_URL INSTALLATION_ID TOKEN_FILE'
    case $2 in https://*|http://127.0.0.1:*|http://localhost:*) ;; *) error 'HTTPS required (loopback HTTP allowed)' ;; esac
    token=$(tr -d '\r\n' < "$4")
    printf '%s' "$token" | jq -Rse 'test("^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{40,100}$")' >/dev/null || error 'invalid token'
    printf '%s\n' "$token" | atomic "$CONFIG/write.token"
    jq -n --arg url "${2%/}" --arg installation "$3" '{url:$url,installation_id:$installation}' | atomic "$CONFIG/config.json"
    printf 'Configured installation %s. Schedule reporter.sh reconcile every 5 minutes.\n' "$3"
    exit 0 ;;
  help) printf '%s\n' 'reporter.sh init URL INSTALLATION_ID TOKEN_FILE | hook AGENT EVENT | flush | reconcile | status'; exit 0 ;;
esac
[ -f "$CONFIG/config.json" ] || error 'reporter is not configured'
URL=$(jq -er '.url' "$CONFIG/config.json")
INSTALLATION=$(jq -er '.installation_id' "$CONFIG/config.json")
case $URL in https://*|http://127.0.0.1:*|http://localhost:*) ;; *) error 'invalid collector URL' ;; esac
MODE=$1
exec 9>"$STATE/lock"
if ! flock -w 0.3 9; then
  [ "$MODE" != deliver ] || exit 75
  : > "$STATE/dropped.$(uuid)"; exit 0
fi
trap 'rm -f "$STATE/request.$$" "$STATE/response.$$" "$STATE/response-headers.$$" "$STATE/header.$$"' EXIT HUP INT TERM
BOOT=$(cat /proc/sys/kernel/random/boot_id)
fingerprint() {
  [ -r "/proc/$1/stat" ] || return 1
  sed 's/^.*) //' "/proc/$1/stat" | awk -v boot="$BOOT" -v pid="$1" '{print boot ":" pid ":" $20}'
}
find_pid() {
  p=$PPID; i=0
  while [ "${p:-0}" -gt 1 ] && [ "$i" -lt 12 ]; do
    comm=$(cat "/proc/$p/comm" 2>/dev/null || true)
    case $comm in claude*|codex*) printf '%s' "$p"; return ;; esac
    p=$(sed 's/^.*) //' "/proc/$p/stat" 2>/dev/null | awk '{print $2}')
    i=$((i+1))
  done
  printf '0'
}
queue_event() {
  runfile=$1; source=$2; data=$3
  seq=$(jq '.sequence+1' "$runfile")
  jq --argjson seq "$seq" '.sequence=$seq' "$runfile" | atomic "$runfile"
  eventid=$(uuid)
  jq --arg id "$eventid" --arg source "$source" --arg installation "$INSTALLATION" --argjson data "$data" --argjson time "$(now)" \
    '{kind:"event",event:{event_id:$id,installation_id:$installation,execution_id,run_id,run_generation,sequence,agent,native_session_id,source_event:$source,observed_at:$time,data:$data}}' \
    "$runfile" | atomic "$STATE/outbox/$(date +%s%N).$eventid.json"
}
mark_dropped() { : > "$STATE/dropped.$(uuid)"; }
prune() {
  find "$STATE/outbox" -name '*.json' -mtime +6 -print | while IFS= read -r f; do rm -f "$f"; mark_dropped; done
  size=$(du -sk "$STATE/outbox" | awk '{print $1}')
  while [ "$size" -gt 32768 ]; do
    find "$STATE/outbox" -name '*.json' -print | sort | head -n 128 | while IFS= read -r f; do rm -f "$f"; mark_dropped; done
    size=$(du -sk "$STATE/outbox" | awk '{print $1}')
  done
  find "$STATE/quarantine" -type f -mtime +6 -delete
}
post() {
  endpoint=$1; payloadfile=$2; budget=$3
  if [ "$endpoint" = /v1/presence ]; then
    # Compare accounting/liveness facts, not newly generated timestamps/sequences.
    # Commit only acknowledgements; failed observations are always retried freshly.
    presence_summary=$(jq -Sc --arg installation "$INSTALLATION" '. + {installation:$installation} | del(.observed_at) | .runs |= map(del(.sequence))' "$payloadfile")
    if [ -f "$STATE/presence-last-shell.json" ] &&
      jq -e --argjson summary "$presence_summary" --argjson time "$(now)" \
        '.summary==$summary and .observed_at<=$time and (($summary.runs|length)==0 or $time-.observed_at<300000)' \
        "$STATE/presence-last-shell.json" >/dev/null; then
      result=200
      return
    fi
  fi
  header="$STATE/header.$$"
  printf 'Authorization: Bearer %s\n' "$(cat "$CONFIG/write.token")" > "$header"
  result=$(curl --silent --show-error --connect-timeout "$budget" --max-time "$budget" \
    --header "@$header" --header 'Content-Type: application/json' --data-binary "@$payloadfile" \
    --dump-header "$STATE/response-headers.$$" --output "$STATE/response.$$" --write-out '%{http_code}' "$URL$endpoint" 2>/dev/null) || result=000
  rm -f "$header"
  if [ "$endpoint" = /v1/presence ] && [ "$result" = 200 ]; then
    jq --argjson summary "$presence_summary" '{observed_at,summary:$summary}' "$payloadfile" | atomic "$STATE/presence-last-shell.json"
  fi
}
schedule_retry() {
  attempts=$(cat "$STATE/attempts" 2>/dev/null || printf '0'); attempts=$((attempts+1))
  [ "$attempts" -le 6 ] || attempts=6
  delay=$((2 << attempts))
  retry=$(awk 'tolower($1)=="retry-after:" {gsub("\r", "", $2); print $2}' "$STATE/response-headers.$$" 2>/dev/null || true)
  case $retry in ''|*[!0-9]*) ;; *) [ "$retry" -le 3600 ] || retry=3600; [ "$retry" -le "$delay" ] || delay=$retry ;; esac
  jitter=$(od -An -N1 -tu1 /dev/urandom | tr -d ' ')
  printf '%s' "$(( $(date +%s) + delay + jitter % 5 ))" > "$STATE/retry-at"
  printf '%s' "$attempts" > "$STATE/attempts"
}
flush() {
  limit=$1; budget=$2
  deadline=$(( $(date +%s) + 90 ))
  flock -u 9
  exec 8>"$STATE/flush.lock"
  flock -n 8 || { [ "$MODE" != deliver ] || exit 75; return 0; }
  [ ! -f "$STATE/retry-at" ] || [ "$(cat "$STATE/retry-at")" -le "$(date +%s)" ] || return 0
  sent=0
  for f in "$STATE"/outbox/*.json; do
    [ -f "$f" ] || break
    [ "$(date +%s)" -lt "$deadline" ] || break
    sent=$((sent+1)); [ "$sent" -le "$limit" ] || break
    kind=$(jq -r '.kind' "$f")
    if [ "$kind" = event ]; then endpoint=/v1/events; jq '{schema_version:1,events:[.event]}' "$f" > "$STATE/request.$$"
    else endpoint=/v1/usage; jq '{schema_version:1,records:(.records//[.record])}' "$f" > "$STATE/request.$$"; fi
    post "$endpoint" "$STATE/request.$$" "$budget"
    case $result in
      200)
        if ! jq -e --slurpfile request "$STATE/request.$$" '.accepted as $a | ($a|type)=="array" and
          ($request[0] | [(.events[]?.event_id),(.records[]?.native_record_id)] | all(.[]; . as $id | ($a|index($id))!=null))' "$STATE/response.$$" >/dev/null 2>&1; then
          printf '%s' "$(( $(date +%s) + 30 ))" > "$STATE/retry-at"; break
        fi
        rm -f "$f" "$STATE/retry-at" "$STATE/attempts"
        [ "$MODE" != deliver ] || : > "$STATE/presence-pending" ;;
      400|403|410|413|415) mv "$f" "$STATE/quarantine/$(basename "$f")"; mark_dropped ;;
      409)
        if [ "$kind" = usage ] && jq -e '.error=="run not yet ingested"' "$STATE/response.$$" >/dev/null 2>&1; then continue; fi
        mv "$f" "$STATE/quarantine/$(basename "$f")"; mark_dropped ;;
      *)
        schedule_retry
        break ;;
    esac

  done
}
case $MODE in
  hook)
    [ "$#" -eq 3 ] || exit 0
    safe=$(head -c 1048576 | jq -c '{session_id:(.session_id//.sessionId),cwd,model,transcript_path,source,notification_type,
      notification_category:(if ((.message//"")|ascii_downcase|test("permission|approve|confirm")) then "permission_prompt"
      elif ((.message//"")|ascii_downcase|test("waiting|input|idle")) then "idle_prompt" else null end)}') || exit 0
    sid=$(printf '%s' "$safe" | jq -er '.session_id | select(type=="string" and length>0)') || exit 0
    pid=$(find_pid); fp=$(fingerprint "$pid" 2>/dev/null || printf 'unknown:%s:%s' "$2" "$sid")
    key=$(printf '%s' "$fp" | sha256sum | cut -d ' ' -f1); file="$STATE/runs/$key.json"
    if [ ! -f "$file" ]; then
      jq -n --arg execution "$(uuid)" --arg fp "$fp" --arg agent "$2" --argjson pid "$pid" \
        '{execution_id:$execution,fingerprint:$fp,agent:$agent,pid:$pid,sequence:0,run_generation:0}' | atomic "$file"
    fi
    if [ "$(jq -r '.native_session_id//""' "$file")" != "$sid" ] || [ "$(jq -r '.closed//false' "$file")" = true ]; then
      oldrun=$(jq -r '.run_id//empty' "$file")
      if [ -n "$oldrun" ]; then cp "$file" "$STATE/history/$oldrun.json"; fi
      jq --arg sid "$sid" --arg run "$(uuid)" '.native_session_id=$sid|.run_id=$run|.run_generation+=1|.closed=false|.asking=false|.transcript=null' "$file" | atomic "$file"
    fi
    transcript=$(printf '%s' "$safe" | jq -r '.transcript_path//empty')
    if [ -z "$transcript" ] && [ "$2" = codex ]; then
      transcript=$(find "${CODEX_HOME:-$HOME/.codex}/sessions" -type f -name "*${sid}*.jsonl" -print -quit 2>/dev/null || true)
    fi
    size=0; [ ! -f "$transcript" ] || size=$(stat -c %s "$transcript")
    jq --arg path "$transcript" --arg source "$3" --argjson size "$size" --argjson safe "$safe" \
      '.transcript=(if $path!="" then $path else .transcript end)|.cwd=$safe.cwd|.model=$safe.model|
      .asking=(if $source=="PermissionRequest" or $safe.notification_type=="permission_prompt" or $safe.notification_category=="permission_prompt" then true
       elif $source=="UserPromptSubmit" or $source=="Stop" or $source=="SessionEnd" then false else (.asking//false) end)|
      .attention_size=(if .asking then $size else 0 end)' "$file" | atomic "$file"
    data=$(printf '%s' "$safe" | jq -c --argjson pid "$pid" '{cwd,model,source,pid:$pid,notification_type:(.notification_type//.notification_category)}')
    queue_event "$file" "$3" "$data"
    if [ "$3" = SessionEnd ]; then jq '.closed=true' "$file" | atomic "$file"; fi
    # The systemd path watcher drains this durable queue outside hook timeouts.
    [ ! -f "$CONFIG/background-upload" ] || exit 0
    # A hook can verify its own ancestor immediately; never replay this evidence.
    # Keep a private copy because flushing may read other queued runs first.
    hook_run=$(jq -c '{run_id,execution_id,sequence}' "$file")
    hook_fp=$fp; hook_pid=$pid; hook_source=$3
    prune; flush 1 1
    if [ "$hook_source" != SessionEnd ] && [ "$hook_pid" -gt 0 ] &&
      [ "$(fingerprint "$hook_pid" 2>/dev/null || true)" = "$hook_fp" ]; then
      usage_ready=false; [ ! -f "$STATE/usage-ready" ] || usage_ready=true
      [ "$(find "$STATE/outbox" -name '*.json' | wc -l)" -eq 0 ] || usage_ready=false
      jq -n --argjson run "$hook_run" --argjson time "$(now)" --argjson usage "$usage_ready" \
        --argjson dropped "$(find "$STATE" -maxdepth 1 -name 'dropped.*' | wc -l)" \
        '{schema_version:1,observed_at:$time,runs:[$run],usage:$usage,dropped:$dropped}' > "$STATE/request.$$"
      post /v1/presence "$STATE/request.$$" 1
    fi ;;
  deliver)
    [ ! -f "$STATE/retry-at" ] || [ "$(cat "$STATE/retry-at")" -le "$(date +%s)" ] || exit 75
    prune; flush 64 10
    if [ -f "$STATE/presence-pending" ]; then
      # Observe processes now; queued events are never evidence of liveness.
      flock -w 1 9 || exit 75
      delivery_presence="$STATE/delivery-presence.$$"
      : > "$delivery_presence"
      delivery_observed=$(now)
      for file in "$STATE"/runs/*.json; do
        [ -f "$file" ] || continue
        [ "$(jq -r '.closed//false' "$file")" = false ] || continue
        pid=$(jq -r '.pid' "$file")
        [ "$pid" -gt 0 ] || continue
        [ "$(fingerprint "$pid" 2>/dev/null || true)" = "$(jq -r '.fingerprint' "$file")" ] || continue
        jq '.sequence+=1' "$file" | atomic "$file"
        jq -c '{run_id,execution_id,sequence}' "$file" >> "$delivery_presence"
      done
      flock -u 9
      usage_ready=false; [ ! -f "$STATE/usage-ready" ] || usage_ready=true
      [ "$(find "$STATE/outbox" -name '*.json' | wc -l)" -eq 0 ] || usage_ready=false
      jq -sc --argjson time "$delivery_observed" --argjson usage "$usage_ready" --argjson dropped "$(find "$STATE" -maxdepth 1 -name 'dropped.*' | wc -l)" \
        'range(0; ([length,1]|max);128) as $i | {schema_version:1,observed_at:$time,runs:.[$i:$i+128],usage:$usage,dropped:$dropped}' "$delivery_presence" > "$delivery_presence.batches"
      delivered=true
      while IFS= read -r batch; do
        printf '%s' "$batch" > "$STATE/request.$$"
        post /v1/presence "$STATE/request.$$" 10
        [ "$result" = 200 ] || { schedule_retry; delivered=false; break; }
      done < "$delivery_presence.batches"
      rm -f "$delivery_presence" "$delivery_presence.batches"
      [ "$delivered" != true ] || rm -f "$STATE/presence-pending"
    fi
    # systemd retries while work remains; flush still honors server Retry-After.
    [ ! -f "$STATE/presence-pending" ] || exit 75
    [ "$(find "$STATE/outbox" -name '*.json' | wc -l)" -eq 0 ] || exit 75
    ;;
  flush) prune; flush 64 10 ;;
  status)
    jq -n --arg installation "$INSTALLATION" --argjson queued "$(find "$STATE/outbox" -name '*.json' | wc -l)" \
      --argjson quarantined "$(find "$STATE/quarantine" -name '*.json' | wc -l)" --argjson dropped "$(find "$STATE" -maxdepth 1 -name 'dropped.*' | wc -l)" \
      '{installation:$installation,queued:$queued,quarantined:$quarantined,dropped:$dropped}' ;;
  reconcile)
    presence_file="$STATE/presence.ndjson"; : > "$presence_file"
    presence_observed=$(now)
    for file in "$STATE"/runs/*.json; do
      [ -f "$file" ] || break
      pid=$(jq -r '.pid' "$file")
      if [ "$(jq -r '.closed//false' "$file")" != true ] && [ "$pid" -gt 0 ]; then
        current=$(fingerprint "$pid" 2>/dev/null || true)
        if [ "$current" != "$(jq -r '.fingerprint' "$file")" ]; then
          queue_event "$file" SessionEnd '{"reason":"process_gone"}'
          jq '.closed=true|.asking=false' "$file" | atomic "$file"
        else
          jq '.sequence+=1' "$file" | atomic "$file"
          jq -c '{run_id,execution_id,sequence}' "$file" >> "$presence_file"
          path=$(jq -r '.transcript//empty' "$file")
          if [ "$(jq -r '.asking//false' "$file")" = true ] && [ -f "$path" ] && [ "$(stat -c %s "$path")" -gt "$(jq '.attention_size//0' "$file")" ]; then
            queue_event "$file" AttentionCleared '{"reason":"transcript_growth"}'
            jq '.asking=false' "$file" | atomic "$file"
          fi
        fi
      fi
    done
    flock -u 9
    "$ROOT/usage.sh" "$STATE"
    prune; flush 64 10
    usage_ready=false; [ ! -f "$STATE/usage-ready" ] || usage_ready=true
    [ "$(find "$STATE/outbox" -name '*.json' | wc -l)" -eq 0 ] || usage_ready=false
    # Slow scans/uploads cannot turn an old observation into fresh evidence.
    if [ "$(( $(now) - presence_observed ))" -ge 120000 ]; then
      : > "$presence_file"; presence_observed=$(now)
    fi
    jq -sc --argjson time "$presence_observed" --argjson usage "$usage_ready" --argjson dropped "$(find "$STATE" -maxdepth 1 -name 'dropped.*' | wc -l)" \
      'range(0; ([length,1]|max);128) as $i | {schema_version:1,observed_at:$time,runs:.[$i:$i+128],usage:$usage,dropped:$dropped}' "$presence_file" > "$STATE/presence-batches.$$"
    while IFS= read -r batch; do
      printf '%s' "$batch" > "$STATE/request.$$"
      post /v1/presence "$STATE/request.$$" 2
    done < "$STATE/presence-batches.$$"
    rm -f "$STATE/presence-batches.$$"
    ;;
  *) error 'unknown command' ;;
esac
