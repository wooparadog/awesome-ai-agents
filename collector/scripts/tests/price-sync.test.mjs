import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseOpenAI,
  parseFeed,
  parseAnthropic,
  mergeCatalog,
  repricingSql,
  validateCatalog,
} from "../lib/price-sync.mjs";
const header =
  "| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |";
const openai = [
  "Flagship models",
  ...["Standard", "Batch", "Flex", "Fast"].flatMap((t) => [
    t,
    header,
    "| gpt-test | $2 | $0.1 | $2.5 | $10 | $4 | $0.2 | $5 | $15 |",
    "| gpt-other | $1 | - | - | $2 | - | - | - | - |",
    "| gpt-third | $1 | $0.1 | - | $2 | - | - | - | - |",
  ]),
  "Short context: ≤272K input tokens. Long context: >272K input tokens.",
].join("\n");
const anthropic = `## Model pricing
| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| --- | --- | --- | --- | --- | --- |
| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |
| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |
| Claude Haiku 3.5 ([retired](https://example.invalid)) | $0.80 / MTok | $1 / MTok | $1.60 / MTok | $0.08 / MTok | $4 / MTok |
These multipliers stack with other pricing modifiers, including the Batch API discount and data residency.
Claude 4.6 and later models use a 1.1x multiplier on all token pricing categories.
### Fast mode pricing
| Model | Input | Output |
| --- | --- | --- |
| Claude Opus 5.5 | $8 / MTok | $40 / MTok |
### Batch processing
| Model | Batch input | Batch output |
| --- | --- | --- |
| Claude Opus 5.5 | $2 / MTok | $10 / MTok |
`;
function previous() {
  return {
    version: "2026-09-11",
    verified_at: "2026-09-11T00:00:00Z",
    units: "USD per million tokens",
    aliases: {},
    models: {
      legacy: {
        provider: "openai",
        source: "old",
        regional: false,
        tiers: {
          standard: { short: { input: 1, output: 2, cache_read: 0.1 } },
        },
      },
    },
  };
}
test("parses explicit OpenAI tiers and context thresholds without inventing missing prices", () => {
  const m = parseOpenAI(openai);
  assert.equal(m["gpt-test"].context_threshold, 272000);
  assert.equal(m["gpt-test"].tiers.fast.long.output, 15);
  assert.equal(m["gpt-other"].tiers.standard.short.cache_read, undefined);
  assert.throws(
    () => parseOpenAI(openai.replace("≤272K", "≤300K")),
    /threshold/,
  );
  assert.throws(
    () => parseOpenAI(openai.replace("$2 |", "$bad |")),
    /Unrecognized/,
  );
  assert.throws(
    () => parseOpenAI(openai.replace("Short context input", "Input price")),
    /headers/,
  );
  assert.throws(
    () => parseOpenAI(openai.replace("Fast\n", "Unknown\n")),
    /Conflicting|Missing/,
  );
});
test("preserves special Claude cache ratios across batch and fast tiers", () => {
  const m = parseAnthropic(anthropic);
  assert.equal(m["claude-opus-5-5"].tiers.fast.short.cache_read, 0.4);
  assert.equal(m["claude-opus-5-5"].tiers.batch.short.cache_read, 0.1);
  assert.equal(m["claude-opus-5-5"].tiers.fast.short.cache_write_1h, 16);
  assert.equal(m["claude-3-5-haiku"].regional, false);
  assert.equal(m["claude-sonnet-5-5"].regional, true);
  assert.throws(
    () =>
      parseAnthropic(anthropic.replace("$0.20 / MTok<sup>2</sup>", "unknown")),
    /Unrecognized/,
  );
});
test("merges without erasing omitted models/rates or renewing their evidence date", () => {
  const old = previous();
  const parsed = {
    legacy: {
      provider: "openai",
      source: "new",
      tiers: { standard: { short: { input: 3, output: 4 } } },
    },
  };
  const result = mergeCatalog(old, parsed, {}, "2026-10-07");
  assert.equal(
    result.catalog.models.legacy.tiers.standard.short.cache_read,
    0.1,
  );
  assert.equal(result.catalog.models.legacy.verified_at, old.verified_at);
  assert.deepEqual(result.changed, ["legacy"]);
  assert.equal(old.models.legacy.tiers.standard.short.input, 1);
  const gone = mergeCatalog(old, {}, {}, "2026-10-07");
  assert.deepEqual(gone.omitted, ["legacy"]);
  assert.equal(gone.catalog.models.legacy.tiers.standard.short.input, 1);
});
test("repeat sync is idempotent and stale overrides fail closed", () => {
  const parsed = parseOpenAI(openai),
    rules = {
      aliases: { "gpt-alias": "gpt-test" },
      rate_overrides: [
        {
          model: "gpt-test",
          tier: "standard",
          context: "short",
          metric: "cache_read",
          published: 0.1,
          value: 0.09,
        },
      ],
    };
  const first = mergeCatalog(previous(), parsed, rules, "2026-10-07");
  validateCatalog(first.catalog);
  const second = mergeCatalog(first.catalog, parsed, rules, "2026-10-07");
  assert.deepEqual(second.catalog, first.catalog);
  assert.equal(second.modified, false);
  assert.equal(repricingSql(second), null);
  rules.rate_overrides[0].published = 0.2;
  assert.throws(
    () => mergeCatalog(previous(), parsed, rules, "2026-10-07"),
    /stale override/,
  );
});
test("repricing targets changed exact model IDs, aliases and dated snapshots only", () => {
  const result = mergeCatalog(
    previous(),
    parseOpenAI(openai),
    { aliases: { "gpt-alias": "gpt-test" } },
    "2026-10-07",
  );
  const sql = repricingSql(result);
  assert.match(sql, /archived=0/);
  assert.match(sql, /pricing_version!='2026-10-07'/);
  assert.match(sql, /model='gpt-alias'/);
  assert.doesNotMatch(sql, /model='legacy'/);
  assert.doesNotMatch(sql, /gpt-test%/);
  for (const match of sql.matchAll(/GLOB '([^']+)'/g))
    assert.ok(match[1].length < 50, "D1 pattern limit");
});

