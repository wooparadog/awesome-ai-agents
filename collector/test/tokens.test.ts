import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { hash } from "../src/protocol";
declare const TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
const secret = "t".repeat(43);
let counter = 0;
beforeAll(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
});
async function call(
  path: string,
  token: string,
  method = "GET",
  payload?: Record<string, unknown>,
  origin = "https://test",
) {
  return exports.default.fetch("https://test" + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      Origin: origin,
      "Content-Type": "application/json",
    },
    body: payload
      ? JSON.stringify({ schema_version: 1, ...payload })
      : undefined,
  });
}
async function setup(management = true) {
  const id = "token-owner-" + ++counter,
    workspace = "token-workspace-" + counter;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?)",
    ).bind(workspace, workspace, Date.now()),
    env.DB.prepare(
      "INSERT INTO installations(workspace_id,id,label,created_at) VALUES(?,?,?,?)",
    ).bind(workspace, id, id, Date.now()),
    env.DB.prepare(
      "INSERT INTO api_tokens(id,workspace_id,secret_hash,scope,installation_id) VALUES(?,?,?,'write',?)",
    ).bind(id, workspace, await hash(secret), id),
  ]);
  const writer = id + "." + secret;
  const link = await call("/v1/browser-links", writer, "POST", {
    manage_tokens: management,
  });
  expect(link.status).toBe(200);
  const grant = await link.json<{ url: string; can_manage_tokens: boolean }>();
  expect(grant.can_manage_tokens).toBe(management);
  const token = new URLSearchParams(new URL(grant.url).hash.slice(1)).get(
    "token",
  );
  const login = await call("/v1/browser-login", "", "POST", { token });
  expect(login.status).toBe(200);
  const browser = await login.json<{
    token: string;
    can_manage_tokens: boolean;
  }>();
  expect(browser.can_manage_tokens).toBe(management);
  return { id, workspace, writer, browser: browser.token };
}
async function create(
  browser: string,
  overrides: Record<string, unknown> = {},
) {
  const response = await call("/v1/tokens", browser, "POST", {
    label: "Test viewer",
    scope: "read",
    expires_at: Date.now() + 86400000,
    ...overrides,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json<{
    token: string;
    metadata: {
      id: string;
      updated_at: number;
      expires_at: number;
      label: string;
    };
  }>();
}
it("requires explicit management login and leaves legacy read access unchanged", async () => {
  const owner = await setup(false);
  expect((await call("/v1/token-access", owner.browser)).status).toBe(200);
  expect(
    await (await call("/v1/token-access", owner.browser)).json(),
  ).toMatchObject({ can_manage_tokens: false });
  for (const [path, method, payload] of [
    ["/v1/tokens", "GET", undefined],
    ["/v1/tokens", "POST", {}],
    ["/v1/tokens/" + owner.id, "PATCH", {}],
    ["/v1/tokens/" + owner.id, "DELETE", {}],
  ] as const) {
    expect((await call(path, owner.browser, method, payload)).status).toBe(403);
  }
  expect((await call("/v1/tokens", owner.writer)).status).toBe(403);
  expect((await call("/v1/snapshot", owner.browser)).status).toBe(200);
});
it("lists metadata, creates an independent read credential, and never returns existing secrets", async () => {
  const owner = await setup(),
    created = await create(owner.browser);
  const list = await (
    await call("/v1/tokens", owner.browser)
  ).json<{ tokens: Record<string, unknown>[] }>();
  const row = list.tokens.find((t) => t.id === created.metadata.id);
  expect(row).toMatchObject({
    label: "Test viewer",
    scope: "read",
    parent_token_id: null,
    can_manage_tokens: false,
  });
  expect(JSON.stringify(list)).not.toContain(created.token.split(".")[1]);
  expect(JSON.stringify(list)).not.toContain("secret_hash");
  expect((await call("/v1/snapshot", created.token)).status).toBe(200);
  expect((await call("/v1/tokens", created.token)).status).toBe(403);
  await call("/v1/browser-logout", owner.browser, "POST", {});
  expect((await call("/v1/snapshot", created.token)).status).toBe(200);
});
it("edits label and expiry with conflict detection; role and installation cannot change", async () => {
  const owner = await setup(),
    created = await create(owner.browser),
    url = "/v1/tokens/" + created.metadata.id;
  const expires = Date.now() + 3600000;
  const edit = {
    label: "Renamed viewer",
    expires_at: expires,
    expected_updated_at: created.metadata.updated_at,
  };
  const result = await call(url, owner.browser, "PATCH", edit);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    token: { label: "Renamed viewer", expires_at: expires },
  });
  expect((await call(url, owner.browser, "PATCH", edit)).status).toBe(409);
  expect(
    (await call(url, owner.browser, "PATCH", { ...edit, scope: "write" }))
      .status,
  ).toBe(400);
  expect(
    (
      await call(url, owner.browser, "PATCH", {
        ...edit,
        expires_at: Date.now() - 1,
      })
    ).status,
  ).toBe(400);
});
it("binds write tokens to an enabled installation and revokes derived browser access", async () => {
  const owner = await setup(),
    created = await create(owner.browser, {
      scope: "write",
      installation_id: owner.id,
      expires_at: null,
    });
  const link = await (
    await call("/v1/browser-links", created.token, "POST", {})
  ).json<{ url: string }>();
  const browser = await (
    await call("/v1/browser-login", "", "POST", {
      token: new URLSearchParams(new URL(link.url).hash.slice(1)).get("token"),
    })
  ).json<{ token: string }>();
  expect((await call("/v1/snapshot", browser.token)).status).toBe(200);
  expect(
    (
      await call(
        "/v1/tokens/" + created.metadata.id,
        owner.browser,
        "DELETE",
        {},
      )
    ).status,
  ).toBe(200);
  expect(
    (await call("/v1/browser-links", created.token, "POST", {})).status,
  ).toBe(401);
  expect((await call("/v1/snapshot", browser.token)).status).toBe(401);
  expect(
    (
      await call("/v1/tokens/" + created.metadata.id, owner.browser, "PATCH", {
        label: "Revive",
        expires_at: null,
        expected_updated_at: created.metadata.updated_at,
      })
    ).status,
  ).toBe(409);
  const list = await (
    await call("/v1/tokens", owner.browser)
  ).json<{ tokens: Record<string, unknown>[] }>();
  expect(
    list.tokens.find((t) => t.id === created.metadata.id)?.revoked_at,
  ).toBeTypeOf("number");
});
it("isolates workspaces, rejects cross-origin mutations, and protects current login credentials", async () => {
  const owner = await setup(),
    other = await setup(),
    created = await create(other.browser);
  for (const method of ["PATCH", "DELETE"])
    expect(
      (
        await call(
          "/v1/tokens/" + created.metadata.id,
          owner.browser,
          method,
          {},
        )
      ).status,
    ).toBe(404);
  expect(
    (
      await call("/v1/tokens", owner.browser, "POST", {
        label: "Foreign",
        scope: "write",
        installation_id: other.id,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call(
        "/v1/tokens",
        owner.browser,
        "POST",
        { label: "No", scope: "read" },
        "https://evil.example",
      )
    ).status,
  ).toBe(403);
  for (const id of [owner.id, owner.browser.split(".")[0]])
    expect(
      (await call("/v1/tokens/" + id, owner.browser, "DELETE", {})).status,
    ).toBe(409);
  expect(
    (
      await call("/v1/tokens", owner.browser, "POST", {
        label: "Escalate",
        scope: "read",
        can_manage_tokens: true,
      })
    ).status,
  ).toBe(400);
  await env.DB.prepare("UPDATE api_tokens SET revoked_at=? WHERE id=?")
    .bind(Date.now(), owner.id)
    .run();
  expect((await call("/v1/tokens", owner.browser)).status).toBe(401);
});
it("bounds browser expiry and paginates token metadata with no duplicate IDs", async () => {
  const owner = await setup();
  // A second browser shares the same parent writer, so it can be edited.
  const grant = await (
    await call("/v1/browser-links", owner.writer, "POST", {})
  ).json<{ url: string }>();
  const browser = await (
    await call("/v1/browser-login", "", "POST", {
      token: new URLSearchParams(new URL(grant.url).hash.slice(1)).get("token"),
    })
  ).json<{ token: string }>();
  const row = await env.DB.prepare(
    "SELECT updated_at FROM api_tokens WHERE id=?",
  )
    .bind(browser.token.split(".")[0])
    .first<{ updated_at: number }>();
  expect(
    (
      await call(
        "/v1/tokens/" + browser.token.split(".")[0],
        owner.browser,
        "PATCH",
        {
          label: "Browser",
          expires_at: null,
          expected_updated_at: row!.updated_at,
        },
      )
    ).status,
  ).toBe(400);
  await env.DB.batch(
    Array.from({ length: 101 }, (_, i) =>
      env.DB.prepare(
        "INSERT INTO api_tokens(id,workspace_id,secret_hash,scope) VALUES(?,?,?,'read')",
      ).bind(
        `page-${owner.id}-${i.toString().padStart(3, "0")}`,
        owner.workspace,
        "unused",
      ),
    ),
  );
  const first = await (
    await call("/v1/tokens", owner.browser)
  ).json<{ tokens: { id: string }[]; cursor: string }>();
  expect(first.tokens).toHaveLength(100);
  expect(first.cursor).toBeTruthy();
  const next = await (
    await call(
      "/v1/tokens?cursor=" + encodeURIComponent(first.cursor),
      owner.browser,
    )
  ).json<{ tokens: { id: string }[]; cursor: null }>();
  expect(next.cursor).toBeNull();
  expect(new Set([...first.tokens, ...next.tokens].map((t) => t.id)).size).toBe(
    104,
  );
});

it("cleans revoked token metadata and rate rows after 30 days", async () => {
  const owner = await setup(),
    created = await create(owner.browser);
  await call("/v1/snapshot", created.token);
  await call("/v1/tokens/" + created.metadata.id, owner.browser, "DELETE", {});
  const { retain } = await import("../src/retention");
  await env.DB.prepare("DELETE FROM maintenance_runs WHERE id='compact'").run();
  await retain(env, Date.now() + 31 * 86400000);
  expect(
    await env.DB.prepare("SELECT id FROM api_tokens WHERE id=?")
      .bind(created.metadata.id)
      .first(),
  ).toBeNull();
  expect(
    await env.DB.prepare("SELECT token_id FROM rate_limits WHERE token_id=?")
      .bind(created.metadata.id)
      .first(),
  ).toBeNull();
  expect(
    await env.DB.prepare("SELECT id FROM api_tokens WHERE id=?")
      .bind(owner.id)
      .first(),
  ).not.toBeNull();
});

it("defaults write-token labels to reported hostname while retaining explicit names", async () => {
  const owner = await setup();
  const presence = await call("/v1/presence", owner.writer, "POST", {
    observed_at: Date.now(),
    runs: [],
    hostname: "ActualHost",
    usage: true,
    dropped: 0,
  });
  expect(presence.status).toBe(200);
  for (const label of [undefined, "", "   "]) {
    const created = await create(owner.browser, {
      scope: "write",
      installation_id: owner.id,
      label,
    });
    expect(created.metadata.label).toBe("ActualHost");
  }
  const custom = await create(owner.browser, {
    scope: "write",
    installation_id: owner.id,
    label: "Custom purpose",
  });
  expect(custom.metadata.label).toBe("Custom purpose");
  // Old reporters omit hostname; presence must not erase the known value.
  await call("/v1/presence", owner.writer, "POST", {
    observed_at: Date.now(),
    runs: [],
    usage: true,
    dropped: 0,
  });
  const listed = await (
    await call("/v1/tokens", owner.browser)
  ).json<{ installations: { id: string; hostname: string }[] }>();
  expect(listed.installations.find((i) => i.id === owner.id)?.hostname).toBe(
    "ActualHost",
  );
  expect(
    (
      await call("/v1/tokens", owner.browser, "POST", {
        scope: "read",
        label: "",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call("/v1/tokens", owner.browser, "POST", {
        scope: "read",
        label: "   ",
      })
    ).status,
  ).toBe(400);
});
