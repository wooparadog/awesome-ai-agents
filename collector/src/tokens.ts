import { authenticate, type Identity } from "./auth";
import { credential, jsonRequest, sameOrigin } from "./browser-auth";
import {
  body,
  hash,
  HttpError,
  integer,
  response,
  str,
  type Json,
} from "./protocol";

const columns =
  "id,label,scope,installation_id,expires_at,revoked_at,parent_token_id,can_manage_tokens,created_at,updated_at";
type Token = {
  id: string;
  label: string | null;
  scope: string;
  installation_id: string | null;
  expires_at: number | null;
  revoked_at: number | null;
  parent_token_id: string | null;
  can_manage_tokens: number;
  created_at: number | null;
  updated_at: number | null;
};
function expiry(value: unknown): number | null {
  if (value === null) return null;
  const time = integer(value);
  if (time <= Date.now() || time > Date.now() + 366 * 86400000)
    throw new HttpError(
      400,
      "expiry must be in the future and within one year",
    );
  return time;
}
function fields(payload: Json, allowed: string[]) {
  if (
    Object.keys(payload).some(
      (k) => !["schema_version", ...allowed].includes(k),
    )
  )
    throw new HttpError(
      400,
      "unsupported token field; role and installation cannot be edited",
    );
}
async function target(env: Env, who: Identity, id: string): Promise<Token> {
  const row = await env.DB.prepare(
    `SELECT ${columns} FROM api_tokens WHERE workspace_id=? AND id=?`,
  )
    .bind(who.workspace_id, id)
    .first<Token>();
  if (!row) throw new HttpError(404, "token not found");
  return row;
}
export async function tokenRoutes(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  sameOrigin(request);
  const who = await authenticate(request, env, "read");
  const url = new URL(request.url),
    path = url.pathname;
  if (path === "/v1/token-access" && request.method === "GET")
    return response({
      can_manage_tokens: !!who.can_manage_tokens,
      current_token_id: who.id,
    });
  if (!who.can_manage_tokens)
    throw new HttpError(
      403,
      "token management requires a login created with ai-agents web --manage-tokens",
    );
  if (path === "/v1/tokens" && request.method === "GET") {
    const after = url.searchParams.get("cursor") || "";
    const rows = await env.DB.prepare(
      `SELECT ${columns} FROM api_tokens WHERE workspace_id=? AND id>? ORDER BY id LIMIT 101`,
    )
      .bind(who.workspace_id, after)
      .all<Token>();
    const installations = await env.DB.prepare(
      "SELECT id,label,hostname,disabled_at FROM installations WHERE workspace_id=? ORDER BY id LIMIT 1001",
    )
      .bind(who.workspace_id)
      .all();
    if (installations.results.length > 1000)
      throw new HttpError(413, "too many installations");
    return response({
      tokens: rows.results.slice(0, 100).map((r) => ({
        ...r,
        can_manage_tokens: !!r.can_manage_tokens,
        current: r.id === who.id,
        protected: r.id === who.id || r.id === who.parent_token_id,
      })),
      cursor: rows.results.length > 100 ? rows.results[99].id : null,
      installations: installations.results,
    });
  }
  if (path === "/v1/tokens" && request.method === "POST") {
    jsonRequest(request);
    const payload = await body(request);
    fields(payload, ["label", "scope", "installation_id", "expires_at"]);
    const scope = str(payload.scope);
    if (!["read", "write"].includes(scope))
      throw new HttpError(400, "role must be read or write");
    const installation =
      scope === "write" ? str(payload.installation_id) : null;
    if (scope === "read" && payload.installation_id != null)
      throw new HttpError(
        400,
        "read tokens cannot be bound to an installation",
      );
    const machine = installation
      ? await env.DB.prepare(
          "SELECT id,label,hostname FROM installations WHERE workspace_id=? AND id=? AND disabled_at IS NULL",
        )
          .bind(who.workspace_id, installation)
          .first<{ id: string; label: string; hostname: string | null }>()
      : null;
    if (installation && !machine)
      throw new HttpError(
        400,
        "select an enabled installation in this workspace",
      );
    const supplied =
      typeof payload.label === "string" ? payload.label.trim() : payload.label;
    const label =
      scope === "write" &&
      (supplied === undefined || supplied === null || supplied === "")
        ? (machine!.hostname || machine!.label || machine!.id).slice(0, 100)
        : str(supplied, 100);
    const expires = expiry(payload.expires_at ?? null),
      now = Date.now(),
      value = credential();
    // Explicit management access creates independent API credentials. Signing out
    // of this browser does not revoke tokens it issued for other clients.
    const result = await env.DB.prepare(
      `INSERT INTO api_tokens(id,workspace_id,secret_hash,scope,installation_id,expires_at,label,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM api_tokens WHERE workspace_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?))<256`,
    )
      .bind(
        value.id,
        who.workspace_id,
        await hash(value.secret),
        scope,
        installation,
        expires,
        label,
        now,
        now,
        who.workspace_id,
        now,
      )
      .run();
    if (!result.meta.changes)
      throw new HttpError(409, "workspace limit of 256 active tokens reached");
    return response(
      {
        token: value.id + "." + value.secret,
        metadata: await target(env, who, value.id),
      },
      201,
    );
  }
  const match = /^\/v1\/tokens\/([^/]+)$/.exec(path);
  if (!match) throw new HttpError(404, "not found");
  const id = str(decodeURIComponent(match[1]));
  if (!["PATCH", "DELETE"].includes(request.method))
    throw new HttpError(405, "method not allowed");
  jsonRequest(request);
  const payload = await body(request);
  const row = await target(env, who, id);
  if (id === who.id || id === who.parent_token_id)
    throw new HttpError(
      409,
      "this token supports your current login; use another management session to change it",
    );
  if (request.method === "PATCH") {
    fields(payload, ["label", "expires_at", "expected_updated_at"]);
    if (row.revoked_at != null)
      throw new HttpError(409, "revoked tokens cannot be edited");
    const label = str(payload.label, 100).trim();
    if (!label) throw new HttpError(400, "label required");
    const expires = expiry(payload.expires_at);
    const expected =
      payload.expected_updated_at === null
        ? null
        : integer(payload.expected_updated_at);
    if (row.parent_token_id) {
      const parent = await env.DB.prepare(
        "SELECT expires_at FROM api_tokens WHERE id=? AND workspace_id=? AND revoked_at IS NULL",
      )
        .bind(row.parent_token_id, who.workspace_id)
        .first<{ expires_at: number | null }>();
      if (!parent)
        throw new HttpError(409, "originating credential is unavailable");
      const ceiling = Math.min(
        row.created_at == null
          ? (row.expires_at ?? Date.now())
          : row.created_at + 30 * 86400000,
        parent.expires_at ?? Infinity,
      );
      if (expires === null || expires > ceiling)
        throw new HttpError(
          400,
          "browser expiry cannot exceed its original 30-day or parent-credential limit",
        );
    }
    const result = await env.DB.prepare(
      `UPDATE api_tokens SET label=?,expires_at=?,updated_at=? WHERE workspace_id=? AND id=? AND revoked_at IS NULL AND updated_at IS ?`,
    )
      .bind(
        label,
        expires,
        Math.max(Date.now(), (row.updated_at ?? 0) + 1),
        who.workspace_id,
        id,
        expected,
      )
      .run();
    if (!result.meta.changes)
      throw new HttpError(409, "token changed; reload and try again");
    // Force fresh authorization after changing expiry (including subscribers
    // using browser credentials derived from this token).
    ctx.waitUntil(closeSubscribers(env, who.workspace_id, id));
    return response({ token: await target(env, who, id) });
  }
  fields(payload, []);
  // Keep a tombstone: descendants still see revocation and the operator can
  // distinguish a revoked credential from one that never existed.
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,?),updated_at=? WHERE workspace_id=? AND id=?",
  )
    .bind(now, now, who.workspace_id, id)
    .run();
  ctx.waitUntil(closeSubscribers(env, who.workspace_id, id));
  return response({ ok: true });
}
async function closeSubscribers(env: Env, workspace: string, id: string) {
  const children = await env.DB.prepare(
    "SELECT id FROM api_tokens WHERE parent_token_id=? AND workspace_id=?",
  )
    .bind(id, workspace)
    .all<{ id: string }>();
  const subscriptions = env.SUBSCRIPTIONS.getByName(workspace);
  await Promise.all(
    [id, ...children.results.map((r) => r.id)].map((token) =>
      subscriptions.revoke(token),
    ),
  );
}
