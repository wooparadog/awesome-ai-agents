import { authenticate, authenticateId, type Identity } from "./auth";
import { body, hash, HttpError, integer, response } from "./protocol";

const DAY = 86400000;
function credential() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return { id: crypto.randomUUID(), secret };
}
function parse(value: unknown): [string, string] {
  const match =
    typeof value === "string" &&
    /^([A-Za-z0-9_-]{1,100})\.([A-Za-z0-9_-]{40,100})$/.exec(value);
  if (!match) throw new HttpError(401, "invalid credentials");
  return [match[1], match[2]];
}
async function matches(secret: string, expected?: string) {
  const encoder = new TextEncoder();
  return crypto.subtle.timingSafeEqual(
    encoder.encode(await hash(secret)),
    encoder.encode(expected || "0".repeat(64)),
  );
}
export function sameOrigin(request: Request, required = false) {
  const origin = request.headers.get("Origin");
  if (
    (required && !origin) ||
    (origin && origin !== new URL(request.url).origin)
  )
    throw new HttpError(403, "origin not allowed");
}
function jsonRequest(request: Request) {
  sameOrigin(request);
  if (
    !(request.headers.get("Content-Type") || "").startsWith("application/json")
  )
    throw new HttpError(415, "expected application/json");
}
export async function createLink(request: Request, env: Env) {
  jsonRequest(request);
  const who = await authenticate(request, env, "write");
  const payload = await body(request);
  const ttl = integer(payload.expires_in ?? 600, 60);
  if (ttl > 3600)
    throw new HttpError(400, "link expiry must be between 60 and 3600 seconds");
  const now = Date.now();
  const expires = Math.min(now + ttl * 1000, who.expires_at ?? Infinity);
  const tokenExpires = Math.min(now + 30 * DAY, who.expires_at ?? Infinity);
  const value = credential();
  const result = await env.DB.prepare(
    `INSERT INTO browser_links(id,secret_hash,workspace_id,parent_token_id,expires_at,token_expires_at)
    SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM browser_links WHERE parent_token_id=? AND expires_at>? AND redeemed_token_id IS NULL)<8`,
  )
    .bind(
      value.id,
      await hash(value.secret),
      who.workspace_id,
      who.id,
      expires,
      tokenExpires,
      who.id,
      now,
    )
    .run();
  if (!result.meta.changes)
    throw new HttpError(
      429,
      "too many outstanding login links; wait for one to expire",
    );
  const url = new URL("/login", request.url);
  // Fragments never travel in HTTP request URLs or Referer headers.
  url.hash = "token=" + value.id + "." + value.secret;
  return response({
    url: url.href,
    expires_at: expires,
    browser_expires_at: tokenExpires,
  });
}
export async function redeemLink(request: Request, env: Env) {
  jsonRequest(request);
  const payload = await body(request);
  const [id, secret] = parse(payload.token);
  const link = await env.DB.prepare("SELECT * FROM browser_links WHERE id=?")
    .bind(id)
    .first<{
      id: string;
      secret_hash: string;
      workspace_id: string;
      parent_token_id: string;
      expires_at: number;
      token_expires_at: number;
      redeemed_token_id: string | null;
    }>();
  if (!(await matches(secret, link?.secret_hash)) || !link)
    throw new HttpError(401, "invalid login link");
  if (link.expires_at <= Date.now() || link.redeemed_token_id)
    throw new HttpError(410, "login link has expired or was already used");
  const parent = await authenticateId(env, link.parent_token_id, "write");
  const value = credential(),
    now = Date.now();
  const expires = Math.min(
    link.token_expires_at,
    parent.expires_at ?? Infinity,
  );
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE browser_links SET redeemed_token_id=? WHERE id=? AND redeemed_token_id IS NULL AND expires_at>?
      AND EXISTS(SELECT 1 FROM api_tokens t JOIN installations i ON i.workspace_id=t.workspace_id AND i.id=t.installation_id
        WHERE t.id=browser_links.parent_token_id AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>?) AND i.disabled_at IS NULL)
      AND (SELECT COUNT(*) FROM api_tokens WHERE parent_token_id=? AND revoked_at IS NULL AND expires_at>?)<32`,
    ).bind(value.id, id, now, now, parent.id, now),
    env.DB.prepare(
      `INSERT INTO api_tokens(id,workspace_id,secret_hash,scope,expires_at,parent_token_id)
      SELECT ?,workspace_id,?,'read',?,parent_token_id FROM browser_links WHERE id=? AND redeemed_token_id=?`,
    ).bind(value.id, await hash(value.secret), expires, id, value.id),
  ]);
  if (!results[1].meta.changes)
    throw new HttpError(
      410,
      "login link is unavailable or browser limit reached",
    );
  return response({
    token: value.id + "." + value.secret,
    expires_at: expires,
    workspace_id: link.workspace_id,
  });
}
export async function createTicket(request: Request, env: Env) {
  jsonRequest(request);
  const who = await authenticate(request, env, "read");
  await body(request);
  const value = credential(),
    now = Date.now(),
    expires = Math.min(now + 60000, who.expires_at ?? Infinity);
  const result = await env.DB.prepare(
    `INSERT INTO browser_tickets(id,secret_hash,token_id,expires_at)
    SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM browser_tickets WHERE token_id=? AND expires_at>?)<8`,
  )
    .bind(value.id, await hash(value.secret), who.id, expires, who.id, now)
    .run();
  if (!result.meta.changes)
    throw new HttpError(429, "too many connection tickets");
  return response({
    ticket: value.id + "." + value.secret,
    expires_at: expires,
  });
}
export async function consumeTicket(
  request: Request,
  env: Env,
): Promise<Identity> {
  sameOrigin(request, true);
  const protocols = (request.headers.get("Sec-WebSocket-Protocol") || "")
    .split(",")
    .map((s) => s.trim());
  if (!protocols.includes("ai-agents.v1"))
    throw new HttpError(400, "unsupported WebSocket protocol");
  const [id, secret] = parse(
    protocols.find((s) => s.startsWith("ticket."))?.slice(7),
  );
  const ticket = await env.DB.prepare(
    "SELECT * FROM browser_tickets WHERE id=?",
  )
    .bind(id)
    .first<{ secret_hash: string; token_id: string; expires_at: number }>();
  if (!(await matches(secret, ticket?.secret_hash)) || !ticket)
    throw new HttpError(401, "invalid connection ticket");
  const who = await authenticateId(env, ticket.token_id, "read");
  const used = await env.DB.prepare(
    "DELETE FROM browser_tickets WHERE id=? AND expires_at>? RETURNING id",
  )
    .bind(id, Date.now())
    .first();
  if (!used)
    throw new HttpError(401, "connection ticket expired or already used");
  return who;
}
export async function logout(request: Request, env: Env) {
  jsonRequest(request);
  const who = await authenticate(request, env, "read");
  await body(request);
  await env.DB.prepare("UPDATE api_tokens SET revoked_at=? WHERE id=?")
    .bind(Date.now(), who.id)
    .run();
  await env.SUBSCRIPTIONS.getByName(who.workspace_id).revoke(who.id);
  return response({ ok: true });
}
