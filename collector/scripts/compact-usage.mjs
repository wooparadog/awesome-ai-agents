#!/usr/bin/env node
// One-time, restartable backfill. Uses the installed Wrangler and no embedded credentials.
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dayBounds } from "../src/reporting-day.ts";
const { values } = parseArgs({
  options: {
    local: { type: "boolean" },
    remote: { type: "boolean" },
    database: { type: "string", default: "ai-agents" },
    config: { type: "string" },
    "persist-to": { type: "string" },
  },
});
if (!!values.local === !!values.remote)
  throw new Error("Specify exactly one of --local or --remote");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
let metered = true;
let reads = 0,
  writes = 0;
function execute(sql) {
  // Remote --file uses the import API, which emits progress and omits SELECT
  // rows. --command returns query results and metering as JSON. SQL contains
  // only schema identifiers, workspace IDs and timestamps; no credentials.
  const args = [
    "d1",
    "execute",
    values.database,
    values.remote ? "--remote" : "--local",
    "--command",
    sql,
    "--json",
  ];
  if (values.config) args.push("--config", resolve(values.config));
  if (values["persist-to"])
    args.push("--persist-to", resolve(values["persist-to"]));
  const text = execFileSync(resolve(root, "node_modules/.bin/wrangler"), args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const result = JSON.parse(text);
  if (!Array.isArray(result) || result.some((r) => r.success === false))
    throw new Error("Backfill query failed");
  for (const r of result) {
    if (
      typeof r.meta?.rows_read !== "number" ||
      typeof r.meta?.rows_written !== "number"
    )
      metered = false;
    reads += r.meta?.rows_read || 0;
    writes += r.meta?.rows_written || 0;
  }
  return result;
}
{
  const now = Date.now(),
    cutoff = now - 30 * 86400000;
  const existing = execute("SELECT ready FROM statistics_state WHERE id=1;")[0]
    .results[0];
  if (existing.ready) {
    console.log("Compact statistics are already initialized.");
  } else {
    // Old data outside the supported history is no longer needed. Preserve the
    // most recent 30 days in summaries before the hourly seven-day cleanup runs.
    const configurations = execute(
      "SELECT id,reporting_timezone FROM workspaces;",
    )[0].results;
    for (const w of configurations) {
      const firstDay = dayBounds(cutoff, w.reporting_timezone)[0];
      execute(
        `UPDATE usage_records SET archived=1 WHERE workspace_id=${quote(w.id)} AND day_start IS NULL AND occurred_at<${firstDay};`,
      );
    }
    const workspaces =
      execute(`SELECT w.id,w.reporting_timezone,MIN(u.occurred_at) AS oldest,MAX(u.occurred_at) AS newest
      FROM workspaces w JOIN usage_records u ON u.workspace_id=w.id
      WHERE u.day_start IS NULL AND u.archived=0 GROUP BY w.id;`)[0].results;
    for (const w of workspaces) {
      let [from, to] = dayBounds(w.oldest, w.reporting_timezone);
      while (from <= w.newest) {
        execute(`UPDATE usage_records SET day_start=${from},day_end=${to}
          WHERE workspace_id=${quote(w.id)} AND day_start IS NULL AND archived=0 AND occurred_at>=${from} AND occurred_at<${to};`);
        [from, to] = dayBounds(to, w.reporting_timezone);
      }
    }
    execute(`UPDATE session_runs SET usage_model=(SELECT u.model FROM usage_observations o JOIN usage_records u
        ON u.workspace_id=o.workspace_id AND u.id=o.usage_id WHERE o.workspace_id=session_runs.workspace_id AND o.run_id=session_runs.id
        ORDER BY u.occurred_at DESC,u.id DESC LIMIT 1),
      usage_observed_at=(SELECT MAX(u.occurred_at) FROM usage_observations o JOIN usage_records u
        ON u.workspace_id=o.workspace_id AND u.id=o.usage_id WHERE o.workspace_id=session_runs.workspace_id AND o.run_id=session_runs.id)
      WHERE usage_observed_at IS NULL;`);
    const pending = execute(
      "SELECT 1 FROM usage_records WHERE archived=0 AND day_start IS NULL LIMIT 1;",
    )[0].results;
    if (pending.length)
      throw new Error(
        "Unprojected evidence remains; rerun after all old Worker versions have stopped",
      );
    execute(
      "UPDATE statistics_state SET ready=1 WHERE id=1; UPDATE workspaces SET revision=revision+1; INSERT INTO notification_outbox(workspace_id,pending_revision) SELECT id,revision FROM workspaces WHERE 1 ON CONFLICT(workspace_id) DO UPDATE SET pending_revision=excluded.pending_revision,next_attempt_at=0; DELETE FROM statistics_dirty;",
    );
    console.log(
      JSON.stringify({
        backfill: "complete",
        rows_read: metered ? reads : null,
        rows_written: metered ? writes : null,
      }),
    );
  }
}
