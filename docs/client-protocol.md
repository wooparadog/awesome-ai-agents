# Collector protocol v1

This is the shared boundary between the collector, reporters, and viewer clients.
It does not depend on AwesomeWM, Lua, a local filesystem, or a particular desktop.
The implementation lives in `collector/src/`; examples below use illustrative IDs.

## Authentication and transport

Use HTTPS for HTTP requests and WSS for subscriptions to a hosted collector.
Loopback HTTP is available during local development. Send credentials as:

```http
Authorization: Bearer <token-id>.<secret>
```

Viewer clients use a **read** token. Reporters use a **write** token bound to one
installation. The server determines workspace scope from the token; client-supplied
workspace fields do not grant access. Keep tokens out of URLs and logs.

Native desktop clients should use a WebSocket library that supports the Authorization
header on the upgrade request. Browser clients instead use a short-lived
connection ticket, described below; neither cookies nor URL query parameters
carry persistent credentials.

Requests with JSON bodies include `schema_version: 1` and
`Content-Type: application/json`. Bodies are limited to 256 KiB. Each token is
limited to 600 HTTP requests per minute; honor `Retry-After` on 429 responses.

## Browser login and subscriptions

`GET /`, `/login`, and `/panel` serve the public web shell. The homepage explains
how to generate a login URL from a configured reporter. Private API data still
requires authorization.

| Endpoint | Authorization | Result |
| --- | --- | --- |
| `POST /v1/browser-links` | Reporter **write** token | Single-use login URL and expiry timestamps |
| `POST /v1/browser-login` | One-time link secret in JSON body | New browser **read** token, expiry, workspace ID |
| `POST /v1/browser-ticket` | **Read** token | Single-use WebSocket ticket valid for up to 60 seconds |
| `GET /v1/browser-subscribe` | Same-origin WebSocket with ticket subprotocol | Existing v1 subscription protocol |
| `POST /v1/browser-logout` | **Read** token being revoked | Revokes that token and closes its subscriptions |

All POST bodies include `schema_version: 1`. Link creation accepts `expires_in`
(seconds, default 600, minimum 60, maximum 3600) and returns `url`, `expires_at`,
and `browser_expires_at` (UTC milliseconds). The URL is `/login#token=ID.SECRET`;
its fragment never reaches HTTP logs. The browser removes the fragment before
posting `{schema_version:1, token:"ID.SECRET"}` to exchange it. An invalid secret
returns 401; an expired/consumed link returns 410. Redemption is atomic, so only
one concurrent caller obtains a token.

**Delegation policy:** a configured write credential can authorize browser read
access to its entire workspace. The browser cannot ingest data or create further
login links. Browser credentials expire after at most 30 days and inherit the
originating credential's expiry, revocation, and installation-disable state. The
response contains `token`, `expires_at`, and `workspace_id`; the web client stores
it in localStorage for that origin. Native read/write credentials are unchanged.

For a browser subscription, POST `{schema_version:1}` to `/v1/browser-ticket` with
`Authorization: Bearer ...`, then connect using these offered subprotocols:

```js
new WebSocket("wss://collector.example/v1/browser-subscribe", [
  "ai-agents.v1",
  "ticket." + ticket,
]);
```

The server selects only `ai-agents.v1`. The ticket is consumed once and its parent
read credential is checked again at upgrade. Persistent credentials and tickets
are never placed in query strings. Browser POST requests reject foreign origins;
WebSocket upgrades require an exact same-origin `Origin` header. No CORS access is
provided. The rest of the subscription/acknowledgement protocol below is shared
with native clients.

Each writer is limited to eight outstanding links and 32 active browser tokens;
each reader is limited to eight unused connection tickets. Secrets are hashed in
D1 and expired rows are cleaned in bounded, indexed hourly maintenance batches.

## Reading state

| Endpoint | Response/use |
| --- | --- |
| `GET /v1/snapshot` | Current runs, state counts, usage totals, workspace revision, and freshness deadlines |
| `GET /v1/sessions?cursor=...&installation=...` | Paginated run history; up to 100 entries and a nullable next cursor |
| `GET /v1/sessions/:run_id/events?cursor=...` | Up to 100 diagnostic lifecycle events and a nullable next cursor |
| `GET /v1/usage?from=ISO&to=ISO` | Daily usage for whole reporting days within the last 30 days |
| `GET /v1/subscribe` | WebSocket upgrade for change notifications |

Treat cursor values as opaque. The historical `/sessions` API returns **runs**;
its `id`, also used in the diagnostic route, is a run ID. A conversation may have
multiple runs on different installations or process incarnations.

