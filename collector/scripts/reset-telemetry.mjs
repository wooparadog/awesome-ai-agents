#!/usr/bin/env node
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const { values } = parseArgs({
  options: {
    local: { type: "boolean" },
    remote: { type: "boolean" },
    workspace: { type: "string" },
    database: { type: "string", default: "ai-agents" },
    "persist-to": { type: "string" },
  },
});
if (!!values.local === !!values.remote || !values.workspace)
  throw new Error("Specify --workspace and exactly one of --local or --remote");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = "'" + values.workspace.replaceAll("'", "''") + "'";
const reset = Date.now();
const args = [
  "d1",
  "execute",
  values.database,
  values.remote ? "--remote" : "--local",
  "--command",
  `UPDATE workspaces SET usage_reset_at=${reset} WHERE id=${workspace} AND usage_reset_at<${reset} RETURNING id,usage_reset_at;`,
  "--json",
];
if (values["persist-to"])
  args.push("--persist-to", resolve(values["persist-to"]));
const results = JSON.parse(
  execFileSync(resolve(root, "node_modules/.bin/wrangler"), args, {
    cwd: root,
    encoding: "utf8",
  }),
);
if (results.some((r) => !r.success) || results[0]?.results?.length !== 1)
  throw new Error("Workspace reset did not complete");
console.log(
  JSON.stringify({
    workspace: values.workspace,
    usage_reset_at: reset,
    reset: "complete",
  }),
);
