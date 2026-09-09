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
header on the upgrade request. A future browser client will need a separately
designed authentication flow because browser WebSocket constructors cannot set
arbitrary headers; no browser-ticket or cookie authentication is provided today.

Requests with JSON bodies include `schema_version: 1` and
`Content-Type: application/json`. Bodies are limited to 256 KiB. Each token is
limited to 600 HTTP requests per minute; honor `Retry-After` on 429 responses.

## Reading state

| Endpoint | Response/use |
| --- | --- |
| `GET /v1/snapshot` | Current runs, state counts, usage totals, workspace revision, and freshness deadlines |
| `GET /v1/sessions?cursor=...&installation=...` | Paginated run history; up to 100 entries and a nullable next cursor |
| `GET /v1/sessions/:run_id/events?cursor=...` | Up to 100 diagnostic lifecycle events and a nullable next cursor |
| `GET /v1/usage?from=ISO&to=ISO` | Usage for an explicit interval of up to 31 days |
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

Activity states are `unknown`, `idle`, `busy`, `asking`, `done`, and `ended`.
Snapshot runs are current; ended runs are available in history. Freshness is a
separate value: `live`, `stale`, or `unverified`. Lack of recent activity does not
mean the process ended. Never turn a network failure into an empty snapshot.

Usage totals contain `tokens`, `dollars`, `priced`, `available`, and `complete`.
Unavailable usage is not zero. Unpriced models can still have known token counts;
dollar totals can be partial estimates. Use the server's totals, which account for
copied transcripts and cumulative counters; summing run totals can double-count
shared evidence. Treat agent names and model IDs as extensible strings.

Snapshots have explicit size limits: currently 1,000 current runs/installations,
10,000 raw usage records in the interval, and bounded observation/archive rows.
An oversized response returns 413 rather than a silently truncated live count.
Use paginated history or narrower usage intervals as appropriate and surface the
limitation to the user. Archived usage queries must cover whole reporting days.

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

Successful event/usage responses contain an `accepted` array of event IDs or native
usage record IDs, respectively. Remove outbox items only after acknowledgement.
Identical retries are safe; identity reuse with different content returns 409.

## Errors and evolution

Errors use `{"error":"description","request_id":"..."}`. Important statuses:
400 invalid payload/version; 401 invalid credential; 403 wrong scope/installation;
409 conflicting identity or a usage run not yet ingested; 410 expired retry/history
window; 413 size limit; 415 content type; 429 rate limit; 500 collector failure.
Retry network errors, 429, and server failures with backoff. Handle permanent payload
errors and conflicts explicitly; do not repeatedly block unrelated observations.

Consumers should tolerate additive response fields and new agent/model names.
Unknown WebSocket message types can be ignored; unsupported protocol versions must
be surfaced. Changes to the established identity, usage, authorization, or state
semantics require compatibility review and, when breaking, a new protocol version.
