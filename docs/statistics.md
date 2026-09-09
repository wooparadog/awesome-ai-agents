# Compact statistics and D1 read budget

The September 9 outage exhausted D1's free daily read quota. Query insights showed
263 usage calculations scanning 4,631,006 rows, plus 846,541 reads attaching usage
to sessions. A fast query was still expensive because D1 meters rows scanned.

## Read path

Snapshots query `usage_rollups` by workspace, run, and reporting day. The empty
run ID identifies deduplicated workspace totals. A separate indexed query starts
from active runs and reads their compact buckets. There is no raw-usage join,
window function, or per-record pricing lookup on this path.

The workerd/D1 regression fixture has 5,001 usage records and one active run:

| Measurement | Rows read |
| --- | ---: |
| Previous usage calculation alone | 170,036 |
| New workspace and run statistics queries together | 4 |
| New snapshot data batch, including state and installations | 10 |

Authentication and the workspace configuration lookup add a few indexed reads.
The tests assert that adding detailed history does not increase the statistics
read count, and that the snapshot data batch stays below 50 reads. These are local
runtime measurements; production logs expose the same counters for verification.

## Write path and correctness

`usage_records` keeps short-lived deduplication and cumulative evidence.
`usage_contributions` stores each accepted record's normalized counters and rate
set. Triggers add those contributions to daily buckets and attach them to observing
runs atomically. Copies and retries preserve native identities and do not increase
workspace totals. A new association can populate a resumed run without counting
its usage again globally.

For legacy cumulative records, an indexed predecessor lookup normalizes the new
sample; its immediate successor is corrected when a late sample arrives. Model
changes and missing baselines retain explicit incomplete/unpriced attribution.
Exact Codex responses remove superseded cumulative contributions. The legacy
history-scanning query exists only in tests as a performance comparison.

Rate sets are materialized with contributions, avoiding repeated pricing queries
on every snapshot. Retained evidence can support an explicit rebuild if prices
or the reporting timezone change; deleted evidence cannot be repriced precisely.
Usage batches publish one workspace revision, instead of updating notification
state twice for every individual record.

## Storage and maintenance

- Detailed usage and lifecycle records: seven-day window, bounded hourly pruning.
- Daily workspace/run/model/rate statistics: 30 days, whole reporting days.
- Cumulative baselines: at most one older sample per stream, within 30 days.
- Closed-run private metadata: stripped after seven days; unreferenced ended
  identities are removed after 30 days. Active runs remain tracked.
- Full transcript history: stays on the reporting machines.

Pruning freezes contributions first so compact totals survive. Replays older than
seven days are acknowledged as ignored, preventing double counting after their
identity records are removed. Each cleanup operation processes at most 500 rows;
indexes avoid scanning current history just to discover that nothing has expired.

## Existing database migration

Apply `0009_compact_statistics.sql`, deploy the new Worker, then run
`node scripts/compact-usage.mjs --remote` from `collector/`. The backfill is
restartable and skips already converted records. It preserves existing daily
statistics within the 30-day window before normal seven-day pruning begins.
Snapshots return 503 while conversion is incomplete, and old Worker versions
cannot insert unprojected usage. New ingestion already updates compact buckets.

The daily quota outage cannot be undone by changing a query: database access
remains blocked until Cloudflare resets the quota or the account plan changes.
No billing upgrade is needed to deploy this optimization.