A snapshot includes:

| Field | Meaning |
| --- | --- |
| `revision` | Increasing workspace revision for persisted changes |
| `server_time` | Server UTC time, integer milliseconds |
| `from`, `to`, `timezone` | Reporting interval and workspace timezone |
| `next_refresh_at` | Next time-dependent snapshot boundary |
| `total`, `busy`, `asking`, `done` | Counts for runs with recent process observations |
| `stale`, `unverified` | Runs outside that confirmed-live count |
| `order`, `agents` | Agent names and run lists grouped by agent name |
| `cost` | Usage totals keyed by agent name |
| `installations` | Source identities, labels, contact times, and reported capabilities |
| `usage_complete` | Whether the available reporting coverage is complete |

Run entries include `id`, `session_id`, `execution_id`, `installation_id`, `agent`,
`native_session_id`, `state`, `machine`, `cwd`, `model`, `freshness`,
`presence_expires_at`, and per-run `usage`. Optional values may be null. A PID or
path describes the reporting installation and must never be interpreted as a
process or path on the viewing machine.

The Rust reporter checks local processes and transcripts every 30 seconds and
reports idle presence every five minutes. Local checks alone make no HTTP request.
The collector allows ten minutes of presence freshness before marking a run stale. This lease
is separate from the two-minute maximum age accepted for a newly submitted presence observation.
Hooks can submit a fresh observation of their own identified agent process without
waiting for reconciliation. Replayed lifecycle events alone never renew presence.

Activity states are `unknown`, `idle`, `busy`, `asking`, `done`, and `ended`.
Snapshot runs are current; ended runs are available in history. Freshness is a
separate value: `live`, `stale`, or `unverified`. Lack of recent activity does not
mean the process ended. Never turn a network failure into an empty snapshot.

Usage totals contain `tokens`, `dollars`, `priced`, `available`, and `complete`.
Unavailable usage is not zero. Unpriced models can still have known token counts;
dollar totals can be partial estimates. Use the server's totals, which account for
copied transcripts and cumulative counters; summing run totals can double-count
shared evidence. Treat agent names and model IDs as extensible strings.

Snapshots have explicit size limits: currently 1,000 current runs/installations
and 4,096 compact statistics buckets per query. Detailed usage volume does not
increase snapshot read cost.
An oversized response returns 413 rather than a silently truncated live count.
Use paginated history or narrower usage intervals as appropriate and surface the
limitation to the user. All usage intervals must cover whole reporting days;
statistics are available for 30 days.

## WebSocket subscription lifecycle

Subscribe with a read credential. The server accepts the connection and sends:

```json
{"type":"ready","protocol_version":1}
```

Fetch a snapshot after the subscription is established. Subscribe **before** fetching
so a change during the snapshot request is not lost. A notification contains only
an invalidation, not the state itself:

```json
{"type":"state.changed","revision":42}
```

Track the greatest revision received while a snapshot request is in flight. Coalesce
bursts, allow one request in flight, and fetch again if the result is older than the
notified revision. After applying a snapshot, acknowledge its revision:

```json
{"type":"ack","revision":42}
```

Acknowledge redundant notifications too when the current snapshot already covers
their revision. The server keeps at most one outstanding invalidation per socket
and coalesces subsequent changes until acknowledged. This prevents a slow consumer
from building an unbounded queue.

Send the literal text `ping` periodically; the runtime replies with literal `pong`
without waking the Durable Object's application handler. These are application
text messages, separate from WebSocket control frames. The current client uses a
20-second heartbeat. A missed response should trigger reconnect with bounded
exponential backoff and jitter. This checks the connection, not agent liveness.

On every reconnect, subscribe and fetch a fresh snapshot. Delivery is not exactly
once, and no durable per-client replay cursor is promised. HTTP ingestion success
means the state and pending notification committed; the signal may arrive later.
Failed snapshot requests need independent retries even if the socket stays healthy.

Subscriptions have an authorization lease of at most five minutes, shortened by
token expiry. Code `4001` requests reauthentication; reconnect using the current
credential. Code `4003` indicates revocation when explicitly closed. Other close
or connection errors require recovery; repeated authentication failures should be
surfaced without an aggressive retry loop. An HTTP read always revalidates the token.

Preserve the last snapshot during disconnects. Apply `presence_expires_at` locally
so stale runs leave the confirmed-live count even if a refresh fails. Respect the
server's reporting timezone and refresh at the day boundary; time-dependent updates
can legitimately retain the same persisted revision. Refresh after desktop resume.

