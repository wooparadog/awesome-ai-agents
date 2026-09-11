import {
  createLink,
  redeemLink,
  createTicket,
  consumeTicket,
  logout,
} from "./browser-auth";
import { servePanel } from "./panel";
import { authenticate } from "./auth";
import { ingest, presence, usage } from "./ingest";
import { body, HttpError, response, stamp, str } from "./protocol";
import { snapshot } from "./snapshot";
import { publishPending } from "./subscriptions";
import { retain } from "./retention";
import { reprice } from "./reprice";
export { Subscriptions } from "./subscriptions";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      const url = new URL(request.url),
        path = url.pathname;
      if (!path.startsWith("/v1/")) return await servePanel(request, env);
      if (request.method === "POST") {
        if (path === "/v1/browser-links") return await createLink(request, env);
        if (path === "/v1/browser-login") return await redeemLink(request, env);
        if (path === "/v1/browser-ticket")
          return await createTicket(request, env);
        if (path === "/v1/browser-logout") return await logout(request, env);
      }
      if (path === "/v1/browser-subscribe" && request.method === "GET") {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
          throw new HttpError(426, "WebSocket upgrade required");
        const who = await consumeTicket(request, env);
        const upgraded = await env.SUBSCRIPTIONS.getByName(
          who.workspace_id,
        ).fetch(
          new Request("https://subscription/subscribe", {
            headers: {
              Upgrade: "websocket",
              "X-Collector-Identity": JSON.stringify(who),
            },
          }),
        );
        if (upgraded.status !== 101) return upgraded;
        return new Response(null, {
          status: 101,
          webSocket: upgraded.webSocket,
          headers: { "Sec-WebSocket-Protocol": "ai-agents.v1" },
        });
      }
      const writing = request.method === "POST";
      const who = await authenticate(request, env, writing ? "write" : "read");
      if (writing) {
        if (!["/v1/events", "/v1/presence", "/v1/usage"].includes(path))
          throw new HttpError(404, "not found");
        if (
          !(request.headers.get("Content-Type") || "").startsWith(
            "application/json",
          )
        )
          throw new HttpError(415, "expected application/json");
        const payload = await body(request);
        const result =
          path === "/v1/events"
            ? await ingest(env, who, payload)
            : path === "/v1/presence"
              ? await presence(env, who, payload)
              : await usage(env, who, payload);
        ctx.waitUntil(publishPending(env, who.workspace_id));
        return response(result);
      }
      if (request.method !== "GET")
        throw new HttpError(405, "method not allowed");
      if (path === "/v1/subscribe") {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
          throw new HttpError(426, "WebSocket upgrade required");
        return await env.SUBSCRIPTIONS.getByName(who.workspace_id).fetch(
          new Request("https://subscription/subscribe", {
            headers: {
              Upgrade: "websocket",
              "X-Collector-Identity": JSON.stringify(who),
            },
          }),
        );
      }
      if (path === "/v1/snapshot")
        return response(await snapshot(env, who.workspace_id));
      if (path === "/v1/usage") {
        const from = stamp(url.searchParams.get("from")),
          to = stamp(url.searchParams.get("to"));
        if (from >= to || to - from > 31 * 86400000)
          throw new HttpError(400, "range must be at most 31 days");
        const s = await snapshot(env, who.workspace_id, [from, to]);
        return response({ from, to, cost: s.cost, complete: s.usage_complete });
      }
      if (path === "/v1/sessions") {
        const after = url.searchParams.get("cursor") || "",
          installation = url.searchParams.get("installation");
        const rows = await env.DB.prepare(
          `SELECT r.*,s.agent,s.native_session_id FROM session_runs r JOIN sessions s ON s.workspace_id=r.workspace_id AND s.id=r.session_id
          WHERE r.workspace_id=? AND r.id>? ${installation ? "AND r.installation_id=?" : ""} ORDER BY r.id LIMIT 101`,
        )
          .bind(
            ...(installation
              ? [who.workspace_id, after, str(installation)]
              : [who.workspace_id, after]),
          )
          .all();
        return response({
          sessions: rows.results.slice(0, 100),
          cursor: rows.results.length > 100 ? rows.results[99].id : null,
        });
      }
      const match = /^\/v1\/sessions\/([^/]+)\/events$/.exec(path);
      if (match) {
        const rows = await env.DB.prepare(
          "SELECT id,sequence,source_event,canonical_type,observed_at,received_at,data_json FROM events WHERE workspace_id=? AND run_id=? AND sequence>? ORDER BY sequence LIMIT 101",
        )
          .bind(
            who.workspace_id,
            decodeURIComponent(match[1]),
            Number(url.searchParams.get("cursor") || 0),
          )
          .all();
        return response({
          events: rows.results.slice(0, 100),
          cursor: rows.results.length > 100 ? rows.results[99].sequence : null,
        });
      }
      throw new HttpError(404, "not found");
    } catch (error) {
      const quota =
        error instanceof Error &&
        /exceeded D1's free tier daily/i.test(error.message);
      const conflict =
        error instanceof Error &&
        /(?:event|execution|run|usage) conflict/.test(error.message);
      const status = quota
        ? 503
        : error instanceof HttpError
          ? error.status
          : conflict
            ? 409
            : 500;
      const message = quota
        ? "database daily quota exhausted"
        : error instanceof HttpError
          ? error.message
          : conflict
            ? "identity or payload conflict"
            : "collector error";
      console.warn(
        JSON.stringify({ request_id: requestId, status, reason: message }),
      );
      const result = response(
        { error: message, request_id: requestId },
        status,
      );
      if (quota)
        result.headers.set(
          "Retry-After",
          String(Math.ceil((86400000 - (Date.now() % 86400000)) / 1000)),
        );
      else if (status === 429 || status === 503)
        result.headers.set("Retry-After", "60");
      return result;
    }
  },
  async scheduled(_event, env, ctx) {
    await reprice(env);
    ctx.waitUntil(publishPending(env));
    await retain(env);
  },
} satisfies ExportedHandler<Env>;
