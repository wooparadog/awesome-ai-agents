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
  const row = await env.DB.prepare(
    `SELECT t.* FROM api_tokens t LEFT JOIN installations i ON i.workspace_id=t.workspace_id AND i.id=t.installation_id
    WHERE t.id=? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>?) AND (t.installation_id IS NULL OR i.disabled_at IS NULL)`,
  )
    .bind(match[1], Date.now())
    .first<Identity & { secret_hash: string }>();
  const digest = await hash(match[2]);
  const a = new TextEncoder().encode(digest),
    b = new TextEncoder().encode(row?.secret_hash || "0".repeat(64));
  if (!crypto.subtle.timingSafeEqual(a, b) || !row)
    throw new HttpError(401, "invalid credentials");
  if (row.scope !== scope) throw new HttpError(403, "insufficient scope");
  const rate = await env.DB.prepare(
    `INSERT INTO rate_limits(token_id,window,count) VALUES(?,?,1)
    ON CONFLICT(token_id) DO UPDATE SET count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END,window=excluded.window RETURNING count`,
  )
    .bind(row.id, Math.floor(Date.now() / 60000))
    .first<{ count: number }>();
  if (rate && rate.count > 600) throw new HttpError(429, "rate limited");
  return row;
}