test("JSON feed imports models, context tiers and aliases without inventing cache writes", () => {
  const old = previous();
  old.aliases["claude-sonnet-5.5"] = "claude-sonnet-5-5";
  const feed = {
    updated_at: "2026-09-29",
    prices: [
      {
        vendor: "openai",
        id: "gpt-new",
        input: 2,
        output: 10,
        input_cached: 0.1,
      },
      {
        vendor: "openai",
        id: "gpt-new-272k",
        input: 4,
        output: 15,
        input_cached: 0.2,
      },
      {
        vendor: "anthropic",
        id: "claude-sonnet-5.5",
        input: 2,
        output: 10,
        input_cached: 0.2,
      },
      { vendor: "other", id: "not-supported" },
      {
        vendor: "openai",
        id: "gpt-image-2",
        input: 8,
        output: 30,
        input_cached: 2,
      },
    ],
  };
  const parsed = parseFeed(feed, old);
  assert.equal(parsed.models["gpt-new"].context_threshold, 272000);
  assert.equal(
    parsed.models["gpt-new"].tiers.standard.short.cache_write_5m,
    undefined,
  );
  assert.equal(
    parsed.models["gpt-new"].verified_at,
    "2026-09-29T00:00:00.000Z",
  );
  assert.ok(parsed.models["claude-sonnet-5-5"]);
  assert.equal(Object.keys(parsed.models).length, 2);
  const merged = mergeCatalog(old, parsed.models, {}, "2026-10-07");
  assert.equal(
    merged.catalog.models["gpt-new"].verified_at,
    "2026-09-29T00:00:00.000Z",
  );
  assert.equal(merged.catalog.models.legacy.verified_at, old.verified_at);
});
test("JSON feed rejects invalid/conflicting records and treats null cache price as absent", () => {
  const row = {
      vendor: "openai",
      id: "legacy",
      input: 1,
      output: 2,
      input_cached: null,
    },
    feed = { updated_at: "2026-09-29", prices: [row] };
  const parsed = parseFeed(feed, previous());
  const merged = mergeCatalog(previous(), parsed.models, {}, "2026-10-07");
  assert.equal(
    merged.catalog.models.legacy.tiers.standard.short.cache_read,
    0.1,
  );
  assert.equal(
    parseFeed({ ...feed, prices: [row, { ...row }] }, previous()).duplicates
      .length,
    1,
  );
  assert.throws(
    () =>
      parseFeed({ ...feed, prices: [row, { ...row, input: 2 }] }, previous()),
    /Conflicting duplicate/,
  );
  for (const input of [-1, 0, "2", Infinity])
    assert.throws(
      () => parseFeed({ ...feed, prices: [{ ...row, input }] }, previous()),
      /Invalid/,
    );
  assert.throws(
    () =>
      parseFeed(
        { ...feed, prices: [{ ...row, id: "gpt-new-272k" }] },
        previous(),
      ),
    /Missing short/,
  );
  assert.throws(
    () => parseFeed({ ...feed, updated_at: "not a date" }, previous()),
    /timestamp/,
  );
});

