#!/usr/bin/env node
// JSON-feed pricing refresh with optional official-source review. Preview by default; --write changes local
// reviewed artifacts only. Deployment and D1 repricing remain explicit commands.
import { parseArgs } from "node:util";
import { readFile, writeFile, mkdir, readdir, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import {
  SOURCES,
  FEED_URL,
  parseFeed,
  parseOpenAI,
  parseAnthropic,
  mergeCatalog,
  validateCatalog,
  repricingSql,
} from "./lib/price-sync.mjs";
const { values } = parseArgs({
  options: {
    write: { type: "boolean" },
    "source-dir": { type: "string" },
    feed: { type: "string" },
    official: { type: "boolean" },
    "save-sources": { type: "string" },
    date: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "update-prices.mjs [--write] [--feed FILE] [--save-sources DIR] [--date YYYY-MM-DD]\nFetch llm-prices.com JSON by default; use --official [--source-dir DIR] for provider Markdown including cache-write and service-tier rates. Preview by default; --write updates local catalog, legacy Lua, source receipt, and repricing migration. No remote mutations.",
  );
  process.exit(0);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const date = values.date || new Date().toISOString().slice(0, 10);
if (
  !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
  !Number.isFinite(Date.parse(date)) ||
  new Date(date).toISOString().slice(0, 10) !== date ||
  date > new Date().toISOString().slice(0, 10)
)
  throw new Error("Invalid/future verification date");
const previous = JSON.parse(
  await readFile(resolve(root, "pricing/catalog.json"), "utf8"),
);
if (date < previous.verified_at.slice(0, 10))
  throw new Error("Cannot move pricing verification backwards");
const rules = JSON.parse(
  await readFile(resolve(root, "pricing/sync-rules.json"), "utf8"),
);
if (values["source-dir"] && !values.official)
  throw new Error(
    "--source-dir requires --official; use --feed for a saved JSON feed",
  );
if (values.feed && values.official)
  throw new Error("--feed cannot be combined with --official");
const sources = {};
for (const [provider, url] of Object.entries(
  values.official ? SOURCES : { feed: FEED_URL },
)) {
  let text;
  if (provider === "feed" && values.feed)
    text = await readFile(resolve(values.feed), "utf8");
  else if (values["source-dir"])
    text = await readFile(
      resolve(values["source-dir"], provider + ".md"),
      "utf8",
    );
  else {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(
        `${provider} pricing source returned HTTP ${response.status}`,
      );
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 2_000_000) throw new Error("Pricing source too large");
      chunks.push(chunk);
    }
    text = Buffer.concat(chunks).toString("utf8");
  }
  if (Buffer.byteLength(text) > 2_000_000)
    throw new Error("Pricing source too large");
  sources[provider] = {
    text,
    url,
    sha256: createHash("sha256").update(text).digest("hex"),
  };
  if (values["save-sources"]) {
    await mkdir(resolve(values["save-sources"]), { recursive: true });
    await writeFile(
      resolve(
        values["save-sources"],
        provider === "feed" ? "current-v1.json" : provider + ".md",
      ),
      text,
    );
  }
}
const feed = values.official
  ? null
  : parseFeed(JSON.parse(sources.feed.text), {
      ...previous,
      aliases: { ...previous.aliases, ...rules.aliases },
    });
const parsed = feed?.models || {
  ...parseOpenAI(sources.openai.text),
  ...parseAnthropic(sources.anthropic.text),
};
if (
  Object.keys(parsed).length < 50 ||
  !parsed["gpt-4.1"] ||
  !parsed["claude-haiku-4-5"]
)
  throw new Error("Pricing source is incomplete; review schema before writing");
const result = mergeCatalog(
  previous,
  parsed,
  values.official ? rules : { ...rules, rate_overrides: [] },
  date,
);
if (result.modified && result.catalog.version === previous.version)
  result.catalog.version =
    date +
    "-" +
    createHash("sha256")
      .update(JSON.stringify(result.catalog.models))
      .digest("hex")
      .slice(0, 8);
validateCatalog(result.catalog);
const sql = repricingSql(result);
let migration = null;
if (sql) {
  const files = await readdir(resolve(root, "migrations"));
  const n =
    Math.max(...files.map((f) => Number(/^(\d+)_/.exec(f)?.[1] || 0))) + 1;
  migration =
    String(n).padStart(4, "0") + "_prices_" + date.replaceAll("-", "") + ".sql";
}
const report = {
  mode: values.write ? "write" : "preview",
  source: values.official ? "official provider tables" : FEED_URL,
  feed_updated_at: feed?.updated_at,
  duplicates: feed?.duplicates,
  previous_version: previous.version,
  version: result.catalog.version,
  verified_at: result.catalog.verified_at,
  models: Object.keys(result.catalog.models).length,
  added: result.added,
  changed: result.changed,
  aliases_changed: result.aliasesChanged,
  retained_unlisted_models: result.omitted,
  retained_unlisted_rate_count: result.retained.length,
  warnings: result.warnings,
  migration,
  source_sha256: Object.fromEntries(
    Object.entries(sources).map(([p, s]) => [p, s.sha256]),
  ),
};
console.log(JSON.stringify(report, null, 2));
if (values.write) {
  // Parse and validate every source before any catalog/migration mutation.
  const path = resolve(root, "pricing/catalog.json");
  const text = JSON.stringify(result.catalog, null, 2) + "\n";
  if (text !== (await readFile(path, "utf8"))) {
    await writeFile(path + ".tmp", text);
    await rename(path + ".tmp", path);
  }
  if (sql)
    await writeFile(resolve(root, "migrations", migration), sql, {
      flag: "wx",
    });
  let priorReceipt = {};
  try {
    priorReceipt = JSON.parse(
      await readFile(resolve(root, "pricing/sources.json"), "utf8"),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const receipt = {
    verified_at: result.catalog.verified_at,
    catalog_version: result.catalog.version,
    sources: {
      ...priorReceipt.sources,
      ...Object.fromEntries(
        Object.entries(sources).map(([p, s]) => [
          p,
          {
            url: s.url,
            sha256: s.sha256,
            ...(p === "feed" ? { updated_at: feed.updated_at } : {}),
          },
        ]),
      ),
    },
    rules_sha256: createHash("sha256")
      .update(JSON.stringify(rules))
      .digest("hex"),
  };
  await writeFile(
    resolve(root, "pricing/sources.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  execFileSync(
    process.execPath,
    [resolve(root, "scripts/sync-legacy-pricing.mjs")],
    { stdio: "inherit" },
  );
  console.log(
    "Updated local pricing artifacts. Review the diff and run pnpm test. Deploy the Worker before applying the generated repricing migration.",
  );
}
