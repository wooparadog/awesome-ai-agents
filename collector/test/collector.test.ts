import { usageQuery } from "./legacy-query";
import { env, exports } from "cloudflare:workers";
import {
  applyD1Migrations,
  runDurableObjectAlarm,
  runInDurableObject,
  evictDurableObject,
} from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { hash } from "../src/protocol";
import { dayBounds, summarize } from "../src/snapshot";
import { publishPending } from "../src/subscriptions";
declare const TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
const secret = "a".repeat(43),
  workspace = "w";
let counter = 0;
beforeAll(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
  await env.DB.prepare(
    "INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?)",
  )
    .bind(workspace, "test", Date.now())
    .run();
  for (const id of ["m1", "m2"]) {
    await env.DB.prepare(
      "INSERT INTO installations(workspace_id,id,label,created_at) VALUES(?,?,?,?)",
    )
      .bind(workspace, id, id, Date.now())
      .run();
    await env.DB.prepare(
      "INSERT INTO api_tokens(id,workspace_id,secret_hash,scope,installation_id) VALUES(?,?,?,?,?)",
    )
      .bind(id, workspace, await hash(secret), "write", id)
      .run();
  }
  await env.DB.prepare(
    "INSERT INTO api_tokens(id,workspace_id,secret_hash,scope) VALUES(?,?,?,?)",
  )
    .bind("reader", workspace, await hash(secret), "read")
    .run();
});
async function request(path: string, token = "reader", value?: unknown) {
  return exports.default.fetch("https://test" + path, {
    method: value ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}.${secret}`,
      "Content-Type": "application/json",
    },
    body: value ? JSON.stringify(value) : undefined,
  });
}
function event(overrides: Record<string, unknown> = {}) {
  const n = ++counter;
  return {
    event_id: "e" + n,
    installation_id: "m1",
    execution_id: "x" + n,
    run_id: "r" + n,
    run_generation: 1,
    sequence: 1,
    observed_at: Date.now(),
    agent: "claude",
    native_session_id: "s" + n,
    source_event: "UserPromptSubmit",
    data: { cwd: "/tmp/project" },
    ...overrides,
  };
}
async function send(events: unknown[], token = "m1") {
  return request("/v1/events", token, { schema_version: 1, events });
}
it("rejects missing credentials, wrong scopes and foreign installation writes", async () => {
  expect((await exports.default.fetch("https://test/v1/snapshot")).status).toBe(
    401,
  );
  expect((await request("/v1/snapshot", "m1")).status).toBe(403);
  expect((await send([event({ installation_id: "m2" })])).status).toBe(403);
});
it("deduplicates a committed retry and rejects conflicting payload atomically", async () => {
  const e = event();
  expect((await send([e])).status).toBe(200);
  const before = await env.DB.prepare(
    "SELECT revision FROM workspaces WHERE id=?",
  )
    .bind(workspace)
    .first<{ revision: number }>();
  expect((await send([e])).status).toBe(200);
  expect(
    (
      await env.DB.prepare("SELECT revision FROM workspaces WHERE id=?")
        .bind(workspace)
        .first<{ revision: number }>()
    )?.revision,
  ).toBe(before?.revision);
  const other = event();
  expect(
    (await send([other, { ...e, data: { cwd: "/different" } }])).status,
  ).toBe(409);
  expect(
    await env.DB.prepare("SELECT id FROM events WHERE workspace_id=? AND id=?")
      .bind(workspace, other.event_id)
      .first(),
  ).toBeNull();
});
it("orders state per execution and keeps compaction and neutral messages neutral", async () => {
  const e = event({ source_event: "Stop", sequence: 3 });
  expect(
    (
      await send([
        e,
        {
          ...e,
          event_id: "late" + counter,
          sequence: 1,
          source_event: "UserPromptSubmit",
        },
      ])
    ).status,
  ).toBe(200);
  expect(
    (
      await send([
        {
          ...e,
          event_id: "compact" + counter,
          sequence: 4,
          source_event: "SessionStart",
          data: { source: "compact" },
        },
      ])
    ).status,
  ).toBe(200);
  const run = await env.DB.prepare(
    "SELECT state FROM session_runs WHERE workspace_id=? AND id=?",
  )
    .bind(workspace, e.run_id)
    .first<{ state: string }>();
  expect(run?.state).toBe("done");
});
it("separates machines with the same native session and retires earlier generations", async () => {
  const e = event({ native_session_id: "shared" });
  expect((await send([e])).status).toBe(200);
  expect(
    (
      await send(
        [{ ...event(), native_session_id: "shared", installation_id: "m2" }],
        "m2",
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await send([
        {
          ...e,
          event_id: "next" + counter,
          run_id: "next" + counter,
          run_generation: 2,
          sequence: 3,
          native_session_id: "other",
        },
      ])
    ).status,
  ).toBe(200);
  expect(
    (await send([{ ...e, event_id: "old" + counter, sequence: 2 }])).status,
  ).toBe(200);
  const r = await env.DB.prepare(
    "SELECT end_reason FROM session_runs WHERE workspace_id=? AND id=?",
  )
    .bind(workspace, e.run_id)
    .first<{ end_reason: string }>();
  expect(r?.end_reason).toBe("superseded");
});
it("does not renew presence with duplicate or old observations", async () => {
  const e = event();
  await send([e]);
  const payload = {
    schema_version: 1,
    observed_at: Date.now(),
    runs: [{ run_id: e.run_id, execution_id: e.execution_id, sequence: 2 }],
    usage: true,
  };
  expect((await request("/v1/presence", "m1", payload)).status).toBe(200);
  const before = await env.DB.prepare(
    "SELECT presence_received_at FROM session_runs WHERE workspace_id=? AND id=?",
  )
    .bind(workspace, e.run_id)
    .first();
  expect((await request("/v1/presence", "m1", payload)).status).toBe(200);
  expect(
    await env.DB.prepare(
      "SELECT presence_received_at FROM session_runs WHERE workspace_id=? AND id=?",
    )
      .bind(workspace, e.run_id)
      .first(),
  ).toEqual(before);
  expect(
    (
      await request("/v1/presence", "m1", {
        ...payload,
        observed_at: Date.now() - 300000,
      })
    ).status,
  ).toBe(400);
});
it("deduplicates copied usage and derives cumulative deltas after late snapshots", async () => {
  const e = event();
  await send([e]);
  const t = Date.now() - 10000;
  const base = {
    run_id: e.run_id,
    agent: "codex",
    provider: "openai",
    stream_id: e.run_id,
    counter_epoch: "0",
    model: "unknown",
    measurement_kind: "cumulative",
  };
  const record = (id: string, time: number, input: number) => ({
    ...base,
    native_record_id: id,
    occurred_at: time,
    counters: { input, output: 0, cache_read: 0 },
  });
  const a = record("base" + counter, t, 100),
    b = record("last" + counter, t + 2000, 300),
    mid = record("mid" + counter, t + 1000, 150);
  expect(
    (await request("/v1/usage", "m1", { schema_version: 1, records: [a, b] }))
      .status,
  ).toBe(200);
  expect(
    (await request("/v1/usage", "m1", { schema_version: 1, records: [mid, b] }))
      .status,
  ).toBe(200);
  const rows = await env.DB.prepare(
    "SELECT input,incomplete FROM usage_deltas WHERE workspace_id=? AND id IN (SELECT id FROM usage_records WHERE stream_id=?) ORDER BY occurred_at",
  )
    .bind(workspace, e.run_id)
    .all();
  expect(rows.results).toEqual([
    { input: 0, incomplete: 1 },
    { input: 50, incomplete: 0 },
    { input: 150, incomplete: 0 },
  ]);
  expect((await request("/v1/snapshot")).status).toBe(200);
});
it("handles local day boundaries including daylight saving", () => {
  const now = Date.parse("2026-03-08T16:00:00Z");
  expect(dayBounds(now, "America/New_York")).toEqual([
    Date.parse("2026-03-08T05:00:00Z"),
    Date.parse("2026-03-09T04:00:00Z"),
  ]);
});
it("checks every run in a usage batch and keeps ownership checks scoped to the request", async () => {
  const own = event(),
    foreign = event({ installation_id: "m2" });
  await send([own]);
  await send([foreign], "m2");
  const record = (run_id: string, suffix: string) => ({
    run_id,
    agent: "claude",
    provider: "anthropic",
    native_record_id: `${own.run_id}-${suffix}`,
    stream_id: own.run_id,
    measurement_kind: "delta",
    model: "claude-opus-5",
    occurred_at: Date.now(),
    counters: { input: 10, output: 1 },
  });
  const records = [record(own.run_id, "a"), record(own.run_id, "b")];
  expect(
    (
      await request("/v1/usage", "m1", {
        schema_version: 1,
        records: [...records, record(foreign.run_id, "foreign")],
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM usage_records WHERE workspace_id=? AND stream_id=?",
      )
        .bind(workspace, own.run_id)
        .first<{ n: number }>()
    )?.n,
  ).toBe(0);
  expect(
    (await request("/v1/usage", "m1", { schema_version: 1, records })).status,
  ).toBe(200);
  expect(
    (await request("/v1/usage", "m2", { schema_version: 1, records })).status,
  ).toBe(409);
});
it("deduplicates Claude content blocks with different timestamps but rejects changed counters", async () => {
  const e = event();
  await send([e]);
  const record = {
    run_id: e.run_id,
    agent: "claude",
    provider: "anthropic",
    native_record_id: `${e.run_id}-message|request`,
    stream_id: `${e.run_id}-message|request`,
    counter_epoch: "0",
    model: "claude-fable-5-1",
    measurement_kind: "delta",
    occurred_at: Date.now() - 1000,
    counters: { input: 100, output: 5 },
  };
  const copy = { ...record, occurred_at: record.occurred_at + 3 };
  expect(
    (
      await request("/v1/usage", "m1", {
        schema_version: 1,
        records: [record, copy],
      })
    ).status,
  ).toBe(200);
  expect(
    (await request("/v1/usage", "m1", { schema_version: 1, records: [copy] }))
      .status,
  ).toBe(200);
  expect(
    (
      await request("/v1/usage", "m1", {
        schema_version: 1,
        records: [{ ...copy, counters: { input: 101, output: 5 } }],
      })
    ).status,
  ).toBe(409);
  const rows = await env.DB.prepare(
    "SELECT occurred_at,input,output FROM usage_records WHERE workspace_id=? AND stream_id=?",
  )
    .bind(workspace, record.stream_id)
    .all();
  expect(rows.results).toEqual([
    { occurred_at: record.occurred_at, input: 100, output: 5 },
  ]);
});
it("replaces legacy Codex estimates with deduplicated response usage and prices Astra", async () => {
  const e = event({ agent: "codex" });
  await send([e]);
  const time = Date.now();
  const base = {
    run_id: e.run_id,
    agent: "codex",
    provider: "openai",
    stream_id: e.run_id,
    counter_epoch: "0",
    model: "gpt-6-astra",
    measurement_kind: "cumulative",
    counters: { input: 100, output: 5, cache_read: 20 },
  };
  const legacy = [0, 1].map((i) => ({
    ...base,
    native_record_id: `${e.run_id}-legacy-${i}`,
    occurred_at: time + i * 1000,
    counters: { input: 100 + i * 100, output: 5 + i * 5, cache_read: 20 },
  }));
  const responses = [0, 1].map((i) => ({
    ...base,
    native_record_id: `${e.run_id}-response-${i}`,
    counter_epoch: "responses-v1",
    measurement_kind: "delta",
    occurred_at: time + i * 1000 - 2,
    counters: { input: 70, output: 5, cache_read: 20, cache_write_5m: 10 },
  }));
  for (const records of [legacy, responses, responses]) {
    expect(
      (await request("/v1/usage", "m1", { schema_version: 1, records })).status,
    ).toBe(200);
  }
  const rows = await env.DB.prepare(usageQuery)
    .bind(workspace, time - 2, time + 1001)
    .all();
  const ids = await Promise.all(
    responses.map((r) =>
      hash(JSON.stringify([r.provider, r.native_record_id])),
    ),
  );
  const own = rows.results.filter((r) => ids.includes(String(r.id)));
  expect(own).toHaveLength(2);
  const legacyIds = await Promise.all(
    legacy.map((r) => hash(JSON.stringify([r.provider, r.native_record_id]))),
  );
  expect(rows.results.some((r) => legacyIds.includes(String(r.id)))).toBe(
    false,
  );
  const totals = summarize(own).codex;
  expect(totals.tokens).toBe(210);
  expect(totals.complete).toBe(true);
  expect(totals.priced).toBe(true);
  expect(totals.dollars).toBeCloseTo(0.00219);
  expect(
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM usage_records WHERE workspace_id=? AND stream_id=?",
      )
        .bind(workspace, e.run_id)
        .first<{ n: number }>()
    )?.n,
  ).toBe(4);
  const older = legacy.map((r, i) => ({
    ...r,
    native_record_id: `${e.run_id}-older-${i}`,
    occurred_at: time - 3000 + i * 1000,
    counters: { input: 10 + i * 10, output: 0, cache_read: 0 },
  }));
  expect(
    (await request("/v1/usage", "m1", { schema_version: 1, records: older }))
      .status,
  ).toBe(200);
  const prefix = await env.DB.prepare(
    "SELECT input,incomplete FROM usage_deltas WHERE workspace_id=? AND id IN (?,?) ORDER BY occurred_at",
  )
    .bind(
      workspace,
      ...(await Promise.all(
        older.map((r) =>
          hash(JSON.stringify([r.provider, r.native_record_id])),
        ),
      )),
    )
    .all();
  expect(prefix.results).toEqual([
    { input: 0, incomplete: 1 },
    { input: 10, incomplete: 0 },
  ]);
});
it("broadcasts revisions and restores socket attachments after hibernation", async () => {
  const r = await exports.default.fetch("https://test/v1/subscribe", {
    headers: { Authorization: `Bearer reader.${secret}`, Upgrade: "websocket" },
  });
  expect(r.status).toBe(101);
  const ws = r.webSocket!;
  ws.accept();
  const messages: string[] = [];
  ws.addEventListener("message", (ev) => {
    messages.push(String(ev.data));
  });
  const stub = env.SUBSCRIPTIONS.getByName(workspace);
  await evictDurableObject(stub);
  const e = event();
  await send([e]);
  await publishPending(env, workspace);
  await runDurableObjectAlarm(stub);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(messages.some((m) => JSON.parse(m).type === "state.changed")).toBe(
    true,
  );
  ws.send("ping");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(messages).toContain("pong");
  await runInDurableObject(stub, async (_instance, state) => {
    for (const socket of state.getWebSockets()) {
      const a = socket.deserializeAttachment();
      socket.serializeAttachment({ ...a, deadline: 0 });
    }
  });
  await runDurableObjectAlarm(stub);
  ws.close();
});

it("recovers durable pending notifications and coalesces an unacknowledged subscriber", async () => {
  const stub = env.SUBSCRIPTIONS.getByName("recovery-" + Date.now());
  const r = await stub.fetch(
    new Request("https://internal/subscribe", {
      headers: {
        Upgrade: "websocket",
        "X-Collector-Identity": JSON.stringify({
          id: "reader",
          scope: "read",
          workspace_id: workspace,
          expires_at: null,
        }),
      },
    }),
  );
  const ws = r.webSocket!;
  ws.accept();
  const revisions: number[] = [];
  ws.addEventListener("message", (ev) => {
    const v = JSON.parse(String(ev.data));
    if (v.revision) revisions.push(v.revision);
  });
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put("pending", { workspace, revision: 5 });
    await state.storage.setAlarm(Date.now() + 1000);
  });
  await evictDurableObject(stub);
  await runDurableObjectAlarm(stub);
  await stub.publish(workspace, 6);
  await runDurableObjectAlarm(stub);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(revisions).toEqual([5]);
  ws.send(JSON.stringify({ type: "ack", revision: 5 }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(revisions).toEqual([5, 6]);
  ws.close();
});

it("prunes detailed usage while retaining compact totals and a cumulative baseline", async () => {
  const { retain } = await import("../src/retention");
  const { reprice } = await import("../src/reprice");
  const w = "archive",
    now = Date.now(),
    old = now - 10 * 86400000;
  await env.DB.prepare(
    "INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?)",
  )
    .bind(w, w, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO installations(workspace_id,id,label,created_at) VALUES(?,?,?,?)",
  )
    .bind(w, "a", "a", now)
    .run();
  for (const [id, time, input] of [
    ["a", old, 100],
    ["b", old + 1000, 200],
    ["c", now, 300],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO usage_records(workspace_id,id,installation_id,agent,provider,native_record_id,stream_id,counter_epoch,
      model,occurred_at,received_at,measurement_kind,input,output,cache_read,cache_write_5m,cache_write_1h,payload_hash,day_start,day_end)
      VALUES(?,?,?,'codex','openai',?,'stream','0','unknown',?,?,'cumulative',?,0,0,0,0,?,?,?)`,
    )
      .bind(
        w,
        id,
        "a",
        id,
        time,
        time,
        input,
        id,
        ...dayBounds(time, "Asia/Singapore"),
      )
      .run();
  }
  while (await reprice(env)) {
    /* Upgrade old evidence before retention. */
  }
  await retain(env, now);
  await retain(env, now + 3600000);
  const current = await env.DB.prepare(
    "SELECT input,incomplete FROM usage_deltas WHERE workspace_id=? AND id=?",
  )
    .bind(w, "c")
    .first();
  expect(current).toEqual({ input: 100, incomplete: 0 });
  const total = await env.DB.prepare(
    "SELECT SUM(input+output+cache_read+cache_write_5m+cache_write_1h) AS tokens FROM usage_rollups WHERE workspace_id=? AND run_id='' AND day_start<?",
  )
    .bind(w, now - 7 * 86400000)
    .first();
  expect(total).toEqual({ tokens: 100 });
  expect(
    await env.DB.prepare(
      "SELECT id FROM usage_records WHERE workspace_id=? AND id=?",
    )
      .bind(w, "a")
      .first(),
  ).toBeNull();
  expect(
    await env.DB.prepare(
      "SELECT id FROM usage_records WHERE workspace_id=? AND id=?",
    )
      .bind(w, "b")
      .first(),
  ).not.toBeNull();
});

