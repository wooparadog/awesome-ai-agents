#!/usr/bin/env node
// Drain the restartable pricing queue immediately after migration/deployment.
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { catalog, resolveRates } from "../src/pricing.ts";
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
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
function execute(sql) {
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
  const result = JSON.parse(
    execFileSync(resolve(root, "node_modules/.bin/wrangler"), args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
  if (!Array.isArray(result) || result.some((row) => row.success === false))
    throw new Error("Repricing failed");
  return result;
}
let count = 0;
for (;;) {
  const rows =
    execute(`SELECT workspace_id,id,provider,model,measurement_kind,occurred_at,
    input,output,cache_read,cache_write_5m,cache_write_1h,pricing_json FROM usage_records
    WHERE archived=0 AND pricing_version='' ORDER BY workspace_id,id LIMIT 200`)[0]
      .results;
  if (!rows.length) break;
  const updates = rows.map((row) => {
    const rates = resolveRates(
      row.provider,
      row.model,
      row.measurement_kind,
      row,
      JSON.parse(row.pricing_json),
      row.occurred_at,
    );
    // Every UPDATE invokes transactional subtract/add triggers for all totals.
    return `UPDATE usage_records SET resolved_rates=${quote(JSON.stringify(rates))},pricing_version=${quote(catalog.version)}
      WHERE workspace_id=${quote(row.workspace_id)} AND id=${quote(row.id)} AND archived=0 AND pricing_version=''
      AND pricing_json=${quote(row.pricing_json)};`;
  });
  for (let i = 0; i < updates.length; i += 40)
    execute(updates.slice(i, i + 40).join("\n"));
  for (const workspace of new Set(rows.map((row) => row.workspace_id)))
    execute(`UPDATE workspaces SET revision=revision+1 WHERE id=${quote(workspace)};
    INSERT INTO notification_outbox(workspace_id,pending_revision) SELECT id,revision FROM workspaces WHERE id=${quote(workspace)}
    ON CONFLICT(workspace_id) DO UPDATE SET pending_revision=excluded.pending_revision,next_attempt_at=0;`);
  count += rows.length;
  console.log(JSON.stringify({ repriced: count, catalog: catalog.version }));
}
console.log(
  JSON.stringify({
    status: "complete",
    repriced: count,
    catalog: catalog.version,
  }),
);
