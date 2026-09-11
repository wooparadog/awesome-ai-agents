import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import {
  catalog,
  resolveRates,
  type Counters,
  type PricingContext,
} from "../src/pricing";
import { summarize, snapshot } from "../src/snapshot";
import { ingest, usage } from "../src/ingest";
import { reprice } from "../src/reprice";
import type { Identity } from "../src/auth";
declare const TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
beforeAll(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
});
const when = Date.parse("2026-09-11T12:00:00Z");
const direct: PricingContext = {
  service_tier: "standard",
  billing_provider: "direct",
  inference_geo: "global",
  speed: "standard",
};
function total(
  model: string,
  counters: Counters,
  pricing: PricingContext = direct,
  kind = "delta",
) {
  const provider = model.startsWith("claude") ? "anthropic" : "openai";
  const rates = resolveRates(provider, model, kind, counters, pricing, when);
  return summarize([
    {
      agent: "test",
      model,
      provider,
      ...counters,
      rates: JSON.stringify(rates),
      incomplete: 0,
    },
  ]).test;
}
it.each([
  ["gpt-5.6-sol", 4, 0.4, 5, 20],
  ["gpt-5.6-terra", 2, 0.2, 2.5, 12],
  ["gpt-5.6-luna", 0.2, 0.02, 0.25, 1.2],
  ["gpt-6-astra", 10, 1, 12.5, 50],
])(
  "prices %s short/long context, including cache writes",
  (model, input, read, write, output) => {
    const short = total(model, {
      input: 100,
      cache_read: 20,
      cache_write_5m: 30,
      output: 40,
    });
    expect(short.dollars).toBeCloseTo(
      (100 * input + 20 * read + 30 * write + 40 * output) / 1e6,
      12,
    );
    expect(short).toMatchObject({
      priced: true,
      estimated: false,
      tokens: 190,
    });
    const long = total(model, {
      input: 100,
      cache_read: 271900,
      cache_write_5m: 1,
      output: 40,
    });
    expect(long.dollars).toBeCloseTo(
      (100 * input * 2 + 271900 * read * 2 + write * 2 + 40 * output * 1.5) /
        1e6,
      12,
    );
  },
);
it("keeps the exact 272K boundary at the short rate and excludes output from the threshold", () => {
  expect(
    total("gpt-6-astra", { input: 272000, output: 128000 }).dollars,
  ).toBeCloseTo(9.12);
  expect(
    total("gpt-6-astra", { input: 272001, output: 128000 }).dollars,
  ).toBeCloseTo(15.04002);
});
it("uses model-specific fast prices and rejects undocumented tier combinations", () => {
  expect(
    total(
      "gpt-5.5",
      { input: 1000, output: 1000 },
      { ...direct, service_tier: "priority" },
    ).dollars,
  ).toBeCloseTo(0.0875);
  expect(
    total(
      "gpt-5.6-sol",
      { input: 1000, output: 1000 },
      { ...direct, service_tier: "fast" },
    ).dollars,
  ).toBeCloseTo(0.048);
  expect(
    total("gpt-5.5", { input: 272001 }, { ...direct, service_tier: "fast" })
      .priced,
  ).toBe(false);
  expect(
    total(
      "claude-opus-5",
      { input: 1000, output: 1000 },
      { ...direct, speed: "fast" },
    ).dollars,
  ).toBeCloseTo(0.06);
  expect(
    total(
      "claude-opus-5",
      { input: 1000 },
      { ...direct, service_tier: "batch", speed: "fast" },
    ).priced,
  ).toBe(false);
});
it("preserves fractional nano-dollar cache charges and regional uplifts", () => {
  expect(
    total("gpt-5-mini", { cache_read: 1 }, { ...direct, service_tier: "batch" })
      .dollars,
  ).toBe(0.0000000125);
  expect(
    total(
      "gpt-5.6-luna",
      { cache_write_5m: 1 },
      { ...direct, service_tier: "flex", inference_geo: "us" },
    ).dollars,
  ).toBe(0.0000001375);
  expect(
    total(
      "claude-sonnet-5",
      { input: 1000 },
      { ...direct, inference_geo: "us" },
    ).dollars,
  ).toBeCloseTo(0.0022);
});
it("includes both Claude cache TTLs in pricing and prompt length", () => {
  expect(
    total("claude-fable-5-1", {
      input: 100,
      cache_read: 100,
      cache_write_5m: 100,
      cache_write_1h: 100,
      output: 100,
    }).dollars,
  ).toBeCloseTo(0.009275);
  expect(
    total("claude-sonnet-4-5", { input: 1, cache_write_1h: 200000 }).dollars,
  ).toBeCloseTo(2.400006);
  expect(total("claude-sonnet-4-6", { input: 900000 }).dollars).toBeCloseTo(
    2.7,
  );
});
it("matches exact aliases and snapshots without matching unknown family variants", () => {
  expect(total("gpt-5.6", { input: 1000 }).dollars).toBe(0.004);
  expect(total("gpt-5.2-2025-12-11", { input: 1000 }).dollars).toBe(0.00175);
  expect(total("claude-sonnet-4-5-20250929", { input: 1000 }).dollars).toBe(
    0.003,
  );
  expect(total("gpt-5.6-sol-new", { input: 1000 }).priced).toBe(false);
  expect(
    resolveRates("anthropic", "gpt-5", "delta", { input: 1 }, direct, when),
  ).toEqual({});
  expect(
    total(
      "gpt-6-astra-2026-09-01",
      { input: 1000 },
      { ...direct, service_tier: "fast", inference_geo: "eu" },
    ).priced,
  ).toBe(false);
});
it("does not treat unavailable prices, private tiers, or partner billing as free", () => {
  for (const pricing of [
    { ...direct, service_tier: "scale" },
    { ...direct, billing_provider: "vertex" },
  ]) {
    expect(total("gpt-5.6-sol", { input: 1000 }, pricing).priced).toBe(false);
  }
  expect(total("gpt-5-pro", { cache_read: 1 }).priced).toBe(false);
  expect(total("gpt-5", { cache_write_5m: 1 }).priced).toBe(false);
});
it("marks missing metadata, cumulative usage, and historical price assumptions as estimates", () => {
  expect(total("gpt-6-astra", { input: 300000 }, {}).estimated).toBe(true);
  expect(
    total("gpt-6-astra", { input: 300000 }, direct, "cumulative"),
  ).toMatchObject({ dollars: 3, estimated: true });
  expect(
    resolveRates(
      "openai",
      "gpt-6-astra",
      "delta",
      { input: 1 },
      direct,
      when - 86400000,
    )._estimated,
  ).toBe(1);
});
it("catalog prices are finite, positive, and representable as integer pico-USD", () => {
  for (const model of Object.values(catalog.models))
    for (const tier of Object.values(model.tiers)) {
      for (const rates of [tier.short, tier.long].filter(Boolean))
        for (const rate of Object.values(rates!)) {
          expect(rate).toBeGreaterThan(0);
          expect(Math.abs(rate * 1e6 - Math.round(rate * 1e6))).toBeLessThan(
            0.00001,
          );
        }
    }
});