test("generated migration only queues matching retained evidence, including snapshot aliases", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE usage_records(model TEXT,archived INTEGER,pricing_version TEXT)",
    );
    for (const row of [
      ["gpt_new", 0, "old"],
      ["gpt_new-20261007", 0, "old"],
      ["gpt_new-2026-10-07", 0, "old"],
      ["gpt_new@123", 0, "old"],
      ["gptXnew@123", 0, "old"],
      ["gpt_new-unknown", 0, "old"],
      ["gpt_new", 1, "old"],
      ["gpt_new", 0, "2026-10-07"],
    ])
      db.prepare("INSERT INTO usage_records VALUES(?,?,?)").run(...row);
    db.exec(
      repricingSql({
        catalog: { version: "2026-10-07", aliases: {} },
        added: ["gpt_new"],
        changed: [],
        aliasesChanged: [],
      }),
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM usage_records WHERE pricing_version=''",
        )
        .get().n,
      4,
    );
    assert.equal(
      db
        .prepare(
          "SELECT pricing_version FROM usage_records WHERE model='gptXnew@123'",
        )
        .get().pricing_version,
      "old",
    );
  } finally {
    db.close();
  }
});
test("maps reordered OpenAI columns by name, including split context rows", () => {
  const grouped =
    "| Model | Short context input | Short context output | Short context cached input | Short context 30m write | Short context 12h write | Long context input | Long context output | Long context cached input | Long context 30m write | Long context 12h write |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const page = [
    "Flagship models",
    ...["Standard", "Batch", "Flex", "Fast"].flatMap((t) => [
      t,
      `### ${t} pricing data`,
      grouped,
      "| gpt-new | $2.00 | $10.00 | $0.10 | $2.50 | $5.00 | $4.00 | $15.00 | $0.20 | $5.00 | $10.00 |",
      "",
      "| Model | Input | Output | Cached input |\n| --- | --- | --- | --- |",
      "| gpt-small | $0.20 | $1.25 | $0.02 |",
    ]),
    "Ultrafast",
    "### Ultrafast promotion pricing data",
    grouped,
    "| gpt-new | $6.00 | $30.00 | $0.30 | $7.50 | $15.00 | $12.00 | $45.00 | $0.60 | $15.00 | $30.00 |",
    "### Ultrafast list pricing data",
    grouped,
    "| gpt-new | $12.00 | $60.00 | $0.60 | $15.00 | $30.00 | $24.00 | $90.00 | $1.20 | $30.00 | $60.00 |",
    "Short context: ≤272K input tokens. Long context: >272K input tokens.",
    "Specialized models",
    "Standard",
    "| Category | Model | Input | Output | Cached input | 30m write | 12h write |\n| --- | --- | --- | --- | --- | --- | --- |",
    "| Cyber | gpt-cyber (short context) | $20.00 | $100.00 | $2.00 | $25.00 | $50.00 |",
    "| Cyber | gpt-cyber (long context) | $40.00 | $150.00 | $4.00 | - | - |",
    "| Cyber | gpt-short-only (short context) | $5.00 | $25.00 | $0.50 | - | - |",
    "| Cyber | gpt-short-only (long context) | - | - | - | - | - |",
    "| Moderation | omni-moderation-latest | Free | - | - | - | - |",
    "Fine-tuning",
    "Standard",
    "| Model | Training | Input | Output | Cached input |\n| --- | --- | --- | --- | --- |",
    "| gpt-tuned | $25.00 | $3.00 | $12.00 | $0.30 |",
  ].join("\n");
  const m = parseOpenAI(page);
  // The 30-minute write is the default cache write; 12-hour writes are unmapped.
  assert.deepEqual(m["gpt-new"].tiers.standard, {
    short: { input: 2, output: 10, cache_read: 0.1, cache_write_5m: 2.5 },
    long: { input: 4, output: 15, cache_read: 0.2, cache_write_5m: 5 },
  });
  assert.equal(m["gpt-new"].context_threshold, 272000);
  // The current promotion applies; the later list price is not yet in force.
  assert.equal(m["gpt-new"].tiers.ultrafast.short.input, 6);
  assert.deepEqual(m["gpt-small"].tiers.batch, {
    short: { input: 0.2, output: 1.25, cache_read: 0.02 },
  });
  assert.deepEqual(m["gpt-cyber"].tiers.standard.long, {
    input: 40,
    output: 150,
    cache_read: 4,
  });
  assert.equal(m["gpt-short-only"].tiers.standard.long, undefined);
  assert.equal(m["gpt-short-only"].context_threshold, undefined);
  assert.equal(m["omni-moderation-latest"], undefined);
  assert.equal(m["gpt-tuned"], undefined);
  assert.throws(
    () =>
      parseOpenAI(
        page.replace("Short context 30m write", "Short context 1d write"),
      ),
    /headers/,
  );
});
test("parses Claude prompt-length tiers and USD price cells", () => {
  const page = anthropic
    .replace(
      "| Claude Sonnet 5.5 |",
      "| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |\n| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |\n| Claude Sonnet 5.5 |",
    )
    .replace(
      "| Claude Opus 5.5 | $8 / MTok | $40 / MTok |",
      "| Claude Opus 5.5 | $8 USD / MTok | $40 USD / MTok |",
    )
    .replace(
      "| Claude Opus 5.5 | $2 / MTok | $10 / MTok |",
      "| Claude Opus 5.5 | $2 / MTok | $10 / MTok |\n| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.05 / MTok | $0.25 / MTok |\n| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.25 / MTok | $1.25 / MTok |",
    );
  const m = parseAnthropic(page);
  const haiku = m["claude-haiku-5-5"];
  assert.equal(haiku.context_threshold, 100000);
  assert.equal(haiku.regional, true);
  assert.deepEqual(haiku.tiers.standard.long, {
    input: 0.5,
    cache_write_5m: 0.625,
    cache_write_1h: 1,
    cache_read: 0.05,
    output: 2.5,
  });
  assert.equal(haiku.tiers.batch.short.input, 0.05);
  assert.equal(haiku.tiers.batch.long.cache_read, 0.025);
  assert.equal(m["claude-opus-5-5"].tiers.fast.short.input, 8);
  assert.equal(m["claude-sonnet-5-5"].context_threshold, undefined);
});
