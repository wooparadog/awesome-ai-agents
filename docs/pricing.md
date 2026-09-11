# Token pricing

The collector calculates published API **token costs**, not subscription charges
or provider invoices. Tool calls, hosted containers, storage, taxes, credits,
private discounts, and subscription allowances are not included.

`collector/pricing/catalog.json` is the reviewed pricing snapshot, verified on
September 11, 2026. It covers OpenAI and Anthropic text models, including the newer
GPT-5/Codex families, GPT-6 Astra, and current Claude models. Each model records its
source. The sources are the [OpenAI pricing tables](https://developers.openai.com/api/docs/pricing),
[Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing), linked
OpenAI model pages, and the [LLM Prices feed](https://www.llm-prices.com/current-v1.json).
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
- Standard, Fast, Batch, and Flex prices are explicit per-model tables. Missing
  combinations remain unpriced. In particular, Fast is not one universal
  multiplier, and Claude Priority capacity is not treated as OpenAI Fast mode.
- Supported regional pricing applies the published 10% uplift. Unsupported
  regions, partner billing, private tiers, and missing metric rates remain unpriced.
  A missing cache price never means a free cache operation.
- Rate sets use integer pico-USD per token. This preserves fractional nano-USD
  rates such as GPT-5 Mini Batch cache reads. Legacy nano-USD buckets still work.
- Model matching accepts exact IDs, explicit aliases, and dated snapshots; it
  does not use a loose model-family prefix.

`priced` says whether every nonzero token counter has a rate. `estimated` is a
separate flag: it is true when billing metadata is incomplete, usage is cumulative,
or a current price snapshot is being applied outside its verification window
(before verification or more than 30 days afterward). Missing metadata assumes
standard, global, direct API pricing and marks the result estimated. Unknown
explicit metadata does not silently fall back to standard pricing.

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

## Future price reviews

```sh
node collector/scripts/check-prices.mjs
# Or compare an already downloaded snapshot:
node collector/scripts/check-prices.mjs /path/to/current-v1.json
node collector/scripts/sync-legacy-pricing.mjs
node collector/scripts/sync-legacy-pricing.mjs --check
```

The audit is read-only and reports mismatches, missing models, and duplicate feed
IDs. It compares feed input/output/cache-read prices, including context tiers.
It cannot validate cache-write, service-tier, or regional rates absent from that
feed; review those against the linked provider sources. Do not replace missing
values with zero or erase verified models because the feed omits them.

When rates change, update the catalog/version and add a migration that sets
`pricing_version=''` for affected retained records. Current snapshots are not a
historical price ledger; keep historical corrections explicitly marked estimated
unless the effective rate is established. Regenerate the legacy table and run the
collector pricing tests before deployment.
