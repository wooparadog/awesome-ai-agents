#!/usr/bin/env node
// Generates credentials and an operator SQL file. Applies only to local D1 when requested.
import { parseArgs } from "node:util";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const { values } = parseArgs({
  options: {
    workspace: { type: "string", default: "personal" },
    installation: { type: "string" },
    label: { type: "string" },
    scope: { type: "string", default: "write" },
    output: { type: "string" },
    local: { type: "boolean", default: false },
    revoke: { type: "string" },
  },
});
if (!values.output)
  throw new Error(
    "--output DIRECTORY is required (credentials are written privately)",
  );
if (!["read", "write"].includes(values.scope))
  throw new Error("--scope must be read or write");
const out = resolve(values.output);
mkdirSync(out, { recursive: true, mode: 0o700 });
const q = (s) => "'" + s.replaceAll("'", "''") + "'";
let sql;
if (values.revoke)
  sql = `UPDATE api_tokens SET revoked_at=${Date.now()} WHERE workspace_id=${q(values.workspace)} AND id=${q(values.revoke)};\n`;
else {
  const id = randomUUID(),
    installation = values.installation || randomUUID(),
    secret = randomBytes(32).toString("base64url");
  const digest = createHash("sha256").update(secret).digest("hex");
  sql = `INSERT INTO workspaces(id,name,created_at) VALUES(${q(values.workspace)},${q(values.workspace)},${Date.now()}) ON CONFLICT DO NOTHING;\n`;
  if (values.scope === "write")
    sql += `INSERT INTO installations(workspace_id,id,label,created_at) VALUES(${q(values.workspace)},${q(installation)},${q(values.label || installation)},${Date.now()}) ON CONFLICT DO NOTHING;\n`;
  sql += `INSERT INTO api_tokens(id,workspace_id,secret_hash,scope,installation_id) VALUES(${q(id)},${q(values.workspace)},${q(digest)},${q(values.scope)},${values.scope === "write" ? q(installation) : "NULL"});\n`;
  writeFileSync(resolve(out, "credential.token"), `${id}.${secret}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  writeFileSync(
    resolve(out, "identity.json"),
    JSON.stringify(
      {
        workspace: values.workspace,
        installation_id: values.scope === "write" ? installation : null,
        token_id: id,
        scope: values.scope,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600, flag: "wx" },
  );
}
const sqlPath = resolve(out, "provision.sql");
writeFileSync(sqlPath, sql, { mode: 0o600, flag: "wx" });
if (values.local) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  execFileSync(
    resolve(root, "node_modules/.bin/wrangler"),
    ["d1", "execute", "DB", "--local", "--file", sqlPath],
    { cwd: root, stdio: "inherit" },
  );
}
console.log(
  `Wrote private provisioning files to ${out}. ${values.local ? "Applied to local D1." : "No database was changed."}`,
);