it("keeps migration DDL separate for D1's remote SQL splitter", () => {
  for (const migration of TEST_MIGRATIONS) {
    for (const query of migration.queries) {
      // An unbalanced CASE/END in Wrangler's splitter can swallow following
      // tables into a trigger, which local execution tolerates but remote rejects.
      const declarations =
        query.match(
          /\bCREATE\s+(?:TABLE|VIEW|TRIGGER|(?:UNIQUE\s+)?INDEX)\b/gi,
        ) || [];
      expect(declarations.length, migration.name).toBeLessThanOrEqual(1);
      // The remote D1 query parser also splits unparenthesized SELECT CASE
      // inside triggers, even when the local Wrangler splitter keeps it whole.
      if (/^CREATE\s+TRIGGER/i.test(query.trim()))
        expect(query, migration.name).not.toMatch(/\bSELECT\s+CASE\b/i);
    }
  }
});

it("keeps presence live between five-minute checks and expires it after ten minutes", async () => {
  const e = event();
  await send([e]);
  const lastSeen = Date.now() - 6 * 60 * 1000;
  await env.DB.prepare(
    "UPDATE session_runs SET presence_received_at=?,last_alive_observed_at=? WHERE workspace_id=? AND id=?",
  )
    .bind(lastSeen, lastSeen, workspace, e.run_id)
    .run();
  await env.DB.prepare(
    "UPDATE installations SET last_contact_at=?,capabilities_json=? WHERE workspace_id=?",
  )
    .bind(lastSeen, JSON.stringify({ usage: true, dropped: 0 }), workspace)
    .run();
  type Snapshot = {
    agents: Record<string, { id: string; freshness: string }[]>;
    usage_complete: boolean;
  };
  const fresh = await (await request("/v1/snapshot")).json<Snapshot>();
  expect(fresh.agents.claude.find((r) => r.id === e.run_id)?.freshness).toBe(
    "live",
  );
  expect(fresh.usage_complete).toBe(true);
  const expired = Date.now() - 10 * 60 * 1000 - 1;
  await env.DB.prepare(
    "UPDATE session_runs SET presence_received_at=?,last_alive_observed_at=? WHERE workspace_id=? AND id=?",
  )
    .bind(expired, expired, workspace, e.run_id)
    .run();
  await env.DB.prepare(
    "UPDATE installations SET last_contact_at=? WHERE workspace_id=? AND id='m1'",
  )
    .bind(expired, workspace)
    .run();
  const stale = await (await request("/v1/snapshot")).json<Snapshot>();
  expect(stale.agents.claude.find((r) => r.id === e.run_id)?.freshness).toBe(
    "stale",
  );
  expect(stale.usage_complete).toBe(false);
});