## Reporting observations

This section is for reporters, not viewer-only clients. Source-platform details
belong in the reporter implementation. The collector's ingestion routes are:

| Endpoint | Batch |
| --- | --- |
| `POST /v1/events` | `events`, at most 16 lifecycle events |
| `POST /v1/presence` | `runs`, at most 128 fresh process observations; an empty list is allowed |
| `POST /v1/usage` | `records`, at most 64 usage records |

Example lifecycle body:

```json
{
  "schema_version": 1,
  "events": [{
    "event_id": "event-uuid",
    "installation_id": "installation-id",
    "execution_id": "execution-uuid",
    "run_id": "run-uuid",
    "run_generation": 1,
    "sequence": 1,
    "observed_at": "2026-09-09T08:00:00.000Z",
    "agent": "claude",
    "native_session_id": "native-session-id",
    "source_event": "UserPromptSubmit",
    "data": {"cwd":"/work/project","model":null,"pid":1234}
  }]
}
```

Generate stable installation identity and new execution identity for a process
incarnation. Run identity changes when that execution switches sessions or starts
a new attachment after closing the previous run. Serialize sequence assignment
locally; retries reuse the same event ID, sequence, and content. Server arrival
order and wall-clock timestamps are not substitutes for source ordering.

Lifecycle data is allowlisted: `cwd`, `model`, `pid`, `source`,
`notification_type`, and `reason`. Send no raw transcript, prompt, generated text,
command arguments, or tool payloads. Unknown event names are neutral metadata
observations. Reporting failures must not affect the coding agent's decisions.
The current source-event mappings are implemented in `collector/src/protocol.ts`.

Presence bodies include `schema_version`, `observed_at`, `runs`, `usage` (reporting
capability), and `dropped` (diagnostic count). Each run observation has `run_id`,
`execution_id`, and an increasing `sequence`. Presence is freshly observed and sent
directly; it must not be replayed from the historical outbox to renew a lease.
Process disappearance is a lifecycle `SessionEnd` observation with an appropriate
reason. Absence of hooks cannot establish process death.

Usage records include `run_id`, `agent`, `provider`, `native_record_id`, `stream_id`,
`counter_epoch`, `model`, `occurred_at`, `measurement_kind` (`delta` or `cumulative`),
and `counters` (`input`, `output`, `cache_read`, `cache_write_5m`, `cache_write_1h`).
For cumulative records, input includes cached input; for deltas, input is the
uncached portion. Stable native record identity must survive transcript copies.
Send cumulative evidence as recorded; the server derives deltas and handles missing
baselines and resets. A run must already have been ingested before attaching usage.

For modern Codex transcripts, use `token_usage_record` response IDs as native
record IDs, the originating thread ID as `stream_id`, `responses-v1` as the epoch,
and per-response deltas. These supersede legacy cumulative estimates from the first
exact response onward, so upgrades replay the transcript from the beginning. Delta input excludes
both cached reads and cache writes, which have their own counters.

Successful event/usage responses contain an `accepted` array of event IDs or native
usage record IDs, respectively. Remove outbox items only after acknowledgement.
Usage records older than seven days also appear in `ignored`: they are acknowledged
without storing or recounting them after the detailed deduplication window. Daily
statistics already collected remain available for 30 days. Lifecycle events retain
the seven-day retry horizon.

Identical retries are safe; identity reuse with different content returns 409.
Claude content blocks can repeat the same message/request usage with different
local timestamps. If all other accounting fields match, the first accepted
timestamp is retained and the repeated record is acknowledged without counting it
again. Changed models or counters still return 409.

## Errors and evolution

Errors use `{"error":"description","request_id":"..."}`. Important statuses:
400 invalid payload/version; 401 invalid credential; 403 wrong scope/installation;
409 conflicting identity or a usage run not yet ingested; 410 expired retry/history
window; 413 size limit; 415 content type; 429 rate limit; 503 database quota or
statistics migration in progress; 500 collector failure. Quota errors include a
`Retry-After` delay until the next UTC daily reset; other temporary 503s use 60 seconds.
Retry network errors, 429, and server failures with backoff. Handle permanent payload
errors and conflicts explicitly; do not repeatedly block unrelated observations.

Consumers should tolerate additive response fields and new agent/model names.
Unknown WebSocket message types can be ignored; unsupported protocol versions must
be surfaced. Changes to the established identity, usage, authorization, or state
semantics require compatibility review and, when breaking, a new protocol version.