it("reprices retained contributions and resumed runs once, enriching metadata without changing token identity", async () => {
  const who: Identity = {
    id: "pricing",
    workspace_id: "pricing",
    installation_id: "machine",
    scope: "write",
    expires_at: null,
  };
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO workspaces(id,name,created_at) VALUES('pricing','pricing',?)",
    ).bind(Date.now()),
    env.DB.prepare(
      "INSERT INTO installations(workspace_id,id,label,created_at) VALUES('pricing','machine','machine',?)",
    ).bind(Date.now()),
  ]);
  for (const run of ["pricing-a", "pricing-b"])
    await ingest(env, who, {
      events: [
        {
          event_id: run,
          installation_id: "machine",
          execution_id: run,
          run_id: run,
          run_generation: 1,
          sequence: 1,
          observed_at: Date.now(),
          agent: "codex",
          native_session_id: "pricing",
          source_event: "SessionStart",
          data: {},
        },
      ],
    });
  const row = {
    run_id: "pricing-a",
    agent: "codex",
    provider: "openai",
    native_record_id: "pricing-response",
    stream_id: "pricing",
    counter_epoch: "responses-v1",
    model: "gpt-5.6-sol",
    occurred_at: Date.now(),
    measurement_kind: "delta",
    counters: { input: 300000, output: 1000 },
  };
  await usage(env, who, { records: [row, { ...row, run_id: "pricing-b" }] });
  // Simulate a migrated record with no rate in the old catalog.
  await env.DB.prepare(
    "UPDATE usage_records SET resolved_rates='{}',pricing_version='' WHERE workspace_id='pricing'",
  ).run();
  expect((await snapshot(env, "pricing")).cost.codex.priced).toBe(false);
  expect(await reprice(env)).toBe(1);
  expect(await reprice(env)).toBe(0);
  const base = await snapshot(env, "pricing");
  expect(base.cost.codex).toMatchObject({
    tokens: 301000,
    priced: true,
    estimated: true,
  });
  expect(base.cost.codex.dollars).toBeCloseTo(2.43);
  for (const run of base.agents.codex)
    expect(run.usage).toMatchObject({ tokens: 301000, dollars: 2.43 });
  await usage(env, who, {
    records: [{ ...row, pricing: { ...direct, service_tier: "fast" } }],
  });
  expect(await reprice(env)).toBe(1);
  expect((await snapshot(env, "pricing")).cost.codex.dollars).toBeCloseTo(4.86);
  await usage(env, who, { records: [row] }); // Older outbox cannot erase metadata.
  expect(await reprice(env)).toBe(0);
  expect((await snapshot(env, "pricing")).cost.codex.tokens).toBe(301000);
  await expect(
    usage(env, who, { records: [{ ...row, pricing: direct }] }),
  ).rejects.toThrow("usage conflict");
});
