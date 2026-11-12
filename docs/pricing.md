# Token pricing

The collector calculates published API **token costs**, not subscription charges
or provider invoices. Tool calls, hosted containers, storage, taxes, credits,
private discounts, and subscription allowances are not included.

`collector/pricing/catalog.json` is the pricing snapshot, refreshed on
October 7, 2026. It includes GPT-6 Sol/Luna, GPT-6.1 Sol, Claude Opus/Sonnet 5.5,
and the existing text-model catalog. The repeatable updater uses the
[LLM Prices JSON feed](https://www.llm-prices.com/current-v1.json) by default
(the snapshot used for this refresh is dated September 29). Input, output,
and cached-input prices are cross-checked against the feed; cache writes,
service tiers, and geographic rules come from the
[OpenAI pricing tables](https://developers.openai.com/api/docs/pricing) and
[Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing).
Each model records its source and verification date. Source URLs and SHA-256
receipts live in `collector/pricing/sources.json`.
The old `price_rates` SQL table is retained only for compatibility with older
Worker versions and their SQL accounting queries. New ingestion and repricing use
the catalog through `collector/src/pricing.ts`.

## Calculation and confidence

- Delta input excludes cache reads and writes. The prompt length used for tier
  selection includes uncached input, cached input, and both cache-write durations.
  Output tokens do not contribute to that threshold.
- GPT-6 Astra and the applicable GPT-5 models use long-context rates **above**
  272,000 input tokens, for the whole request. Exactly 272,000 uses the short rate.
  Claude Sonnet 4/4.5 uses its 200,000-token tier; Claude 4.6 and later uses standard
  rates across its supported context window.
- Standard, Fast, Ultrafast, Batch, and Flex prices are explicit per-model tables. Missing
  combinations remain unpriced. In particular, Fast is not one universal
  multiplier, and Claude Priority capacity is not treated as OpenAI Fast mode.
- Supported regional pricing applies the published 10% uplift. Ultrafast is priced only for published models in global/US regions. Unsupported
  regions, partner billing, private tiers, and missing metric rates remain unpriced.
  A missing cache price never means a free cache operation.
- Rate sets use integer pico-USD per token. This preserves fractional nano-USD
  rates such as GPT-5 Mini Batch cache reads. Legacy nano-USD buckets still work.
- Model matching accepts exact IDs, explicit aliases, and dated snapshots; it
  does not use a loose model-family prefix.

`priced` says whether every nonzero token counter has a rate. `estimated` is a
separate flag: it is true when billing metadata is incomplete, usage is cumulative,
or a model price snapshot is being applied outside its verification window
(before verification or more than 30 days afterward). Missing metadata assumes
standard, global, direct API pricing and marks the result estimated. Unknown
explicit metadata does not silently fall back to standard pricing. Claude's
`inference_geo: "not_available"` sentinel and blank optional fields mean missing
metadata, so they retain a clearly marked standard/global estimate.

Clients display `≈` for estimates and label partial costs. Fully unpriced usage
does not display a misleading zero-dollar charge. Even when `estimated=false`,
the result is a published token-rate calculation, not a reconciliation against
the provider invoice.

## Reporter metadata and upgrades

Usage accepts optional `pricing` fields: `service_tier`, `speed`, `inference_geo`,
and `billing_provider`. Reporters forward returned response/usage fields when
present; they do not infer actual billing tiers from requested turn preferences.
`billing_provider: "direct"` identifies the published first-party API price.
Other explicit billing providers stay unpriced until their pricing is supported.

Rust and shell cursor version 3 replays retained transcripts once to recover
billing metadata. Native IDs and counters still deduplicate across copies and
resumed runs. Missing metadata can be enriched; contradictory nonempty fields
or changed counters are rejected. Old outboxes cannot erase recovered metadata.
Pre-existing counter errors cannot be overwritten by replay; these continue to
surface as usage conflicts rather than silently rewriting evidence.

The legacy AwesomeWM local mode only has daily aggregates. Its standard-rate
table is generated from the same catalog, but those local costs remain estimates.
Use collector mode for per-response pricing.

## Applying the change

Apply collector migration `0013_accurate_pricing.sql` along with any preceding
pending migrations, then deploy the collector before upgrading reporters. The
hourly scheduled job reprices up to 200 retained records per invocation.
Retention pauses while the pricing queue contains records, so it cannot delete
the evidence before repricing. Existing summaries remain readable as estimates.

To drain the queue immediately, run from `collector/`:

```sh
node scripts/reprice-usage.mjs --remote
# For an isolated local database:
node scripts/reprice-usage.mjs --local --persist-to /path/to/local-state
```

The command is restartable. Repricing moves each contribution between rate buckets
through the existing transactional triggers, updating both workspace totals and
associated runs without counting tokens twice. Metadata enrichment uses the same
queue. Replaying records older than the seven-day evidence window does not add
them again. Frozen summaries whose individual requests have been deleted retain
their previous amounts and remain estimates; their original context and billing
tiers cannot be recovered from daily token totals.

## Repeatable updates

Run from the repository root with Node.js 22.18+ (or the installed Node.js 26):

```sh
# Fetch the JSON feed and preview additions/changes; no catalog writes.
pnpm -C collector prices:update

# Apply the reviewed feed update locally.
pnpm -C collector prices:update --write

# Or use a previously downloaded JSON snapshot.
pnpm -C collector prices:update --feed /path/to/current-v1.json --write

# Save the downloaded feed alongside the update report for later inspection.
pnpm -C collector prices:update --save-sources /tmp/price-review

# Optional broader review: parse provider tables, including cache writes,
# service tiers, and long-context rates absent from the JSON feed.
pnpm -C collector prices:update --official
pnpm -C collector prices:update --official --write
# Offline provider review expects openai.md and anthropic.md in this directory.
pnpm -C collector prices:update --official --source-dir /tmp/provider-prices --write

# Independent feed audit and consistency checks.
pnpm -C collector prices:check
pnpm -C collector test:price-sync
node collector/scripts/sync-legacy-pricing.mjs --check
pnpm -C collector check
pnpm -C collector test
```

`prices:update` runs `collector/scripts/update-prices.mjs`. `--write` updates the
catalog and source receipts, regenerates the legacy AwesomeWM table, and creates
a numbered D1 migration **only when pricing behavior changes**. A repeated run
against the same data is idempotent. The script does not deploy, contact D1, modify
credentials, or schedule a background job.

The updater handles feed context suffixes such as `-272k` as thresholds, resolves
reviewed model aliases, and rejects malformed, negative, zero, nonnumeric,
conflicting-duplicate, or incomplete price rows. It imports only the supported
OpenAI/Anthropic text pricing. Image/audio/embedding/tool billing needs different
counters and is excluded. New feed-only models get standard rates; the script
does not invent cache-write, Batch/Fast/Flex, or regional prices.

Missing/null fields never erase known prices, and absent models remain available
for historical data. Retained rates are reported in the preview. Models with
unrefreshed fields keep their earlier evidence date; the script does not claim
that the feed reverified all their pricing dimensions. Source feed dates are
preserved rather than replaced with the download date. This means a stale feed
continues to produce explicitly estimated costs after its verification window.

`pricing/sync-rules.json` contains reviewed regional policies, aliases, and two
precision overrides for rounded GPT-5.4 cache cells in provider tables. Each
override records its expected published value, reason, and source; a changed
cell fails closed for review. New OpenAI models default to global-only unless a
reviewed regional policy is supplied. An optional provider-source refresh also
rejects changed table layouts or context rules before writing anything. If a
provider blocks automated downloads, use saved official Markdown with
`--source-dir`; the default JSON-feed path does not depend on those pages.

Inspect `git diff` after `--write`. Apply any existing schema prerequisites first.
For the generated **pricing-only** migration, deploy the matching catalog before
queueing repricing, so the hourly job cannot process the queue with old rates:

```sh
pnpm -C collector exec wrangler deploy --dry-run
pnpm -C collector exec wrangler deploy
pnpm -C collector exec wrangler d1 migrations apply ai-agents --remote
node collector/scripts/reprice-usage.mjs --remote
```

The migration queues only retained evidence for affected exact model IDs,
reviewed aliases, and dated snapshots; it excludes archived records and leaves
frozen summaries unchanged. The repricer is restartable and updates usage
contributions without counting tokens twice. A newly verified price applied to
older evidence remains marked estimated: this catalog is not a historical price
ledger. Prices omitted from the feed, private discounts, and unsupported billing
modes still need a provider review rather than an inferred rate.
