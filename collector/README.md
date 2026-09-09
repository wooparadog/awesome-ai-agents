# Cloud collector

TypeScript Worker + D1 + one hibernating WebSocket Durable Object per workspace.
The reporter uses ordinary authenticated HTTP; the widget subscribes to revisions
and fetches snapshots only when needed. The HTTP API is independent of any particular desktop or viewer.

## Hosted collector

The collector is deployed at [ai-agents-collector.stdimg.workers.dev](https://ai-agents-collector.stdimg.workers.dev).
All application routes require a token; an unauthenticated request returns 401.
The configured D1 database is `ai-agents` in APAC, and the scheduled maintenance
trigger runs every minute. See [deployment details](../docs/deployment.md).

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
existing subscriptions expire within five minutes and must reauthenticate.

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
- `GET /v1/usage?from=ISO&to=ISO`: usage within an explicit interval of up to 31 days.

All routes require a scoped bearer token. Request bodies are limited to 256 KiB.
Tokens are rate limited to 600 requests/minute. Persistent identity constraints
prevent cross-installation writes and conflicting retries. Triggers atomically
reduce new lifecycle events and increment the workspace revision. The notification
outbox commits in the same transaction; immediate publication plus a scheduled
retry drain covers Worker failures. The Durable Object durably accepts publication
before the outbox is acknowledged. Per-socket acknowledgements bound notification
queues. Neither HTTP success nor a socket send claims exactly-once delivery.

The schema is in `migrations/`. It preserves original cumulative usage snapshots
and derives ordered deltas, marking missing/reset baselines incomplete. A model
switch across a cumulative interval has unknown model attribution. Claude message
IDs are deduplicated across transcript copies. Prices were migrated from the
repository's existing estimates; unknown models remain unpriced. No prompt,
response, command arguments, tool payloads, or transcript paths are uploaded.

Lifecycle history is pruned after 30 days. Usage older than 90 days is folded into
reporting-day summaries retained for one year, keeping cumulative baselines needed
by surviving records. Historical queries must align to whole archived reporting
days. Ended-run metadata is stripped after 90 days; compact identity tombstones
remain to prevent resurrection. Retention is bounded per invocation; an oversized
archive day is retained and logged for operator attention. Local outbox delivery
has a seven-day retry horizon and a 32 MiB capacity target; any evictions mark
coverage incomplete. Daily boundaries use the workspace timezone, initially
`Asia/Singapore`.

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
