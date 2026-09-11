import { DurableObject } from "cloudflare:workers";
import { subscriptionIdentity, type Identity } from "./auth";
type Attachment = {
  token: string;
  deadline: number;
  authorized_until?: number;
  sent?: number;
  needed?: number;
};
type Pending = { workspace: string; revision: number };
export class Subscriptions extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }
  async fetch(request: Request): Promise<Response> {
    // Only the authenticated Worker constructs this request through its binding.
    const who = JSON.parse(
      request.headers.get("X-Collector-Identity") || "null",
    ) as Identity | null;
    if (!who || who.scope !== "read")
      return new Response("unauthorized", { status: 401 });
    if (this.ctx.getWebSockets().length >= 32)
      return new Response("connection limit", { status: 429 });
    const pair = new WebSocketPair(),
      [client, server] = Object.values(pair);
    const deadline = Math.min(
      Date.now() + 86400000,
      who.expires_at ?? Infinity,
    );
    server.serializeAttachment({
      token: who.id,
      deadline,
      authorized_until: Date.now() + 300000,
    } satisfies Attachment);
    this.ctx.acceptWebSocket(server);
    await this.schedule();
    server.send(JSON.stringify({ type: "ready", protocol_version: 1 }));
    return new Response(null, { status: 101, webSocket: client });
  }
  async publish(workspace: string, revision: number): Promise<void> {
    // New subscribers always fetch an authorized snapshot. There is no message
    // to persist or alarm to schedule when nobody is listening.
    if (
      !this.ctx.getWebSockets().some((ws) => ws.readyState === WebSocket.OPEN)
    )
      return;
    const published = (await this.ctx.storage.get<number>("published")) || 0;
    if (revision <= published) return;
    await this.ctx.storage.transaction(async (tx) => {
      const pending = await tx.get<Pending>("pending");
      await tx.put("pending", {
        workspace,
        revision: Math.max(revision, pending?.revision || 0),
      } satisfies Pending);
      const alarm = await tx.getAlarm();
      await tx.setAlarm(Math.min(alarm ?? Infinity, Date.now() + 1000));
    });
    // Durable pending work is established before caller can acknowledge D1's outbox.
    this.ctx.waitUntil(this.broadcast());
  }
  private async broadcast(): Promise<void> {
    const retry = await this.ctx.storage.get<{ attempts: number; at: number }>(
      "retry",
    );
    if (retry && retry.at > Date.now()) {
      await this.schedule();
      return;
    }
    try {
      await this.deliverPending();
    } catch {
      const attempts = (retry?.attempts || 0) + 1;
      await this.ctx.storage.put("retry", {
        attempts,
        at:
          Date.now() +
          Math.min(60000 * 2 ** Math.min(attempts - 1, 6), 3600000),
      });
      await this.schedule();
    }
  }
  private async deliverPending(): Promise<void> {
    const pending = await this.ctx.storage.get<Pending>("pending");
    if (!pending) return;
    const sockets = this.ctx.getWebSockets(),
      now = Date.now();
    const checked = new Map<
      string,
      Awaited<ReturnType<typeof subscriptionIdentity>>
    >();
    for (const socket of sockets) {
      const a = socket.deserializeAttachment() as Attachment;
      if (a.deadline <= now) {
        socket.close(4001, "reauthenticate");
        continue;
      }
      if ((a.authorized_until || 0) <= now) {
        if (!checked.has(a.token))
          checked.set(a.token, await subscriptionIdentity(this.env, a.token));
        const identity = checked.get(a.token);
        if (!identity) {
          socket.close(4003, "revoked");
          continue;
        }
        a.deadline = Math.min(a.deadline, identity.expires_at);
        a.authorized_until = now + 300000;
      }
      // No session data is sent on the socket; each snapshot is reauthorized.
      try {
        a.needed = Math.max(a.needed || 0, pending.revision);
        // One outstanding invalidation per subscriber bounds slow-client queues.
        if (!a.sent) {
          a.sent = a.needed;
          socket.send(
            JSON.stringify({ type: "state.changed", revision: a.sent }),
          );
        }
        socket.serializeAttachment(a);
      } catch {
        socket.close(1011, "reconnect");
      }
    }
    await this.ctx.storage.transaction(async (tx) => {
      const current = await tx.get<Pending>("pending");
      const published = (await tx.get<number>("published")) || 0;
      await tx.put("published", Math.max(published, pending.revision));
      if (current && current.revision <= pending.revision)
        await tx.delete("pending");
    });
    await this.ctx.storage.delete("retry");
    await this.schedule();
  }
  private async schedule(): Promise<void> {
    let next = Infinity;
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment;
      if (ws.readyState === WebSocket.OPEN) next = Math.min(next, a.deadline);
    }
    if (await this.ctx.storage.get("pending")) {
      const retry = await this.ctx.storage.get<{ at: number }>("retry");
      next = Math.min(next, Math.max(Date.now() + 1000, retry?.at || 0));
    }
    if (next < Infinity)
      await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 100));
    else await this.ctx.storage.deleteAlarm();
  }
  async alarm(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      if ((ws.deserializeAttachment() as Attachment).deadline <= Date.now())
        ws.close(4001, "reauthenticate");
    }
    await this.broadcast();
    await this.schedule();
  }
  async revoke(token: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets())
      if ((ws.deserializeAttachment() as Attachment).token === token)
        ws.close(4003, "revoked");
    await this.schedule();
  }
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string" || message.length > 128) {
      ws.close(1008, "invalid acknowledgement");
      return;
    }
    try {
      const ack = JSON.parse(message) as { type: string; revision: number };
      const a = ws.deserializeAttachment() as Attachment;
      if (a.deadline <= Date.now()) {
        ws.close(4001, "reauthenticate");
        return;
      }
      if (
        ack.type !== "ack" ||
        !Number.isSafeInteger(ack.revision) ||
        ack.revision < 0
      )
        throw new Error();
      if (ack.revision >= (a.sent || 0)) {
        a.sent = undefined;
        if ((a.needed || 0) > ack.revision) {
          a.sent = a.needed;
          ws.send(JSON.stringify({ type: "state.changed", revision: a.sent }));
        }
        ws.serializeAttachment(a);
      }
    } catch {
      ws.close(1008, "invalid acknowledgement");
    }
  }
  async webSocketClose(ws: WebSocket): Promise<void> {
    ws.close();
    await this.schedule();
  }
  webSocketError(ws: WebSocket): void {
    ws.close(1011, "reconnect");
  }
}

