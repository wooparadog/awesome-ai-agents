import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  runInDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { ingest, presence, usage } from "../src/ingest";
import { snapshot } from "../src/snapshot";
import type { Identity } from "../src/auth";
declare const TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
beforeAll(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
});
let seq = 0;
async function setup() {
  const w = `idle-${++seq}`;
  const who: Identity = {
    id: w,
    workspace_id: w,
    installation_id: "m",
    scope: "write",
    expires_at: null,
  };
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?)",
    ).bind(w, w, Date.now()),
    env.DB.prepare(
      "INSERT INTO installations(workspace_id,id,label,created_at) VALUES(?,'m','m',?)",
    ).bind(w, Date.now()),
  ]);
  const events = [1, 2].map((n) => ({
    event_id: `${w}-${n}`,
    installation_id: "m",
    execution_id: `${w}-${n}`,
    run_id: `${w}-${n}`,
    run_generation: 1,
    sequence: 1,
    observed_at: Date.now(),
    agent: "codex",
    native_session_id: `${w}-${n}`,
    source_event: "SessionStart",
    data: {},
  }));
  await ingest(env, who, { events });
  return { w, who, events };
}
it("publishes once for a multi-run presence batch and does nothing for identical retries", async () => {
  const { w, who, events } = await setup();
  const before = (await snapshot(env, w)).revision;
  const payload = {
    observed_at: Date.now(),
    runs: events.map((e) => ({
      run_id: e.run_id,
      execution_id: e.execution_id,
      sequence: 2,
    })),
    usage: true,
    dropped: 0,
  };
  await presence(env, who, payload);
  expect((await snapshot(env, w)).revision).toBe(Number(before) + 1);
  const contact = await env.DB.prepare(
    "SELECT last_contact_at FROM installations WHERE workspace_id=?",
  )
    .bind(w)
    .first();
  await presence(env, who, payload);
  expect((await snapshot(env, w)).revision).toBe(Number(before) + 1);
  expect(
    await env.DB.prepare(
      "SELECT last_contact_at FROM installations WHERE workspace_id=?",
    )
      .bind(w)
      .first(),
  ).toEqual(contact);
  await presence(env, who, {
    observed_at: payload.observed_at + 1000,
    runs: [],
    usage: false,
    dropped: 1,
  });
  expect((await snapshot(env, w)).revision).toBe(Number(before) + 2);
  expect((await snapshot(env, w)).usage_complete).toBe(false);
});
it("resets only the selected workspace, retains live identities, and ignores pre-reset usage replay", async () => {
  const { w, who, events } = await setup();
  const other = await setup();
  const row = {
    run_id: events[0].run_id,
    agent: "codex",
    provider: "openai",
    native_record_id: `${w}-response`,
    stream_id: w,
    counter_epoch: "responses-v1",
    model: "gpt-6-astra",
    occurred_at: Date.now() - 1000,
    measurement_kind: "delta",
    counters: { input: 100, output: 10 },
  };
  await usage(env, who, { records: [row] });
  expect((await snapshot(env, w)).cost.codex.tokens).toBe(110);
  const cutoff = Date.now();
  await env.DB.prepare("UPDATE workspaces SET usage_reset_at=? WHERE id=?")
    .bind(cutoff, w)
    .run();
  const reset = await snapshot(env, w);
  expect(reset.usage_reset_at).toBe(cutoff);
  expect(reset.cost.codex.available).toBe(false);
  expect(reset.agents.codex).toHaveLength(2);
  expect((await snapshot(env, other.w)).agents.codex).toHaveLength(2);
  expect(await usage(env, who, { records: [row] })).toMatchObject({
    ignored: [row.native_record_id],
  });
  expect((await snapshot(env, w)).cost.codex.available).toBe(false);
  await usage(env, who, {
    records: [
      { ...row, native_record_id: `${w}-new`, occurred_at: cutoff + 1 },
    ],
  });
  expect((await snapshot(env, w)).cost.codex.tokens).toBe(110);
});
it("does not persist notifications or schedule alarms without subscribers", async () => {
  const stub = env.SUBSCRIPTIONS.getByName(`no-viewers-${++seq}`);
  await stub.publish("unused", 100);
  await runInDurableObject(stub, async (_instance, state) => {
    expect(await state.storage.get("pending")).toBeUndefined();
    expect(await state.storage.getAlarm()).toBeNull();
  });
});
it("keeps idle sockets beyond five minutes but rechecks revoked credentials before publishing", async () => {
  const { w } = await setup();
  await env.DB.prepare(
    "INSERT INTO api_tokens(id,workspace_id,secret_hash,scope) VALUES(?,?,'unused','read')",
  )
    .bind(w, w)
    .run();
  const stub = env.SUBSCRIPTIONS.getByName(w);
  const response = await stub.fetch(
    new Request("https://internal/subscribe", {
      headers: {
        Upgrade: "websocket",
        "X-Collector-Identity": JSON.stringify({
          id: w,
          workspace_id: w,
          scope: "read",
          expires_at: null,
        }),
      },
    }),
  );
  const ws = response.webSocket!;
  ws.accept();
  const received: string[] = [];
  ws.addEventListener("message", (e) => received.push(String(e.data)));
  await runInDurableObject(stub, async (_instance, state) => {
    const socket = state.getWebSockets()[0];
    const attached = socket.deserializeAttachment();
    expect(attached.deadline - Date.now()).toBeGreaterThan(23 * 3600000);
    socket.serializeAttachment({ ...attached, authorized_until: 0 });
  });
  await env.DB.prepare("UPDATE api_tokens SET revoked_at=? WHERE id=?")
    .bind(Date.now(), w)
    .run();
  await stub.publish(w, 10);
  await runDurableObjectAlarm(stub);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(received.some((text) => text.includes("state.changed"))).toBe(false);
  await runInDurableObject(stub, async (_instance, state) => {
    expect(await state.storage.get("pending")).toBeUndefined();
  });
  ws.close();
});
