import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { hash } from "../src/protocol";
import { retain } from "../src/retention";
declare const TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
const secret = "b".repeat(43);
let serial = 0;
beforeAll(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
});
async function writer(expires: number | null = null) {
  const id = "browser-writer-" + ++serial,
    workspace = "browser-workspace-" + serial;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?)",
    ).bind(workspace, workspace, Date.now()),
    env.DB.prepare(
      "INSERT INTO installations(workspace_id,id,label,created_at) VALUES(?,?,?,?)",
    ).bind(workspace, id, id, Date.now()),
    env.DB.prepare(
      "INSERT INTO api_tokens(id,workspace_id,secret_hash,scope,installation_id,expires_at) VALUES(?,?,?,'write',?,?)",
    ).bind(id, workspace, await hash(secret), id, expires),
  ]);
  return { id, workspace, token: id + "." + secret };
}
async function post(
  path: string,
  payload: unknown,
  token?: string,
  origin = "https://test",
) {
  return exports.default.fetch("https://test" + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify({ schema_version: 1, ...(payload as object) }),
  });
}
async function link(token: string, expires_in = 600) {
  const r = await post("/v1/browser-links", { expires_in }, token);
  expect(r.status).toBe(200);
  const value = await r.json<{
    url: string;
    expires_at: number;
    browser_expires_at: number;
  }>();
  return {
    ...value,
    token: new URLSearchParams(new URL(value.url).hash.slice(1)).get("token")!,
  };
}
async function login(token: string) {
  const grant = await link(token);
  const r = await post("/v1/browser-login", { token: grant.token });
  expect(r.status).toBe(200);
  return r.json<{ token: string; expires_at: number; workspace_id: string }>();
}
async function snapshot(token: string) {
  return exports.default.fetch("https://test/v1/snapshot", {
    headers: { Authorization: "Bearer " + token },
  });
}
it("serves public homepage and assets with restrictive browser headers", async () => {
  for (const path of ["/", "/login", "/panel"]) {
    const r = await exports.default.fetch("https://test" + path);
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Security-Policy")).toContain(
      "script-src 'self'",
    );
    expect(r.headers.get("Referrer-Policy")).toBe("no-referrer");
    const html = await r.text();
    expect(html).toContain("ai-agents web --expires 10m");
    expect(html).not.toContain("browser-writer");
  }
  expect((await exports.default.fetch("https://test/app.js")).status).toBe(200);
  expect((await exports.default.fetch("https://test/v1/snapshot")).status).toBe(
    401,
  );
});
it("creates expiring fragment links and distinct workspace-bound read tokens", async () => {
  const owner = await writer();
  const grant = await link(owner.token);
  expect(new URL(grant.url).search).toBe("");
  expect(grant.expires_at - Date.now()).toBeLessThanOrEqual(600000);
  const redeemed = await post("/v1/browser-login", { token: grant.token });
  expect(redeemed.status).toBe(200);
  const browser = await redeemed.json<{
    token: string;
    expires_at: number;
    workspace_id: string;
  }>();
  expect(browser.workspace_id).toBe(owner.workspace);
  expect(browser.token).not.toBe(owner.token);
  expect((await snapshot(browser.token)).status).toBe(200);
  expect((await post("/v1/events", { events: [] }, browser.token)).status).toBe(
    403,
  );
  expect((await post("/v1/browser-links", {}, browser.token)).status).toBe(403);
  expect((await snapshot(owner.token)).status).toBe(403);
  const stored = await env.DB.prepare("SELECT * FROM api_tokens WHERE id=?")
    .bind(browser.token.split(".")[0])
    .first();
  expect(stored?.scope).toBe("read");
  expect(stored?.parent_token_id).toBe(owner.id);
  expect(stored?.secret_hash).toBe(await hash(browser.token.split(".")[1]));
  expect(JSON.stringify(stored)).not.toContain(browser.token.split(".")[1]);
});
it("redeems each link once under concurrent requests", async () => {
  const owner = await writer(),
    grant = await link(owner.token);
  const responses = await Promise.all(
    Array.from({ length: 5 }, () =>
      post("/v1/browser-login", { token: grant.token }),
    ),
  );
  expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
  expect(responses.filter((r) => r.status === 410)).toHaveLength(4);
  const rows = await env.DB.prepare(
    "SELECT id FROM api_tokens WHERE parent_token_id=?",
  )
    .bind(owner.id)
    .all();
  expect(rows.results).toHaveLength(1);
});
it("rejects expired, altered, cross-origin and revoked links without granting access", async () => {
  const owner = await writer(),
    grant = await link(owner.token);
  const [id] = grant.token.split(".");
  expect(
    (await post("/v1/browser-login", { token: id + "." + "c".repeat(43) }))
      .status,
  ).toBe(401);
  expect(
    (
      await post(
        "/v1/browser-login",
        { token: grant.token },
        undefined,
        "https://evil.example",
      )
    ).status,
  ).toBe(403);
  await env.DB.prepare("UPDATE browser_links SET expires_at=? WHERE id=?")
    .bind(Date.now() - 1, id)
    .run();
  expect((await post("/v1/browser-login", { token: grant.token })).status).toBe(
    410,
  );
  const second = await link(owner.token);
  await env.DB.prepare("UPDATE api_tokens SET revoked_at=? WHERE id=?")
    .bind(Date.now(), owner.id)
    .run();
  expect(
    (await post("/v1/browser-login", { token: second.token })).status,
  ).toBe(401);
});
it("bounds grants and inherits parent expiry and revocation", async () => {
  const expiry = Date.now() + 120000,
    owner = await writer(expiry),
    browser = await login(owner.token);
  expect(browser.expires_at).toBe(expiry);
  expect(
    (await post("/v1/browser-links", { expires_in: 0 }, owner.token)).status,
  ).toBe(400);
  expect(
    (await post("/v1/browser-links", { expires_in: 3601 }, owner.token)).status,
  ).toBe(400);
  for (let i = 0; i < 8; i++) await link(owner.token);
  expect((await post("/v1/browser-links", {}, owner.token)).status).toBe(429);
  await env.DB.prepare(
    "UPDATE installations SET disabled_at=? WHERE workspace_id=? AND id=?",
  )
    .bind(Date.now(), owner.workspace, owner.id)
    .run();
  expect((await snapshot(browser.token)).status).toBe(401);
});
it("exchanges one-use WebSocket tickets without credentials in URLs", async () => {
  const owner = await writer(),
    browser = await login(owner.token);
  const ticketResponse = await post("/v1/browser-ticket", {}, browser.token);
  expect(ticketResponse.status).toBe(200);
  const { ticket } = await ticketResponse.json<{ ticket: string }>();
  const headers = {
    Upgrade: "websocket",
    Origin: "https://test",
    "Sec-WebSocket-Protocol": "ai-agents.v1, ticket." + ticket,
  };
  const wrong = await exports.default.fetch(
    "https://test/v1/browser-subscribe",
    { headers: { ...headers, Origin: "https://evil.example" } },
  );
  expect(wrong.status).toBe(403);
  const response = await exports.default.fetch(
    "https://test/v1/browser-subscribe",
    { headers },
  );
  expect(response.status).toBe(101);
  expect(response.headers.get("Sec-WebSocket-Protocol")).toBe("ai-agents.v1");
  response.webSocket!.accept();
  response.webSocket!.close();
  expect(
    (
      await exports.default.fetch("https://test/v1/browser-subscribe", {
        headers,
      })
    ).status,
  ).toBe(401);
});
it("checks revoked browser credentials again when a ticket is consumed", async () => {
  const owner = await writer(),
    browser = await login(owner.token);
  const { ticket } = await (
    await post("/v1/browser-ticket", {}, browser.token)
  ).json<{ ticket: string }>();
  expect((await post("/v1/browser-logout", {}, browser.token)).status).toBe(
    200,
  );
  expect((await snapshot(browser.token)).status).toBe(401);
  const response = await exports.default.fetch(
    "https://test/v1/browser-subscribe",
    {
      headers: {
        Upgrade: "websocket",
        Origin: "https://test",
        "Sec-WebSocket-Protocol": "ai-agents.v1, ticket." + ticket,
      },
    },
  );
  expect(response.status).toBe(401);
});
it("prunes expired browser credentials and rate rows without deleting writer credentials", async () => {
  const owner = await writer(),
    browser = await login(owner.token);
  await post("/v1/browser-ticket", {}, browser.token);
  await env.DB.prepare("DELETE FROM maintenance_runs WHERE id='compact'").run();
  await retain(env, Date.now() + 31 * 86400000);
  expect(
    await env.DB.prepare("SELECT id FROM api_tokens WHERE id=?")
      .bind(browser.token.split(".")[0])
      .first(),
  ).toBeNull();
  expect(
    await env.DB.prepare("SELECT id FROM api_tokens WHERE id=?")
      .bind(owner.id)
      .first(),
  ).not.toBeNull();
  expect(
    (
      await env.DB.prepare(
        "SELECT id FROM browser_links WHERE parent_token_id=?",
      )
        .bind(owner.id)
        .all()
    ).results,
  ).toHaveLength(0);
});
