#!/bin/sh
# Agent hooks report to the collector; reporting must never block execution decisions.
root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
"$root/reporter.sh" hook "$@" >/dev/null 2>&1
exit 0
