export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export type Json = Record<string, unknown>;
export function object(v: unknown): Json {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new HttpError(400, "expected object");
  return v as Json;
}
export function str(v: unknown, max = 200): string {
  if (
    typeof v !== "string" ||
    !v.length ||
    v.length > max ||
    /[\x00-\x1f]/.test(v)
  )
    throw new HttpError(400, "invalid string");
  return v;
}
export function optional(v: unknown, max = 200): string | null {
  return v == null ? null : str(v, max);
}
export function integer(v: unknown, min = 0): number {
  if (!Number.isSafeInteger(v) || (v as number) < min)
    throw new HttpError(400, "invalid integer");
  return v as number;
}
export function stamp(v: unknown): number {
  const n = typeof v === "number" ? v : Date.parse(str(v));
  if (!Number.isSafeInteger(n) || n < 0 || n > Date.now() + 120_000)
    throw new HttpError(400, "invalid timestamp");
  return n;
}
export async function hash(s: string): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function body(request: Request): Promise<Json> {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "missing body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 262144) {
      await reader.cancel();
      throw new HttpError(413, "body too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
  const result = object(parsed);
  if (result.schema_version !== 1)
    throw new HttpError(400, "unsupported schema_version");
  return result;
}
export function list(v: unknown, max = 16): unknown[] {
  if (!Array.isArray(v) || !v.length || v.length > max)
    throw new HttpError(400, "invalid batch size");
  return v;
}
export function normalize(name: string, data: Json): [string, string | null] {
  switch (name.toLowerCase().replace(/[-_.]/g, "")) {
    case "sessionstart":
      return ["session.started", data.source === "compact" ? null : "idle"];
    case "userpromptsubmit":
    case "pretooluse":
    case "posttooluse":
      return ["turn.started", "busy"];
    case "permissionrequest":
      return ["attention.required", "asking"];
    case "attentioncleared":
      return ["attention.cleared", "busy"];
    case "stop":
      return ["turn.completed", "done"];
    case "sessionend":
      return ["session.ended", "ended"];
    case "notification":
      if (data.notification_type === "permission_prompt")
        return ["attention.required", "asking"];
      if (data.notification_type === "idle_prompt")
        return ["idle.notification", "done"];
  }
  return ["metadata.observed", null];
}
export function response(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
