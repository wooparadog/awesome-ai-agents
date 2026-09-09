#!/bin/sh
# Drop a Claude Code / Codex hook payload where the AwesomeWM widget can see it.
#
#   hook.sh <agent> <EventName>          payload arrives on stdin as JSON
#
# Registered from ~/.claude/settings.json and ~/.codex/hooks.json — run
# the repository-root install-hooks.sh to do that for you. The payload is written through
# byte-for-byte; the agent name, the event and the owning CLI's pid ride in the
# *filename* instead, so this script never has to build or edit JSON (no jq).
#
# Writes land in $XDG_RUNTIME_DIR (tmpfs): no disk wear, and nothing survives a
# reboot to leave the widget showing sessions that died with the last X session.

agent=$1
event=$2

# Must match the widget's `event_dir` (same default on both sides).
dir=${AI_AGENTS_EVENT_DIR:-${XDG_RUNTIME_DIR:-/tmp}/ai-agents}
mkdir -p "$dir" || exit 0

# Walk up from this script to the CLI process that invoked the hook. The widget
# uses that pid for liveness (a kill -9'd agent never fires SessionEnd) and to
# find the terminal window to focus on click. pid 0 means "couldn't tell" — the
# widget then keeps the session until SessionEnd rather than reaping it blind.
pid=$PPID
found=0
i=0
while [ "${pid:-0}" -gt 1 ] && [ "$i" -lt 8 ]; do
  case "$(cat "/proc/$pid/comm" 2>/dev/null)" in
    claude* | codex*)
      found=1
      break
      ;;
  esac
  pid=$(awk '{print $4}' "/proc/$pid/stat" 2>/dev/null)
  i=$((i + 1))
done
[ "$found" = 1 ] || pid=0

f=$dir/$agent.$event.$pid.$(date +%s%N)
cat > "$f.tmp" && mv "$f.tmp" "$f.json"
exit 0
