import { hash, HttpError } from "./protocol";
export interface Identity {
  id: string;
  workspace_id: string;
  installation_id: string | null;
  scope: string;
  expires_at: number | null;
}
export async function authenticate(
  request: Request,
  env: Env,
  scope: string,
): Promise<Identity> {
  const match = /^Bearer ([a-zA-Z0-9_-]{1,100})\.([a-zA-Z0-9_-]{40,100})$/.exec(
    request.headers.get("Authorization") || "",
  );
  if (!match) throw new HttpError(401, "invalid credentials");
  const row = await lookup(env, match[1]);
  const digest = await hash(match[2]);
  const a = new TextEncoder().encode(digest),
    b = new TextEncoder().encode(row?.secret_hash || "0".repeat(64));
  if (!crypto.subtle.timingSafeEqual(a, b) || !row)
    throw new HttpError(401, "invalid credentials");
  return authorize(env, row, scope);
}
type TokenRow = Identity & {
  secret_hash: string;
  parent_expiry: number | null;
};
async function lookup(env: Env, id: string) {
  const now = Date.now();
  return env.DB.prepare(
    `SELECT t.*,p.expires_at AS parent_expiry FROM api_tokens t
    LEFT JOIN installations i ON i.workspace_id=t.workspace_id AND i.id=t.installation_id
    LEFT JOIN api_tokens p ON p.id=t.parent_token_id
    LEFT JOIN installations pi ON pi.workspace_id=p.workspace_id AND pi.id=p.installation_id
    WHERE t.id=? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>?)
    AND (t.installation_id IS NULL OR (i.id IS NOT NULL AND i.disabled_at IS NULL))
    AND (t.parent_token_id IS NULL OR (p.id IS NOT NULL AND p.workspace_id=t.workspace_id
      AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?)
      AND (p.installation_id IS NULL OR (pi.id IS NOT NULL AND pi.disabled_at IS NULL))))`,
  )
    .bind(id, now, now)
    .first<TokenRow>();
}
// A previously authenticated WebSocket uses this only before publishing another
// invalidation. Idle connections need no periodic HTTP reconnect or D1 query.
export async function subscriptionIdentity(env: Env, id: string) {
  const row = await lookup(env, id);
  if (!row || row.scope !== "read") return null;
  return {
    expires_at: Math.min(
      row.expires_at ?? Infinity,
      row.parent_expiry ?? Infinity,
    ),
  };
}
// Only call after possession of an independently authenticated one-time ticket.
export async function authenticateId(
  env: Env,
  id: string,
  scope: string,
): Promise<Identity> {
  const row = await lookup(env, id);
  if (!row) throw new HttpError(401, "invalid credentials");
  return authorize(env, row, scope);
}
async function authorize(
  env: Env,
  row: TokenRow,
  scope: string,
): Promise<Identity> {
  if (row.scope !== scope) throw new HttpError(403, "insufficient scope");
  const rate = await env.DB.prepare(
    `INSERT INTO rate_limits(token_id,window,count) VALUES(?,?,1)
    ON CONFLICT(token_id) DO UPDATE SET count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END,window=excluded.window RETURNING count`,
  )
    .bind(row.id, Math.floor(Date.now() / 60000))
    .first<{ count: number }>();
  if (rate && rate.count > 600) throw new HttpError(429, "rate limited");
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    installation_id: row.installation_id,
    scope: row.scope,
    expires_at:
      row.parent_expiry == null
        ? row.expires_at
        : Math.min(row.expires_at ?? Infinity, row.parent_expiry),
  };
}
