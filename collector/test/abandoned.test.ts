import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { ingest } from "../src/ingest";
import { snapshot } from "../src/snapshot";
import { ABANDONED_AFTER_MS, endAbandoned } from "../src/abandoned";
import type { Identity } from "../src/auth";
declare const TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
beforeAll(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
});

it("ends runs without evidence past the retry horizon and keeps quiet live runs", async () => {
  const w = "abandoned";
  const who: Identity = {
    id: w,
    workspace_id: w,
    installation_id: "m",
    scope: "write",
    expires_at: null,
  };
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?)",
    ).bind(w, w, now),
    env.DB.prepare(
      "INSERT INTO installations(workspace_id,id,label,created_at) VALUES(?,'m','m',?)",
    ).bind(w, now),
  ]);
  const runs = ["unverified", "stale", "quiet", "recent"];
  await ingest(env, who, {
    events: runs.map((id) => ({
      event_id: id,
      installation_id: "m",
      execution_id: id,
      run_id: id,
      run_generation: 1,
      sequence: 1,
      observed_at: now,
      agent: "claude",
      native_session_id: id,
      source_event: "Stop",
      data: { pid: id === "unverified" ? 0 : 1 },
    })),
  });
  const old = now - ABANDONED_AFTER_MS - 60000;
  const evidence = {
    unverified: [old, null],
    stale: [old - 60000, old],
    quiet: [old, now - 60000],
    recent: [now - 60000, null],
  };
  await env.DB.batch(
    Object.entries(evidence).map(([id, [activity, presence]]) =>
      env.DB.prepare(
        "UPDATE session_runs SET last_activity_at=?1,presence_received_at=?2,last_alive_observed_at=?2 WHERE workspace_id=?3 AND id=?4",
      ).bind(activity, presence, w, id),
    ),
  );
  const before = (await snapshot(env, w)).revision;
  expect(await endAbandoned(env, now)).toBe(2);
  const rows = await env.DB.prepare(
    "SELECT id,state,ended_at,end_reason FROM session_runs WHERE workspace_id=? ORDER BY id",
  )
    .bind(w)
    .all();
  expect(rows.results).toEqual([
    { id: "quiet", state: "done", ended_at: null, end_reason: null },
    { id: "recent", state: "done", ended_at: null, end_reason: null },
    { id: "stale", state: "ended", ended_at: old, end_reason: "abandoned" },
    {
      id: "unverified",
      state: "ended",
      ended_at: old,
      end_reason: "abandoned",
    },
  ]);
  const after = await snapshot(env, w);
  expect(after.revision).toBe(before + 1);
  expect([after.stale, after.unverified]).toEqual([0, 1]);
  expect(await endAbandoned(env, now)).toBe(0);
  expect((await snapshot(env, w)).revision).toBe(after.revision);
});
