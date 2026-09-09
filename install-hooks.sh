#!/bin/sh
# Compatibility for existing install/uninstall commands, including local mode.
root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
exec python3 "$root/reporters/shell/install-hooks.py" --compat "$@"
