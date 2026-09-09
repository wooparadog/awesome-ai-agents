#!/bin/sh
# Compatibility for previously registered hook commands.
root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
config=${AI_AGENTS_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/ai-agents}
if [ -f "$config/config.json" ]; then
  exec "$root/reporters/shell/hook.sh" "$@"
fi
exec "$root/clients/awesomewm/local-hook.sh" "$@"
