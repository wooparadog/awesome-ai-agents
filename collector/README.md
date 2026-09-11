# Cloud collector

TypeScript Worker + D1 + one hibernating WebSocket Durable Object per workspace.
The reporter uses ordinary authenticated HTTP; the widget subscribes to revisions
and fetches snapshots only when needed. The HTTP API is independent of any particular desktop or viewer.

## Hosted collector

The collector is deployed at [ai-agents-collector.stdimg.workers.dev](https://ai-agents-collector.stdimg.workers.dev).
All application routes require a token; an unauthenticated request returns 401.
The configured D1 database is `ai-agents` in APAC, and the scheduled maintenance
trigger runs hourly. See [deployment details](../docs/deployment.md).

## Local development

Requires Node.js compatible with the locked Wrangler version and pnpm 11.

```sh
cd collector
pnpm install --frozen-lockfile
pnpm types
pnpm migrate:local
pnpm provision --workspace personal --installation desktop --label Desktop \
  --scope write --output /tmp/ai-agents-desktop --local
pnpm provision --workspace personal --scope read \
  --output /tmp/ai-agents-reader --local
pnpm dev --port 8787
```

Provisioning writes a private `credential.token`, `identity.json`, and SQL file.
It never prints the secret. Output files must not already exist. Without `--local`,
it only generates files; no database changes occur. Each reporter needs its own
installation and write credential. Widgets use read credentials. The provisioner
can generate revocation SQL with `--revoke TOKEN_ID --workspace personal --output DIR`;
add `--local` to apply to local D1. Revoked credentials immediately fail HTTP reads;
existing subscriptions are closed by revocation APIs and revalidated before new
invalidations after the five-minute authorization cache expires.

`wrangler.jsonc` now identifies the deployed account and D1 database. `pnpm dev`
and `pnpm migrate:local` still use local storage. Remote database operations require
an explicit `--remote` flag, and publishing code requires `wrangler deploy`. Clones
intended for another account must replace the account and database identifiers.
The test scripts do not use remote bindings or deploy resources.

## Connect reporters and clients

The collector has no dependency on AwesomeWM, Lua, or a reporter runtime.
Install a [reporter](../reporters/README.md) on each machine running coding agents,
and choose a [viewer client](../clients/README.md) for displaying their activity.
The [shell reporter guide](../reporters/shell/README.md) covers hook installation
and scheduling. The [AwesomeWM guide](../clients/awesomewm/README.md) covers the
currently available viewer.

Reporters reconcile at five-minute intervals; the collector allows a ten-minute
freshness window so healthy sessions remain live between reports.

Usage coverage and pricing are separate: unavailable model rates do not make
token collection incomplete. Codex response records supersede cumulative estimates
for the same thread while retaining the original evidence. Apply all migrations
before updating reporters; their first reconciliation replays Codex transcripts.

Token costs use the reviewed September 11, 2026 pricing catalog, including
per-request context tiers, cache writes, supported Fast/Batch/Flex rates, and
regional uplifts. Missing billing details remain marked estimated; unsupported
rates remain unpriced. These are API token costs, not subscription invoices.
See [pricing and repricing](../docs/pricing.md) for the metadata contract,
migration, retained-history rebuild, and price audit commands.

Future Windows and macOS clients use the same [public protocol](../docs/client-protocol.md).
They do not need to copy the AwesomeWM implementation or the Linux process helpers.

## Protocol and storage

- `POST /v1/events`: versioned, sanitized lifecycle events, max 16 per batch.
- `POST /v1/presence`: fresh process observations, max 128 runs, including empty
  machine heartbeats. Historical outbox replay cannot renew presence.
- `POST /v1/usage`: metadata-only usage evidence, max 64 records.
- `GET /v1/snapshot`: coherent state, revision, usage, coverage, and time boundaries.
- `GET /v1/subscribe`: authenticated WebSocket upgrade; `ready`, `state.changed`,
  client `ack` messages, and hibernation-compatible `ping` / `pong` auto-response.
- `GET /v1/sessions`: paginated runs; optional installation filter and cursor.
- `GET /v1/sessions/:run_id/events`: paginated diagnostic events.
- `GET /v1/usage?from=ISO&to=ISO`: daily statistics for whole reporting days within the last 30 days.

Private reporting/statistics routes require a scoped bearer token. The public
web shell explains CLI login, and one-time login/ticket endpoints support browser
access; see the [browser protocol](../docs/client-protocol.md#browser-login-and-subscriptions).
Request bodies are limited to 256 KiB.
Tokens are rate limited to 600 requests/minute. Persistent identity constraints
prevent cross-installation writes and conflicting retries. Triggers atomically
reduce new lifecycle events and increment the workspace revision. The notification
outbox commits in the same transaction; immediate publication plus a scheduled
retry drain covers Worker failures. The Durable Object durably accepts publication
before the outbox is acknowledged. Per-socket acknowledgements bound notification
queues. Neither HTTP success nor a socket send claims exactly-once delivery.

The schema is in `migrations/`. Usage ingestion atomically updates compact daily
buckets for the workspace and each observing run. Snapshots read those buckets;
they never reconstruct totals from transcript history. Retries and copied records
remain deduplicated. Legacy cumulative samples update only their own contribution
and the immediately following sample when they arrive out of order. Prices are
resolved when contributions are materialized and grouped by their rate set.
Unknown models remain unpriced. No prompts, responses, command arguments, tool
payloads, or transcript paths are uploaded.

Detailed usage and lifecycle events have a seven-day retention window. Daily
statistics are retained for 30 days. Cleanup runs at most hourly, in bounded,
indexed batches. One older cumulative baseline per stream may remain within the
30-day window. Closed-run metadata is stripped after seven days; ended identities
are removed after 30 days when no retained usage references them. Local transcripts
remain the source for longer-term history.

Usage older than seven days is acknowledged in both `accepted` and `ignored`
without being stored or recounted. This prevents old transcript replays from
reintroducing usage after its deduplication evidence has expired. Historical API
requests must align to whole reporting days. Daily boundaries use the workspace
timezone, initially `Asia/Singapore`. Keep that timezone stable for the retention
window; changing it requires rebuilding retained statistics.

Migration `0009_compact_statistics.sql` requires one restartable backfill on an
existing database. After applying migrations and deploying the new Worker, run:

```sh
node scripts/compact-usage.mjs --remote
```

Use `--local` for development, optionally with `--persist-to DIRECTORY`. Snapshots
return 503 until the backfill finishes; new ingestion can proceed during it. Old
Worker versions cannot insert usage without reporting-day metadata after the
migration. See [statistics design and read costs](../docs/statistics.md).

## Validation and limits

From the repository root:

```sh
cd collector
pnpm check
pnpm test
```

These checks exercise the Worker, D1, and Durable Objects in workerd without desktop
dependencies. Run `./scripts/check.sh` from the repository root for all component
checks; see [CONTRIBUTING.md](../CONTRIBUTING.md) for their development dependencies.
Production deployment checks and their scope are recorded in the [deployment notes](../docs/deployment.md).

Collection begins when an installed hook first observes a session. Transcripts
for sessions never observed by hooks are not automatically imported. The shell
extractor follows known transcript paths incrementally; malformed records or a
record larger than its 16 MiB chunk budget mark incomplete coverage. Transcript
growth clears attention heuristically, usually on the next reconciliation tick.
A missing transcript, stopped scheduler, or process-identity lookup failure is
shown as incomplete/unverified, rather than guessed to be zero or ended. Codex
account quota percentages are not merged across machines because the current
integration does not establish shared account identity.


## Web panel deployment

The Worker serves `clients/web/public/` through its `ASSETS` binding. The frontend
has no build step. Deploy the repository with that directory present.

Apply `0010_browser_access.sql` before deploying the browser-enabled Worker; it
adds parent-token relationships, expiring login links, and connection tickets.
Existing credentials and compact usage statistics are preserved. Then deploy
with the project's existing Wrangler configuration and update reporter binaries
so `ai-agents web` is available. No new Worker secret or external auth provider is
needed. A write credential can now delegate workspace-wide read access to a
browser through a one-time link; read credentials cannot delegate access.

The [web guide](../clients/web/README.md) documents login, expiry/revocation,
local development origin configuration, and browser tests. The unauthenticated
homepage is available even when D1 is unavailable; private snapshots continue
to return their existing explicit quota/migration errors.

## Idle workload

Maintenance/recovery cron runs hourly. Normal event/usage/presence writes publish
immediately; delivered outbox rows are excluded by an index. Subscription objects
skip storage/alarm work with no listeners. Idle viewer connections hibernate and
revalidate authorization before sending new invalidations when their cached check
expires. Presence revisions are coalesced once per batch. Browser tabs pause while
hidden and catch up on return.

Reporters send no repeated empty heartbeat after acknowledgement. Live processes
still renew their ten-minute lease every five minutes; suppressing those renewals
would misrepresent liveness. Unacknowledged data and changed coverage still upload.
Cron is a recovery backstop, not the normal publication path. Failed Durable Object
broadcasts use persisted backoff, avoiding one-second retry storms during outages.

To deliberately clear a workspace's collected telemetry after migration `0014`:

```sh
node scripts/reset-telemetry.mjs --remote --workspace WORKSPACE_ID
```

The reset is transactional. It preserves credentials, installations, live runs,
and execution identities, advances a usage replay watermark, clears detailed
records and totals, and publishes a new revision. Historical usage queued before
that watermark is acknowledged without restoring deleted costs.
