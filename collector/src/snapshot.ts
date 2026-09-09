// Allow two five-minute reconciliation intervals before marking a reporter stale.
const PRESENCE_TTL_MS = 10 * 60 * 1000;

import { HttpError } from "./protocol";
import { dayBounds } from "./reporting-day";
export { dayBounds } from "./reporting-day";
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
// Materialized statistics are a bounded set of day/model/price buckets, regardless
// of how many transcript records have been ingested. These are also benchmarked
// directly with D1's rows_read metadata in the regression suite.
export function statisticsQueries(
  env: Env,
  workspace: string,
  from: number,
  to: number,
) {
  return [
    env.DB.prepare(
      "SELECT * FROM usage_rollups WHERE workspace_id=? AND run_id='' AND day_start>=? AND day_start<? LIMIT 4097",
    ).bind(workspace, from, to),
    env.DB.prepare(
      `SELECT c.* FROM session_runs r INDEXED BY active_run_snapshot
      CROSS JOIN usage_rollups c ON c.workspace_id=r.workspace_id AND c.run_id=r.id
      WHERE r.workspace_id=? AND r.ended_at IS NULL AND c.day_start>=? AND c.day_start<? LIMIT 4097`,
    ).bind(workspace, from, to),
  ];
}
export async function snapshot(
  env: Env,
  workspace: string,
  range?: [number, number],
) {
  const now = Date.now();
  const config = await env.DB.prepare(
    "SELECT reporting_timezone,(SELECT ready FROM statistics_state WHERE id=1) AS ready FROM workspaces WHERE id=?",
  )
    .bind(workspace)
    .first<{ reporting_timezone: string; ready: number }>();
  if (!config) throw new HttpError(404, "workspace not found");
  if (!config.ready)
    throw new HttpError(503, "statistics migration in progress");
  const [from, to] = range || dayBounds(now, config.reporting_timezone);
  if (
    range &&
    (dayBounds(from, config.reporting_timezone)[0] !== from ||
      dayBounds(to - 1, config.reporting_timezone)[1] !== to)
  )
    throw new HttpError(400, "usage intervals must cover whole reporting days");
  if (
    to <= now - 30 * 86400000 ||
    from < dayBounds(now - 30 * 86400000, config.reporting_timezone)[0]
  )
    throw new HttpError(410, "statistics are retained for 30 days");
  const data = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare("SELECT revision FROM workspaces WHERE id=?").bind(
      workspace,
    ),
    env.DB.prepare(
      `SELECT r.*,s.agent,s.native_session_id,i.label AS machine FROM session_runs r JOIN sessions s ON s.workspace_id=r.workspace_id AND s.id=r.session_id
      JOIN installations i ON i.workspace_id=r.workspace_id AND i.id=r.installation_id WHERE r.workspace_id=? AND r.ended_at IS NULL ORDER BY r.last_activity_at DESC LIMIT 1001`,
    ).bind(workspace),
    ...statisticsQueries(env, workspace, from, to),
    env.DB.prepare(
      "SELECT id,label,last_contact_at,capabilities_json FROM installations WHERE workspace_id=? AND disabled_at IS NULL LIMIT 1001",
    ).bind(workspace),
    env.DB.prepare(
      "SELECT * FROM usage_daily WHERE workspace_id=? AND day_start<? AND day_end>? LIMIT 1001",
    ).bind(workspace, to, from),
  ]);
  if (
    data[1].results.length > 1000 ||
    data[2].results.length > 4096 ||
    data[3].results.length > 4096 ||
    data[4].results.length > 1000
  )
    throw new HttpError(413, "snapshot too large; narrow usage interval");
  const cost: Record<string, Total> = {};
  const perRun: Record<string, Total> = {};
  for (const value of data[2].results) {
    const row = value as UsageRow & { id: string };
    add((cost[row.agent] ??= empty()), row);
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
  for (const value of data[3].results) {
    const row = value as UsageRow & { run_id: string };
    add((perRun[row.run_id] ??= empty()), row);
  }
  console.info(
    JSON.stringify({
      event: "snapshot_read_cost",
      rows_read: data.reduce((n, r) => n + r.meta.rows_read, 0),
      statistics_buckets: data[2].results.length + data[3].results.length,
    }),
  );
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
      usage: {
        ...(perRun[String(r.id)] || empty()),
        model: r.usage_model || r.model || null,
      },
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
