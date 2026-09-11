#!/usr/bin/env node
// Read-only audit. Feed omissions/nulls never erase verified provider rates.
import { readFile } from "node:fs/promises";
import { catalog, modelPrice } from "../src/pricing.ts";
const url = "https://www.llm-prices.com/current-v1.json";
const feed = process.argv[2]
  ? JSON.parse(await readFile(process.argv[2], "utf8"))
  : await (async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok)
        throw new Error(`Pricing feed returned ${response.status}`);
      return response.json();
    })();
if (!Array.isArray(feed.prices) || typeof feed.updated_at !== "string")
  throw new Error("Invalid pricing feed");
const mismatches = [],
  missing = [],
  duplicates = [],
  seen = new Set();
let compared = 0;
for (const row of feed.prices) {
  const key = `${row.vendor}/${row.id}`;
  if (seen.has(key)) {
    duplicates.push(key);
    continue;
  }
  seen.add(key);
  if (
    !["anthropic", "openai"].includes(row.vendor) ||
    row.id.startsWith("gpt-image")
  )
    continue;
  const match = row.id.match(/-(200|272)k$/);
  const id = match ? row.id.slice(0, -match[0].length) : row.id;
  const model = modelPrice(row.vendor, id);
  if (!model) {
    missing.push(key);
    continue;
  }
  const rates = match ? model.tiers.standard.long : model.tiers.standard.short;
  if (!rates) {
    missing.push(key);
    continue;
  }
  for (const [field, metric] of [
    ["input", "input"],
    ["input_cached", "cache_read"],
    ["output", "output"],
  ]) {
    if (row[field] == null) continue;
    if (
      typeof row[field] !== "number" ||
      !Number.isFinite(row[field]) ||
      row[field] < 0
    )
      throw new Error(`Invalid rate for ${key}`);
    compared++;
    if (row[field] !== rates[metric])
      mismatches.push({
        model: key,
        metric,
        catalog: rates[metric] ?? null,
        feed: row[field],
      });
  }
}
console.log(
  JSON.stringify(
    {
      catalog: catalog.version,
      feed_updated_at: feed.updated_at,
      compared,
      mismatches,
      missing,
      duplicates,
    },
    null,
    2,
  ),
);
if (mismatches.length) process.exitCode = 1;
