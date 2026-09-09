// Allow two five-minute reconciliation intervals before marking a reporter stale.
const PRESENCE_TTL_MS = 10 * 60 * 1000;

import { HttpError } from "./protocol";
export function dayBounds(now: number, timezone: string): [number, number] {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const key = (n: number) => fmt.format(new Date(n));
  const today = key(now);
  const boundary = (end: boolean) => {
    let lo = now - 36 * 3600000,
      hi = now + 36 * 3600000;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (end ? key(mid) <= today : key(mid) < today) lo = mid;
      else hi = mid;
    }
    return hi;
  };
  return [boundary(false), boundary(true)];
}
type Counters = {
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
};
const metrics = [
  "input",
  "output",
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
] as const;
type UsageRow = Record<string, unknown> &
  Counters & {
    agent: string;
    provider: string;
    model: string | null;
    incomplete: number;
    run_id?: string;
    rates: string | null;
  };
type Total = {
  tokens: number;
  dollars: number;
  priced: boolean;
  available: boolean;
  complete: boolean;
  model?: string | null;
};
const empty = (): Total => ({
  tokens: 0,
  dollars: 0,
  priced: true,
  available: false,
  complete: true,
});
function add(dst: Total, row: UsageRow): bigint {
  const rates = row.rates
    ? (JSON.parse(row.rates) as Record<string, number>)
    : {};
  let nano = 0n;
  for (const metric of metrics) {
    const q = row[metric] || 0;
    dst.tokens += q;
    if (q && rates[metric] == null) dst.priced = false;
    else nano += BigInt(q) * BigInt(rates[metric] || 0);
  }
  dst.dollars += Number(nano) / 1e9;
  dst.available = true;
  dst.complete = dst.complete && !row.incomplete;
  dst.model = row.model;
  return nano;
}
export function summarize(rows: unknown[]) {
  const result: Record<string, Total & { nano: bigint }> = {};
  for (const value of rows) {
    const row = value as UsageRow;
    const total = (result[row.agent] ??= { ...empty(), nano: 0n });
    total.nano += add(total, row);
  }
  return result;
}
// Resolve prices per evidence timestamp before grouping, including effective dates.
export const usageQuery = `SELECT u.*,(SELECT json_group_object(metric,nano_usd_per_token) FROM price_rates p
 WHERE p.provider=u.provider AND (p.model=u.model OR (substr(u.model,1,length(p.model)+1)=p.model||'-'
 AND length(u.model)=length(p.model)+9 AND substr(u.model,length(p.model)+2) NOT GLOB '*[^0-9]*')
 OR (substr(u.model,1,length(p.model)+1)=p.model||'@' AND length(u.model)>length(p.model)+1
 AND substr(u.model,length(p.model)+2) NOT GLOB '*[^0-9]*')) AND p.effective_from<=u.occurred_at AND (p.effective_to IS NULL OR p.effective_to>u.occurred_at)) AS rates
 FROM usage_deltas u JOIN usage_records original ON original.workspace_id=u.workspace_id AND original.id=u.id
 WHERE u.workspace_id=? AND u.occurred_at>=? AND u.occurred_at<? AND original.archived=0 LIMIT 10001`;
