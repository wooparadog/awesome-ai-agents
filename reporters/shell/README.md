# Shell reporter

New installations should use the [Rust daemon](../rust/README.md), which replaces
this runtime and its timer/path units. This implementation remains for migration
and rollback. The hook shim forwards to Rust when `config/daemon-binary` is set.

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
Reinstalling recognizes hook entries from the old repository layout. Add
`--agent codex` or `--agent claude` to install or remove hooks for only that agent;
the other agent’s configuration is left untouched.

The optional `--timer` installs a systemd path watcher for immediate background
uploads, plus the five-minute reconciliation timer. Hooks write events to the
local outbox and return without network requests. The path watcher starts
`ai-agents-upload.service` whenever queued work exists, including after login.
The uploader drains events and sends freshly checked process presence so sessions
can become verified immediately. It retries unfinished work after five seconds,
honoring the longer retry delay recorded after network or server failures.
Without these units, hooks retain the one-second direct upload fallback; queued
work then waits for another hook or a manual flush. Codex may ask you to trust
the updated hook configuration.

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
no more often than every five minutes through the supplied timer or a scheduler of your choice.

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

Scheduled and manual flushes allow ten seconds per request and stop starting new
requests after ninety seconds. Pending batches retain their IDs for retry. Coverage
remains incomplete until the observed transcripts are caught up and the outbox is
acknowledged. Background delivery uses the same ten-second request budget, outside
the agent's hook timeout. Token usage still comes from five-minute reconciliation;
the immediate uploader does not rescan transcripts.

If network access requires a systemd `EnvironmentFile` or other proxy settings,
configure both `ai-agents-reconcile.service` and `ai-agents-upload.service` with
the same environment. The installer preserves their existing drop-ins.
Inspect delivery with `journalctl --user -u ai-agents-upload.service` and
`systemctl --user status ai-agents-upload.path`. The uploader exits when the
queue and pending presence are acknowledged; idle machines make no extra requests.

Reconciliation retries Codex transcript discovery if the file was not available
when the hook fired, including archived sessions. Closed runs that never supplied
or produced a transcript (for example installation probes) do not block coverage
of observed transcripts. A missing known transcript still marks coverage incomplete.

Modern Codex `token_usage_record` entries report exact per-response usage. Response
IDs deduplicate retries and copied transcripts, and retain the first request's
tokens and model changes. Transcript cursors are scoped to each run: resuming a
session in a new process replays its usage for the new run without increasing
workspace totals for records already collected. Older transcripts still use cumulative counters with
an unknown initial baseline. On upgrade, Codex cursors replay once automatically;
apply collector migration `0005_codex_responses.sql` before upgrading reporters
so response records replace legacy estimates without double counting.

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

Closed executions finish one complete transcript scan and then stop reading new
content from that path. A resumed execution has its own cursor and remains active.
Closed local run records older than seven days are outside the cloud evidence
window. The collector acknowledges older usage without storing it; full transcript
history remains local, while cloud daily summaries last 30 days.
