# Hosted deployment

The collector uses [ai.wooparadog.info](https://ai.wooparadog.info), with
[ai-agents-collector.stdimg.workers.dev](https://ai-agents-collector.stdimg.workers.dev) as an alias.
All application endpoints require authentication; opening the URL without a token returns 401.

| Resource | Value |
| --- | --- |
| Worker | `ai-agents-collector` |
| Deployed version | `39d15271-d036-42e4-a880-52dd198f0b71` |
| Initial deployment | 2026-09-09, 05:22 UTC |
| D1 database | `ai-agents` |
| D1 ID | `5104c85f-ece5-4bad-b122-6145081fd0b7` |
| Database region | APAC |
| Subscription class | `Subscriptions`, SQLite-backed, hibernating WebSockets |
| Notification recovery backstop | Hourly; normal publication is immediate |
| Retention work | At most hourly, bounded indexed batches |
| Machine reconciliation | At least five minutes between runs |
| Presence freshness | Ten minutes |
| Workspace | `personal` |
| Initial reporter installation | `desktop` |

The account and database identifiers are recorded in `collector/wrangler.jsonc`.
Local development and tests still use local storage unless remote operations are explicitly requested.

## September 9 quota outage and statistics migration

D1 exhausted its free daily row-read quota on September 9. The old usage query
alone accounted for 4,631,006 reads across 263 executions in query insights.
Database access resumed after the September 10 reset, and the scheduled job
applied migration `0009_compact_statistics.sql` at 08:01 Asia/Singapore.

The backfill initially failed because remote Wrangler `--file --json` uses the
SQL import endpoint, which emits progress and returns an import summary rather
than SELECT rows. `compact-usage.mjs` now uses `--command --json` with argument
arrays. The repaired job completed at **10:13:58 Asia/Singapore**, reading 456,753
rows and writing 11,534 rows for the one-time backfill. A repeat invocation
confirmed initialization and exited without repeating the backfill.

Authenticated snapshots return HTTP 200 on both collector domains, and the live
AwesomeWM widget on `yoga-arch` reconnected. Direct production checks of today's
global and active-session statistics queries read 3 and 5 rows respectively.
The completed one-time timer is disabled. No billing settings were changed.

The tested files are copied outside the working tree under:

```text
~/.local/share/ai-agents/maintenance/compact-statistics-20260909/
```

The job applies migrations, runs `compact-usage.mjs`, and checks an authenticated
snapshot. Inspect its progress with:

```sh
systemctl --user status ai-agents-compact-statistics.timer
journalctl --user -u ai-agents-compact-statistics.service
```

Reporter queues retain pending records during outages. To monitor ongoing cost, inspect `snapshot_read_cost` and
`usage_write_cost` in Worker logs and D1 query insights. The local 5,001-record
benchmark measured four reads for statistics and ten for the full snapshot data
batch. See [statistics design](statistics.md) for the seven-day detailed-data and
30-day summary retention policy.

## Credentials and connecting clients

Initial credentials were generated privately on the deploying machine under:

```text
~/.config/ai-agents/collector/production/
  reader/credential.token       read access for viewers
  reader/identity.json
  desktop/credential.token      write access bound to installation desktop
  desktop/identity.json
```

Token files have mode 0600 and are not in the repository. The database contains only token hashes.
Use the read token with a viewer and the desktop write token with the `desktop` reporter installation.
Provision separate write credentials for additional installations rather than copying one machine's identity.

Deployment does not install hooks, change the desktop widget, or enable a local reconciliation timer.
See the [reporter guide](../reporters/rust/README.md) and
[AwesomeWM client guide](../clients/awesomewm/README.md) for those steps.

## Publishing updates

From `collector/`, after reviewing changes and running checks:

```sh
pnpm check
pnpm test
pnpm exec wrangler deploy --dry-run
pnpm exec wrangler d1 migrations apply ai-agents --remote
pnpm exec wrangler deploy
node scripts/compact-usage.mjs --remote
```

For additional credentials, the provisioner generates a private SQL file without changing the database
unless `--local` is supplied. Apply the generated SQL to the intended remote database explicitly:

```sh
pnpm provision --workspace personal --installation another-machine \
  --scope write --output /private/new-credential-directory
pnpm exec wrangler d1 execute ai-agents --remote \
  --file /private/new-credential-directory/provision.sql
```

The first remote migration exposed a parsing difference between local execution and D1's remote SQL endpoint.
Migration `0001.sql` now parenthesizes `CASE` expressions to keep trigger bodies intact.
All four migrations applied successfully; the collector tests include a regression check for swallowed DDL statements.

On September 9, migrations `0005_codex_responses.sql`, `0006_astra_prices.sql`,
`0007_claude_usage_duplicates.sql`, and `0008_codex_response_cutover.sql` were also applied remotely. They recover exact
Codex response accounting, add published Astra API estimates, and tolerate repeated
Claude content-block timestamps without double counting. Updated reporters are
installed on Desktop, `yoga-arch`, and `karry`. The Worker now checks each distinct
run's ownership once per usage request, avoiding repeated database round trips
for batches from the same transcript. Earlier cumulative history is retained when
a thread spans an upgrade to per-response records.

Before the quota outage, live verification on `yoga-arch` confirmed the running AwesomeWM widget receives
three live sessions, zero stale/unverified sessions, complete usage coverage, and
priced totals for both agents. All three reporter outboxes and quarantine queues
were empty; recovered Claude warning markers were archived after acknowledgement.

## Immediate background delivery

On September 10, Desktop, `yoga-arch`, and `karry` were updated with
`ai-agents-upload.path` and `ai-agents-upload.service`. Hooks now queue locally;
the path watcher starts uploads immediately, using ten-second request timeouts
and retrying pending work independently of the five-minute reconciliation timer.
Existing proxy environment drop-ins are also installed for the uploader.

A live Desktop hook returned in 0.093 seconds and its updated activity timestamp
reached the running Yoga AwesomeWM client in 3.001 seconds. Token usage extraction
remains on the five-minute reconciliation schedule. Reporter validation passed
20 tests plus ShellCheck and systemd unit verification.

On September 10, `rain` was added with its own installation-scoped write token,
Codex-only hooks, immediate background delivery, and the reconciliation timer.
Its reporter reaches the custom collector domain directly. The initial presence
was visible in the Yoga client with usage capability enabled; an end-only hook
probe confirmed the outbox drains through the background uploader.

## Verification

The deployed service passed these checks:

- Missing credentials return 401; write credentials cannot read snapshots (403).
- A read credential returns the initialized personal workspace (200).
- Authenticated WebSocket upgrade returns 101 and the `ready` message.
- Text `ping` receives the runtime's `pong` response.
- After an idle interval, lifecycle ingestion, duplicate retry, fresh presence, and usage ingestion succeed
  and produce a WebSocket invalidation and updated snapshot in an isolated verification workspace.

The verification workspace and its credentials were removed after testing. These checks verify live connectivity
and notification behavior; they do not measure billing or directly observe the runtime's internal hibernation decisions.

This machine requires its outbound HTTPS proxy to reach the hosted WebSocket. The default GLib proxy resolver
failed its direct TLS connection, so the live WebSocket check explicitly used the existing proxy.
The unmodified AwesomeWM smoke test did not connect with that default resolver; configure the desktop's proxy
resolver before using it from this network. No TLS verification was disabled.

The repository was not pushed as part of deployment.

## Rust daemon rollout (2026-09-10)

The preceding background-uploader work was saved in local commit `1ffcdd1` before
starting the daemon rewrite. At approximately 11:22 Singapore time, ArchDell,
YogaArch, Karry, and Rain were running `~/.local/bin/ai-agents daemon` under one
`ai-agents.service` each. The legacy reconciliation timers and upload path
watchers were disabled. Existing credentials, run identities, outboxes, and
transcript cursors were reused; Rain retained Codex-only hook registration.

The updated legacy hook shim forwards cached hook commands to the Rust binary.
Desktop and Karry retain their existing proxy environment files through migrated
service drop-ins. All four queues were empty after migration, with zero new
quarantined records, and Yoga's connected viewer received their presence reports.
Desktop still reports incomplete coverage for its pre-existing missing transcript;
the daemon does not treat unavailable evidence as complete usage.

The Desktop canary exposed archived shell runs retaining old execution sequence
counters. The fix closes archived records locally without emitting lifecycle
events: the collector already supersedes those generations. A regression test
covers the migration. The seven rejected canary-generated events and their
matching diagnostic markers were moved to the private local directory
`~/.local/state/ai-agents/maintenance/rust-canary-20260910`; no usage evidence was
removed. The corrected binary was installed before migrating the other machines.

The release binary measured 2.9 MB; an isolated local test measured 1.6 ms median
hook latency, 2.7 ms p95, 4,680 KiB daemon RSS, one thread, and no additional HTTP
requests or measurable CPU time over a 35-second idle sample. After connecting to production, RSS across the four
machines ranged from 5,760 to 6,260 KiB (about 5.6–6.1 MiB). See the
[daemon guide](../reporters/rust/README.md) for timing, state bounds, and rollback.


## Web panel and CLI rollout (2026-09-10)

The shared systemd units and Linux guide were committed locally as `a3e5424`
before beginning this feature. Applied `0010_browser_access.sql` to production
D1, then deployed Worker version `d3483d5a-f936-4571-acd9-dc8a86bd790c` with its
four static web assets. The public homepage is available on the custom domain
and workers.dev hostname, with CLI login instructions.

Updated the Rust binary on ArchDell, YogaArch, Karry, and Rain. `ai-agents status`
now prints a readable summary; `status --json` retains machine-readable output.
`ai-agents web --expires 10m` creates a single-use login link. Each remote copied
installation now also includes the versioned `systemd/` assets beside `install.py`;
all four services use the shared user unit and retain their existing proxy drop-ins.
Rain remains Codex-only.

Karry's proxy previously existed only in its systemd environment. Added the same
proxy as `proxy_url` in its private reporter configuration so both CLI and daemon
can use it; the previous file is `~/.config/ai-agents/config.json.before-web-proxy`.
The shared HTTP client respects NO_PROXY exclusions. Verified link generation on
all four machines. Short-lived verification links were allowed to expire.

A live Chromium verification generated a link through the installed CLI, redeemed
it, confirmed removal of the URL fragment, and received a live snapshot showing
all four machines. Reload preserved browser access. Sign-out revoked that test
browser credential and cleared localStorage. No JavaScript errors were observed.
The verification used this machine's existing HTTPS proxy with normal TLS checks.

Validation passed: collector type checks and 27 runtime tests, four Rust unit
tests, 20 Rust-reporter/CLI/installer integration tests, 22 legacy reporter tests,
ShellCheck, Lua/client checks, and five Chromium end-to-end tests. Browser tests
cover live usage without idle polling, login persistence, consumed links, logout,
metadata injection, filtering, mobile overflow, and outage recovery. Worker
packaging dry-run also passed.


## Pricing and idle workload rollout (2026-09-11)

Deployed Worker version `fa3f752b-22b0-467d-8143-3a92226eac90` to
`https://ai.wooparadog.info` with migrations `0013_accurate_pricing.sql` and
`0014_idle_workload.sql`. The maintenance/recovery schedule is hourly. Empty idle
reporters suppress repeated acknowledgements, presence publication is coalesced,
and hidden browser tabs pause subscriptions. Live-process leases remain unchanged.
The existing token-management functionality was preserved during deployment;
its pre-existing working-tree changes are not part of the pricing/workload commit.

Reset the `personal` workspace's telemetry at `1789100520357` milliseconds
(2026-09-11 04:22:00.357 UTC). The transactional reset preserved credentials,
installations and live run identities. Pre-reset usage replay is ignored.

Updated and restarted the reporters on ArchDell, YogaArch and Karry. All three
run the release binary with SHA-256
`a0d6177dbf98185303f12f811205e1d93aeee695b65cb412a113aea47c9772c2`.
The prior binary is retained as `~/.local/bin/ai-agents.before-pricing-idle-20260911`.
Rain could not be resolved and Jackson's SSH connection timed out, so their
reporter upgrades remain pending; rerun deployment when those hosts are reachable.

The first migration attempt encountered the remote D1 parser's unparenthesized
`SELECT CASE` limitation. The deployment command that followed was rolled back to
`644a2382-3a20-4197-adb4-857bcfe9a20b`. After parenthesizing the expression and adding
a regression check, both migrations succeeded remotely before the final deployment.
The failed migration was verified to have rolled back its schema changes.

Validation included 52 collector tests, 10 browser tests, 8 Rust unit tests,
22 reporter integration tests, 25 shell tests, Clippy, formatting, release and
Worker packaging checks, and 191 matching pricing-feed comparisons. The scoped
commit separately passed 44 collector tests without unrelated token-management
edits. The browser idle test advances thirty minutes while hidden and verifies
no requests; the reporter idle test covers eight simulated hours plus restart
and live-process renewal behavior.
