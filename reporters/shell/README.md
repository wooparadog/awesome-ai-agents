# Shell reporter

Report Claude Code and Codex activity to the collector from Linux machines.
Runtime dependencies: POSIX shell, `curl`, `jq`, GNU coreutils, `flock`, and `/proc`.
The hook installer additionally requires Python 3. No AwesomeWM or Lua is needed.

First [run the collector and provision a write token](../../collector/README.md)
for this installation. From the repository root:

```sh
python3 reporters/shell/install-hooks.py \
  --cloud-url https://your-collector.example \
  --installation-id desktop \
  --token-file /path/to/credential.token \
  --timer
```

Use `http://127.0.0.1:8787` for a local collector. All other connections require
HTTPS. The token file must match the installation configured on the server.
The installer merges hook entries, preserves other tools' hooks, and backs up
existing configuration. `--dry-run` previews changes without writing files.
Reinstalling recognizes hook entries from the old repository layout.

The optional `--timer` installs and enables a systemd user timer for reconciliation.
Without it, reporting is driven by hooks, and pending events wait for a subsequent
hook or a manual flush. Codex may ask you to trust the updated hook configuration.

To configure the reporter without the Python installer:

```sh
reporters/shell/reporter.sh init https://your-collector.example desktop /path/to/credential.token
```

Register `reporters/shell/hook.sh <agent> <EventName>` with the agent, supplying the
native JSON payload on stdin. The installer contains the supported event lists.
Hooks send no stdout and always exit successfully, even when reporting fails.

## Commands and state

```sh
reporters/shell/reporter.sh status
reporters/shell/reporter.sh flush
reporters/shell/reporter.sh reconcile
```

`flush` retries queued events. `reconcile` also observes known processes, detects
transcript activity that can clear attention, and extracts usage metadata. Run it
every 30 seconds through the supplied timer or a scheduler of your choice.

Configuration and private credentials live in `${XDG_CONFIG_HOME:-$HOME/.config}/ai-agents`;
durable outbox, process identities, and transcript cursors live in
`${XDG_STATE_HOME:-$HOME/.local/state}/ai-agents`. `AI_AGENTS_CONFIG_DIR` and
`AI_AGENTS_STATE_DIR` override those directories. A custom scheduler must pass
the same overrides. A copied installation needs its own server identity and token.

The outbox has a seven-day retry horizon and a 32 MiB capacity target. Quarantined
or dropped records mark usage coverage incomplete. A transcript that was never
observed by a hook is not automatically imported. Malformed or oversized JSONL
records are skipped with incomplete-coverage diagnostics. Unknown process identity
is reported as unverified; transcript growth is a heuristic for clearing attention.
Windows and macOS are not supported by this reporter yet.

## Uninstall and tests

```sh
python3 reporters/shell/install-hooks.py --uninstall --timer
python3 -m unittest discover -s reporters/shell/tests -v
shellcheck reporters/shell/*.sh
```

Uninstall removes registered hooks and, with `--timer`, the scheduler. It preserves
credentials and pending data. The old root `install-hooks.sh` remains a compatibility
entry point for previous installations, including AwesomeWM's local mode; new
collector installations use the component installer above.
