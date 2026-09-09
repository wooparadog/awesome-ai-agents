#!/bin/sh
# All component checks, run from any working directory. No remote operations.
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
(
  cd collector
  pnpm check
  pnpm test
)
python3 -m unittest discover -s reporters/shell/tests -v
shellcheck hook.sh install-hooks.sh reporters/shell/*.sh clients/awesomewm/local-hook.sh scripts/check.sh
stylua --config-path clients/awesomewm/stylua.toml --check init.lua clients/awesomewm
lua5.4 clients/awesomewm/tests/cloud_state.lua
lua5.4 clients/awesomewm/tests/entrypoints.lua
