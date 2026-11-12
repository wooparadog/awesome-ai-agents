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