export async function publishPending(
  env: Env,
  workspace?: string,
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT * FROM notification_outbox WHERE pending_revision>delivered_revision AND next_attempt_at<=? ${workspace ? "AND workspace_id=?" : ""} LIMIT 32`,
  )
    .bind(...(workspace ? [Date.now(), workspace] : [Date.now()]))
    .all<{
      workspace_id: string;
      pending_revision: number;
      attempts: number;
    }>();
  for (const r of rows.results) {
    try {
      await env.SUBSCRIPTIONS.getByName(r.workspace_id).publish(
        r.workspace_id,
        r.pending_revision,
      );
      await env.DB.prepare(
        "UPDATE notification_outbox SET delivered_revision=MAX(delivered_revision,?),attempts=0 WHERE workspace_id=?",
      )
        .bind(r.pending_revision, r.workspace_id)
        .run();
    } catch {
      await env.DB.prepare(
        "UPDATE notification_outbox SET attempts=attempts+1,next_attempt_at=? WHERE workspace_id=?",
      )
        .bind(
          Date.now() + Math.min(60000 * 2 ** Math.min(r.attempts, 6), 3600000),
          r.workspace_id,
        )
        .run();
      console.warn(
        JSON.stringify({
          event: "publication_retry",
          workspace: r.workspace_id,
        }),
      );
    }
  }
}
