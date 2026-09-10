import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const collector = resolve(root, "collector");
const state = resolve(root, "clients/web/.test-state");
const wrangler = resolve(collector, "node_modules/.bin/wrangler");
rmSync(state, { recursive: true, force: true });
mkdirSync(state, { recursive: true });
const database = resolve(state, "worker");
execFileSync(
  wrangler,
  [
    "d1",
    "migrations",
    "apply",
    "ai-agents",
    "--local",
    "--persist-to",
    database,
  ],
  { cwd: collector, stdio: "pipe" },
);
const secret = "e".repeat(43),
  digest = createHash("sha256").update(secret).digest("hex");
const sql = `INSERT INTO workspaces(id,name,created_at) VALUES('web-test','Web test',${Date.now()});
INSERT INTO installations(workspace_id,id,label,created_at) VALUES('web-test','web-test-writer','arch-workstation',${Date.now()});
INSERT INTO api_tokens(id,workspace_id,secret_hash,scope,installation_id) VALUES('web-test-writer','web-test','${digest}','write','web-test-writer');`;
writeFileSync(resolve(state, "seed.sql"), sql);
execFileSync(
  wrangler,
  [
    "d1",
    "execute",
    "ai-agents",
    "--local",
    "--persist-to",
    database,
    "--file",
    resolve(state, "seed.sql"),
  ],
  { cwd: collector, stdio: "pipe" },
);
const child = spawn(
  wrangler,
  [
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    "8788",
    "--local-upstream",
    "127.0.0.1:8788",
    "--persist-to",
    database,
  ],
  { cwd: collector, stdio: "inherit" },
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code || 0));
