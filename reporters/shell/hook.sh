#!/bin/sh
# Agent hooks report to the collector; reporting must never block execution decisions.
config=${AI_AGENTS_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/ai-agents}
if [ -r "$config/daemon-binary" ]; then
  IFS= read -r daemon < "$config/daemon-binary"
  if [ -x "$daemon" ]; then
    "$daemon" hook "$@" >/dev/null 2>&1
    exit 0
  fi
fi
root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
"$root/reporter.sh" hook "$@" >/dev/null 2>&1
exit 0