export async function snapshot(
  env: Env,
  workspace: string,
  range?: [number, number],
) {
  const now = Date.now();
  const config = await env.DB.prepare(
    "SELECT reporting_timezone FROM workspaces WHERE id=?",
  )
    .bind(workspace)
    .first<{ reporting_timezone: string }>();
  if (!config) throw new HttpError(404, "workspace not found");
  const [from, to] = range || dayBounds(now, config.reporting_timezone);
  const data = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare("SELECT revision FROM workspaces WHERE id=?").bind(
      workspace,
    ),
    env.DB.prepare(
      `SELECT r.*,s.agent,s.native_session_id,i.label AS machine FROM session_runs r JOIN sessions s ON s.workspace_id=r.workspace_id AND s.id=r.session_id
      JOIN installations i ON i.workspace_id=r.workspace_id AND i.id=r.installation_id WHERE r.workspace_id=? AND r.ended_at IS NULL ORDER BY r.last_activity_at DESC LIMIT 1001`,
    ).bind(workspace),
    env.DB.prepare(usageQuery).bind(workspace, from, to),
    env.DB.prepare(
      `SELECT o.usage_id,o.run_id FROM usage_observations o JOIN session_runs r ON r.workspace_id=o.workspace_id AND r.id=o.run_id
      JOIN usage_records u ON u.workspace_id=o.workspace_id AND u.id=o.usage_id
      WHERE o.workspace_id=? AND r.ended_at IS NULL AND u.occurred_at>=? AND u.occurred_at<? LIMIT 20001`,
    ).bind(workspace, from, to),
    env.DB.prepare(
      "SELECT id,label,last_contact_at,capabilities_json FROM installations WHERE workspace_id=? AND disabled_at IS NULL LIMIT 1001",
    ).bind(workspace),
    env.DB.prepare(
      "SELECT * FROM usage_daily WHERE workspace_id=? AND day_start<? AND day_end>? LIMIT 1001",
    ).bind(workspace, to, from),
  ]);
  if (
    data[1].results.length > 1000 ||
    data[2].results.length > 10000 ||
    data[3].results.length > 20000 ||
    data[4].results.length > 1000
  )
    throw new HttpError(413, "snapshot too large; narrow usage interval");
  const cost: Record<string, Total> = {};
  const perRun: Record<string, Total> = {};
  const usage = new Map<string, UsageRow>();
  for (const value of data[2].results) {
    const row = value as UsageRow & { id: string };
    add((cost[row.agent] ??= empty()), row);
    usage.set(row.id, row);
  }
  if (data[5].results.length > 1000)
    throw new HttpError(413, "archive response too large");
  for (const r of data[5].results) {
    if (Number(r.day_start) < from || Number(r.day_end) > to)
      throw new HttpError(400, "archived usage requires whole reporting days");
    const c = (cost[String(r.agent)] ??= empty());
    c.tokens += Number(r.tokens);
    c.dollars += Number(BigInt(String(r.nano_usd))) / 1e9;
    c.priced = c.priced && !!r.priced;
    c.complete = c.complete && !!r.complete;
    c.available = true;
  }
  for (const o of data[3].results) {
    const row = usage.get(String(o.usage_id));
    if (row) add((perRun[String(o.run_id)] ??= empty()), row);
  }
  const agents: Record<string, Record<string, unknown>[]> = {};
  let total = 0,
    busy = 0,
    asking = 0,
    done = 0,
    stale = 0,
    unverified = 0;
  let next = to;
  for (const r of data[1].results) {
    const expiry =
      r.presence_received_at == null
        ? null
        : Math.min(
            Number(r.presence_received_at) + PRESENCE_TTL_MS,
            Number(r.last_alive_observed_at) + PRESENCE_TTL_MS,
          );
    const freshness =
      expiry == null ? "unverified" : expiry <= now ? "stale" : "live";
    if (freshness === "live") {
      total++;
      busy += Number(r.state === "busy");
      asking += Number(r.state === "asking");
      done += Number(r.state === "done");
      next = Math.min(next, expiry!);
    } else if (freshness === "stale") stale++;
    else unverified++;
    const agent = String(r.agent);
    cost[agent] ??= empty();
    (agents[agent] ??= []).push({
      ...r,
      freshness,
      presence_expires_at: expiry,
      usage: perRun[String(r.id)] || empty(),
    });
  }
  const installations = data[4].results.map((r) => ({
    id: String(r.id),
    label: String(r.label),
    last_contact_at: Number(r.last_contact_at),
    capabilities: JSON.parse(String(r.capabilities_json)) as {
      usage?: boolean;
      dropped?: number;
    },
  }));
  const complete =
    installations.length > 0 &&
    installations.every(
      (i) =>
        i.capabilities.usage === true &&
        !i.capabilities.dropped &&
        Number(i.last_contact_at) > now - PRESENCE_TTL_MS,
    );
  for (const c of Object.values(cost)) c.complete = c.complete && complete;
  return {
    revision: Number(data[0].results[0].revision),
    server_time: now,
    from,
    to,
    timezone: config.reporting_timezone,
    next_refresh_at: next,
    total,
    busy,
    asking,
    done,
    stale,
    unverified,
    agents,
    order: Object.keys(agents).sort(),
    cost,
    installations,
    usage_complete: complete,
  };
}
