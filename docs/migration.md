# Migration to the collector-focused layout

## Shell reporter to Rust daemon

The current reporting implementation is the [Rust daemon](../reporters/rust/README.md).
Build it, then run `python3 reporters/rust/install.py --service`. This replaces
registered hooks and disables the old timer/path units. Existing run identities,
credentials, queues, and usage cursors are reused. The daemon owns scheduling,
collection, reconciliation, and delivery. The installer uses the versioned
[`ai-agents.service`](../reporters/rust/systemd/ai-agents.service); include its
`systemd/` directory when copying the installer to another host. Follow the
[Linux systemd guide](linux-systemd.md) for service setup and boot behavior, and
the daemon guide for Codex trust, custom supervisors, and rollback.

## Earlier repository layout migration


The collector protocol, database bindings, credentials, configuration directories,
and durable reporter state are unchanged. This refactor moves ownership and paths;
it does not require a new database or reissuing tokens.

| Previous path | Canonical path |
| --- | --- |
| `collector/` | `collector/` (unchanged) |
| `client/reporter.sh`, `client/usage.sh`, `client/usage.jq` | `reporters/shell/` |
| `install-hooks.sh` implementation | `reporters/shell/install-hooks.py` |
| Root Lua modules | `clients/awesomewm/` |
| `doc/screenshot.png` | `clients/awesomewm/assets/screenshot.png` |
| `doc/cloud-collector-design.md` | `docs/architecture.md` |
| `tests/test_*.py` | `reporters/shell/tests/` |
| `tests/*.lua` | `clients/awesomewm/tests/` |

## Existing AwesomeWM installations

`require("lib.ai")` still forwards to the AwesomeWM client. New configurations
should make the client explicit:

```lua
local ai_agents = require("lib.ai.clients.awesomewm")
```

The existing widget options and returned handle remain the same. Direct imports
of helpers such as `lib.ai.sessions` should now use
`lib.ai.clients.awesomewm.sessions`; compatibility is retained for the main entry
point, not every internal module.

## Previously registered hooks

The root `hook.sh` still works. It forwards to the shell reporter when cloud
configuration exists, and to the AwesomeWM client's legacy local transport when
it does not. The root `install-hooks.sh` also retains the previous install,
uninstall, and local-mode behavior.

For cloud installations, rerun the canonical installer to register the new path:

```sh
python3 reporters/shell/install-hooks.py --timer
```

It reuses the existing configuration, recognizes the old hook entries, and preserves
other tools' commands. Codex may request trust for the changed hook command.
Re-running with `--timer` also updates a reconciliation service that previously
pointed at `client/reporter.sh`. It is important to update that service: the old
`client/` directory is no longer present. Preview changes with `--dry-run`.

Update custom cron jobs, service files, scripts, and direct invocations to
`reporters/shell/reporter.sh reconcile`. Existing configuration and outbox paths
continue to work. No personal hook settings or running services are modified just
by checking out these file changes.

The Linux reporter and AwesomeWM viewer remain the implemented platform options.
Windows and macOS viewers are planned extensions; this refactor does not provide
native implementations of either viewers or reporters for those systems.
