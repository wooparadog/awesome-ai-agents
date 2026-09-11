#!/usr/bin/env node
// Keep the legacy desktop's standard-rate estimates in sync with the collector.
import { readFileSync, writeFileSync } from "node:fs";
const catalog = JSON.parse(
  readFileSync(new URL("../pricing/catalog.json", import.meta.url), "utf8"),
);
const lines = [
  `-- Generated from collector/pricing/catalog.json (${catalog.version}).`,
  "-- Legacy daily aggregates cannot recover per-request context or billing tiers.",
  "-- stylua: ignore",
  "return { models = {",
];
for (const [model, entry] of Object.entries(catalog.models)) {
  const rates = Object.entries(entry.tiers.standard.short)
    .map(([metric, rate]) => `${metric} = ${rate}`)
    .join(", ");
  lines.push(`  [${JSON.stringify(model)}] = { ${rates} },`);
}
lines.push("}, aliases = {");
for (const [alias, model] of Object.entries(catalog.aliases))
  lines.push(`  [${JSON.stringify(alias)}] = ${JSON.stringify(model)},`);
lines.push("} }", "");
const path = new URL(
  "../../clients/awesomewm/pricing_data.lua",
  import.meta.url,
);
const text = lines.join("\n");
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== text)
    throw new Error(
      "Legacy prices are stale; run scripts/sync-legacy-pricing.mjs",
    );
} else writeFileSync(path, text);
