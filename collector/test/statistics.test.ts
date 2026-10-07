import { usageQuery } from "./legacy-query";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, it, vi } from "vitest";
import { ingest, usage } from "../src/ingest";
import { dayBounds, snapshot, statisticsQueries } from "../src/snapshot";
import { retain } from "../src/retention";
import { catalog, resolveRates } from "../src/pricing";
import type { Identity } from "../src/auth";
declare const TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
beforeAll(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
});
let sequence = 0;
async function setup() {
  const workspace = `stats-${++sequence}`;
  const who: Identity = {
    id: workspace,
    workspace_id: workspace,
    installation_id: "machine",
    scope: "write",
    expires_at: null,
  };
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?)",
    ).bind(workspace, workspace, Date.now()),
    env.DB.prepare(
      "INSERT INTO installations(workspace_id,id,label,created_at,last_contact_at,capabilities_json) VALUES(?,'machine','machine',?,?,?)",
    ).bind(
      workspace,
      Date.now(),
      Date.now(),
      JSON.stringify({ usage: true, dropped: 0 }),
    ),
  ]);
  const event = {
    event_id: workspace,
    installation_id: "machine",
    execution_id: workspace,
    run_id: workspace,
    run_generation: 1,
    sequence: 1,
    observed_at: Date.now(),
    agent: "codex",
    native_session_id: workspace,
    source_event: "UserPromptSubmit",
    data: { model: "gpt-6-astra" },
  };
  await ingest(env, who, { events: [event] });
  return { workspace, who, event };
}
function record(run: string, id: string, time = Date.now()) {
  return {
    run_id: run,
    agent: "codex",
    provider: "openai",
    native_record_id: id,
    stream_id: run,
    counter_epoch: "responses-v1",
    model: "gpt-6-astra",
    occurred_at: time,
    measurement_kind: "delta",
    counters: { input: 80, cache_read: 20, output: 5 },
  };
}
it("materializes exact totals once while attaching copies to resumed runs", async () => {
  const { workspace, who, event } = await setup();
  const rows = [
    record(workspace, `${workspace}-a`),
    record(workspace, `${workspace}-b`),
  ];
  const initialRevision = (await snapshot(env, workspace)).revision;
  await usage(env, who, { records: rows });
  const before = await snapshot(env, workspace);
  expect(before.revision).toBe(initialRevision + 1);
  expect(before.cost.codex.tokens).toBe(210);
  expect(before.cost.codex.dollars).toBeCloseTo(0.00214);
  expect(before.cost.codex.complete).toBe(true);
  await usage(env, who, { records: rows });
  const retry = await snapshot(env, workspace);
  expect(retry.cost).toEqual(before.cost);
  expect(retry.revision).toBe(before.revision);
  const resumed = `${workspace}-resumed`;
  await ingest(env, who, {
    events: [
      { ...event, event_id: resumed, run_id: resumed, execution_id: resumed },
    ],
  });
  await usage(env, who, {
    records: rows.map((r) => ({ ...r, run_id: resumed })),
  });
  const after = await snapshot(env, workspace);
  expect(after.cost).toEqual(before.cost);
  expect(after.agents.codex.find((r) => r.id === resumed)?.usage).toMatchObject(
    { tokens: 210, available: true },
  );
});
it("recalculates only a late cumulative sample and its successor", async () => {
  const { workspace, who } = await setup();
  const time = Date.now() - 10000;
  const sample = (id: string, time: number, input: number) => ({
    ...record(workspace, id, time),
    counter_epoch: "legacy-epoch",
    measurement_kind: "cumulative",
    counters: { input, output: 0, cache_read: 0 },
  });
  await usage(env, who, {
    records: [
      sample(`${workspace}-a`, time, 100),
      sample(`${workspace}-c`, time + 2000, 300),
    ],
  });
  expect((await snapshot(env, workspace)).cost.codex.tokens).toBe(200);
  await usage(env, who, {
    records: [sample(`${workspace}-b`, time + 1000, 150)],
  });
  const total = (await snapshot(env, workspace)).cost.codex;
  expect(total.tokens).toBe(200);
  expect(total.complete).toBe(false);
  await usage(env, who, {
    records: [record(workspace, `${workspace}-exact`, time - 2)],
  });
  const exact = (await snapshot(env, workspace)).cost.codex;
  expect(exact.tokens).toBe(105);
  expect(exact.complete).toBe(true);
});
it("acknowledges expired replay without storing or recounting it", async () => {
  const { workspace, who } = await setup();
  const stale = record(
    workspace,
    `${workspace}-expired`,
    Date.now() - 8 * 86400000,
  );
  const result = await usage(env, who, { records: [stale] });
  expect(result).toEqual({
    accepted: [stale.native_record_id],
    ignored: [stale.native_record_id],
  });
  expect((await snapshot(env, workspace)).cost.codex.available).toBe(false);
  expect(
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM usage_records WHERE workspace_id=?",
      )
        .bind(workspace)
        .first<{ n: number }>()
    )?.n,
  ).toBe(0);
});
it("bounds statistic reads independently of detailed history size", async () => {
  const { workspace, who } = await setup();
  const now = Date.now(),
    [from, to] = dayBounds(now, "Asia/Singapore");
  await usage(env, who, {
    records: [record(workspace, `${workspace}-seed`, now)],
  });
  const baseline = await env.DB.batch(
    statisticsQueries(env, workspace, from, to),
  );
  const baselineReads = baseline.reduce((n, r) => n + r.meta.rows_read, 0);
  for (let offset = 0; offset < 5000; offset += 100) {
    const batch: D1PreparedStatement[] = [];
    for (let i = offset; i < offset + 100; i++) {
      const id = `${workspace}-bulk-${i}`;
      batch.push(
        env.DB.prepare(
          `INSERT INTO usage_records(workspace_id,id,installation_id,agent,provider,native_record_id,stream_id,counter_epoch,model,
        occurred_at,received_at,measurement_kind,input,output,cache_read,cache_write_5m,cache_write_1h,payload_hash,day_start,day_end,resolved_rates,pricing_version)
        VALUES(?,?,'machine','codex','openai',?,?,'responses-v1','gpt-6-astra',?,?,'delta',80,5,20,0,0,?,?,?,?,?)`,
        ).bind(
          workspace,
          id,
          id,
          workspace,
          now,
          now,
          id,
          from,
          to,
          JSON.stringify(
            resolveRates(
              "openai",
              "gpt-6-astra",
              "delta",
              { input: 80, output: 5, cache_read: 20 },
              {},
              now,
            ),
          ),
          catalog.version,
        ),
      );
      batch.push(
        env.DB.prepare(
          "INSERT INTO usage_observations(workspace_id,usage_id,run_id) VALUES(?,?,?)",
        ).bind(workspace, id, workspace),
      );
    }
    await env.DB.batch(batch);
  }
  const measured = await env.DB.batch(
    statisticsQueries(env, workspace, from, to),
  );
  const reads = measured.reduce((n, r) => n + r.meta.rows_read, 0);
  const legacy = await env.DB.prepare(usageQuery)
    .bind(workspace, from, to)
    .all();
  console.log(
    JSON.stringify({
      benchmark: "5001 usage records, one active run",
      before_rows_read: legacy.meta.rows_read,
      after_rows_read: reads,
      baseline_rows_read: baselineReads,
    }),
  );
  expect({ legacy_rows_read: legacy.meta.rows_read, compact_rows_read: reads })
    .toMatchInlineSnapshot(`
    {
      "compact_rows_read": 4,
      "legacy_rows_read": 170036,
    }
  `);
  expect(reads).toBeLessThanOrEqual(baselineReads + 4);
  expect(reads).toBeLessThan(50);
  expect(legacy.meta.rows_read).toBeGreaterThan(reads * 100);
  const logs = vi.spyOn(console, "info").mockImplementation(() => {});
  const current = await snapshot(env, workspace);
  const readCost = logs.mock.calls
    .map(([text]) => JSON.parse(String(text)))
    .find((entry) => entry.event === "snapshot_read_cost");
  logs.mockRestore();
  expect(current.cost.codex.tokens).toBe(5001 * 105);
  expect(readCost.rows_read).toBeLessThan(50);
  expect(readCost).toMatchInlineSnapshot(`
    {
      "event": "snapshot_read_cost",
      "rows_read": 10,
      "statistics_buckets": 2,
    }
  `);
  let cleanupReads = 0;
  const measuredDb = new Proxy(env.DB, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          cleanupReads += results.reduce((sum, r) => sum + r.meta.rows_read, 0);
          return results;
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await retain({ ...env, DB: measuredDb }, now);
  expect(cleanupReads).toBeLessThan(50);
  const afterCleanup = await env.DB.prepare(
    "SELECT last_run FROM maintenance_runs WHERE id='compact'",
  ).first();
  await retain(env, now + 1000);
  expect(
    await env.DB.prepare(
      "SELECT last_run FROM maintenance_runs WHERE id='compact'",
    ).first(),
  ).toEqual(afterCleanup);
}, 30000);
