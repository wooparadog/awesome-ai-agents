import { isDeepStrictEqual } from "node:util";
export const SOURCES = {
  openai: "https://developers.openai.com/api/docs/pricing.md",
  anthropic: "https://platform.claude.com/docs/en/about-claude/pricing.md",
};
const METRICS = [
  "input",
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
  "output",
];
const ID = /^[a-z0-9][a-z0-9._-]*$/;
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function table(lines, index) {
  const split = (s) =>
    s
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((s) => s.trim());
  const headers = split(lines[index]);
  assert(
    split(lines[index + 1] || "").every((s) => /^:?-+:?$/.test(s)),
    "Invalid Markdown table delimiter",
  );
  const rows = [];
  for (
    let i = index + 2;
    i < lines.length && lines[i].trim().startsWith("|");
    i++
  ) {
    const row = split(lines[i]);
    assert(row.length === headers.length, "Pricing table column count changed");
    rows.push(row);
  }
  return { headers, rows };
}
function rate(cell) {
  const clean = cell.replace(/<sup>.*?<\/sup>/g, "").trim();
  if (clean === "-" || clean === "—") return undefined;
  const match = /^\$([0-9]+(?:\.[0-9]+)?)(?:\s*\/\s*MTok)?$/.exec(clean);
  assert(match, `Unrecognized price cell: ${cell}`);
  const value = Number(match[1]);
  assert(
    Number.isFinite(value) &&
      value > 0 &&
      Math.abs(value * 1e6 - Math.round(value * 1e6)) < 1e-5,
    "Rate must be positive and representable as pico-USD",
  );
  return value;
}
function put(models, id, provider, tier, short, long) {
  assert(ID.test(id), `Invalid model ID: ${id}`);
  const model = (models[id] ??= {
    provider,
    source: SOURCES[provider].replace(/\.md$/, ""),
    tiers: {},
  });
  const value = { short, ...(long ? { long } : {}) };
  if (model.tiers[tier])
    assert(
      isDeepStrictEqual(model.tiers[tier], value),
      `Conflicting duplicate price: ${id}/${tier}`,
    );
  model.tiers[tier] = value;
}
export function parseOpenAI(markdown) {
  const lines = markdown.split(/\r?\n/),
    models = {};
  let section = "",
    tier = "standard";
  const found = new Set();
  assert(
    markdown.includes(
      "Short context: ≤272K input tokens. Long context: >272K input tokens.",
    ),
    "OpenAI context threshold changed; review parser",
  );
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (
      [
        "Flagship models",
        "Cyber models",
        "Multimodal models",
        "Specialized models",
        "Finetuning",
      ].includes(line)
    ) {
      section = line;
      tier = "standard";
    }
    if (["Standard", "Batch", "Flex", "Fast", "Ultrafast"].includes(line))
      tier = line.toLowerCase();
    if (
      !["Flagship models", "Cyber models", "Specialized models"].includes(
        section,
      ) ||
      !line.startsWith("|")
    )
      continue;
    if (!/^\|\s*(Model|Category)\s*\|/.test(line)) continue;
    const { headers, rows } = table(lines, i);
    const grouped = section !== "Specialized models";
    assert(
      isDeepStrictEqual(
        headers,
        grouped
          ? [
              "Model",
              "Short context input",
              "Short context cached input",
              "Short context cache writes",
              "Short context output",
              "Long context input",
              "Long context cached input",
              "Long context cache writes",
              "Long context output",
            ]
          : ["Category", "Model", "Input", "Cached input", "Output"],
      ),
      `Unexpected OpenAI ${section} headers`,
    );
    found.add(section + "/" + tier);
    for (const row of rows) {
      if (!grouped && ["Embedding", "Moderation"].includes(row[0])) continue;
      const id = row[grouped ? 0 : 1].replace(/ \(<272K context length\)$/, "");
      const short = {},
        long = {};
      const order = grouped
        ? ["input", "cache_read", "cache_write_5m", "output"]
        : ["input", "cache_read", "output"];
      const offset = grouped ? 1 : 2;
      for (let k = 0; k < order.length; k++) {
        const s = rate(row[offset + k]);
        if (s !== undefined) short[order[k]] = s;
        if (grouped) {
          const l = rate(row[offset + 4 + k]);
          if (l !== undefined) long[order[k]] = l;
        }
      }
      assert(short.input && short.output, `Missing input/output for ${id}`);
      const hasLong = Object.keys(long).length > 0;
      if (hasLong)
        assert(
          long.input && long.output,
          `Partial long-context rates for ${id}`,
        );
      put(models, id, "openai", tier, short, hasLong ? long : undefined);
      if (hasLong) models[id].context_threshold = 272000;
    }
    i += rows.length + 1;
  }
  for (const tier of ["standard", "batch", "flex", "fast"])
    assert(
      found.has("Flagship models/" + tier),
      `Missing OpenAI ${tier} table`,
    );
  assert(Object.keys(models).length >= 3, "Empty OpenAI pricing source");
  return models;
}
function claudeId(name) {
  const match = /^Claude (\w+) (\d+(?:\.\d+)?)/.exec(name);
  assert(match, `Unrecognized Claude model: ${name}`);
  const family = match[1].toLowerCase(),
    version = match[2].replaceAll(".", "-");
  // Historical Claude 3 IDs place the version before the family.
  return match[2].startsWith("3")
    ? `claude-${version}-${family}`
    : `claude-${family}-${version}`;
}
export function parseAnthropic(markdown) {
  const lines = markdown.split(/\r?\n/),
    models = {};
  let section = "";
  let batches = false,
    fast = false;
  assert(
    markdown.includes(
      "These multipliers stack with other pricing modifiers, including the Batch API discount and data residency.",
    ),
    "Claude cache stacking policy changed; review parser",
  );
  assert(
    markdown.includes("Claude 4.6 and later models") &&
      markdown.includes("1.1x multiplier on all token pricing categories"),
    "Claude regional policy changed; review parser",
  );
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#")) section = line.replace(/^#+ /, "");
    if (
      !["Model pricing", "Batch processing", "Fast mode pricing"].includes(
        section,
      ) ||
      !/^\|\s*Model\s*\|/.test(line)
    )
      continue;
    const { headers, rows } = table(lines, i);
    const base = section === "Model pricing";
    assert(
      isDeepStrictEqual(
        headers,
        base
          ? [
              "Model",
              "Base input tokens",
              "5m cache writes",
              "1h cache writes",
              "Cache hits and refreshes",
              "Output tokens",
            ]
          : section === "Batch processing"
            ? ["Model", "Batch input", "Batch output"]
            : ["Model", "Input", "Output"],
      ),
      `Unexpected Claude ${section} headers`,
    );
    for (const row of rows) {
      // Only fast-mode tables combine several models in one cell.
      const names =
        base || section === "Batch processing" ? [row[0]] : row[0].split(" / ");
      for (const name of names) {
        const id = claudeId(name);
        if (base) {
          const short = {};
          for (const [k, metric] of [
            "input",
            "cache_write_5m",
            "cache_write_1h",
            "cache_read",
            "output",
          ].entries()) {
            short[metric] = rate(row[k + 1]);
            assert(
              short[metric] !== undefined,
              `Missing Claude rate: ${id}/${metric}`,
            );
          }
          put(models, id, "anthropic", "standard", short);
          const version = Number(/^Claude \w+ (\d+(?:\.\d+)?)/.exec(name)[1]);
          models[id].regional = version >= 4.6;
        } else {
          const standard = models[id]?.tiers.standard.short;
          assert(standard, `No standard Claude prices for ${id}`);
          const input = rate(row[1]),
            output = rate(row[2]);
          assert(input && output, `Missing ${section} rates for ${id}`);
          const scale = input / standard.input;
          const short = { input, output };
          for (const metric of [
            "cache_read",
            "cache_write_5m",
            "cache_write_1h",
          ])
            short[metric] = Number((standard[metric] * scale).toFixed(8));
          put(
            models,
            id,
            "anthropic",
            section === "Batch processing" ? "batch" : "fast",
            short,
          );
        }
      }
    }
    if (section === "Batch processing") batches = true;
    if (section === "Fast mode pricing") fast = true;
    i += rows.length + 1;
  }
  assert(
    Object.keys(models).length >= 3 && batches && fast,
    "Claude pricing tables missing",
  );
  return models;
}
function comparable(model) {
  const { verified_at, source, ...rest } = model;
  return rest;
}
export function mergeCatalog(previous, parsed, rules, date) {
  const next = structuredClone(previous),
    added = [],
    changed = [],
    retained = [],
    warnings = [];
  // Freeze the original evidence date before advancing the catalog snapshot date.
  for (const model of Object.values(next.models))
    model.verified_at ??= previous.verified_at;
  for (const [id, incoming] of Object.entries(parsed)) {
    assert(incoming.tiers.standard, `Missing standard tier for ${id}`);
    const old = next.models[id];
    assert(
      !old || old.provider === incoming.provider,
      `Provider collision: ${id}`,
    );
    const merged = structuredClone(
      old || {
        provider: incoming.provider,
        source: incoming.source,
        tiers: {},
        regional: false,
      },
    );
    let preserved = false;
    // A missing model/tier/metric is not proof of a free or discontinued rate.
    for (const [tier, contexts] of Object.entries(merged.tiers))
      for (const [context, prices] of Object.entries(contexts))
        for (const metric of Object.keys(prices)) {
          if (incoming.tiers[tier]?.[context]?.[metric] === undefined) {
            preserved = true;
            retained.push(`${id}/${tier}/${context}/${metric}`);
          }
        }
    for (const [tier, contexts] of Object.entries(incoming.tiers))
      for (const [context, prices] of Object.entries(contexts)) {
        merged.tiers[tier] ??= {};
        merged.tiers[tier][context] = {
          ...merged.tiers[tier][context],
          ...prices,
        };
      }
    if (incoming.context_threshold != null)
      merged.context_threshold = incoming.context_threshold;
    if (incoming.regional != null) merged.regional = incoming.regional;
    Object.assign(merged, rules.models?.[id] || {});
    if (
      !old &&
      incoming.provider === "openai" &&
      rules.models?.[id]?.regional == null
    )
      warnings.push(`${id}: regional pricing not reviewed; global-only`);
    merged.source = preserved && old ? old.source : incoming.source;
    const evidenceDate = incoming.verified_at || date + "T00:00:00Z";
    const priorDate = old?.verified_at || previous.verified_at;
    merged.verified_at = preserved
      ? priorDate
      : old &&
          Date.parse(priorDate) > Date.parse(evidenceDate) &&
          isDeepStrictEqual(merged.tiers, old.tiers)
        ? priorDate
        : evidenceDate;
    next.models[id] = merged;
  }
  for (const entry of rules.rate_overrides || []) {
    const { model, tier, context, metric, published, value } = entry;
    const observed = parsed[model]?.tiers[tier]?.[context]?.[metric];
    assert(
      observed === published,
      `Review stale override ${model}/${tier}/${context}/${metric}: expected ${published}, found ${observed}`,
    );
    next.models[model].tiers[tier][context][metric] = value;
  }
  for (const [alias, id] of Object.entries(rules.aliases || {})) {
    assert(next.models[id], `Alias target missing: ${id}`);
    assert(!next.models[alias], `Alias collides with model: ${alias}`);
    next.aliases[alias] = id;
  }
  for (const [id, model] of Object.entries(next.models)) {
    if (!previous.models[id]) added.push(id);
    else if (
      !isDeepStrictEqual(comparable(model), comparable(previous.models[id]))
    )
      changed.push(id);
  }
  const aliasesChanged = Object.keys(next.aliases).filter(
    (id) => next.aliases[id] !== previous.aliases[id],
  );
  const modified = added.length + changed.length + aliasesChanged.length > 0;
  next.models = Object.fromEntries(
    Object.entries(next.models).sort(([a], [b]) => a.localeCompare(b)),
  );
  // Same source/data run twice produces no new version or migration.
  const metadataChanged = Object.keys(next.models).some(
    (id) =>
      next.models[id].verified_at !==
      (previous.models[id]?.verified_at || previous.verified_at),
  );
  if (modified || metadataChanged) {
    next.version = date;
    next.verified_at = date + "T00:00:00Z";
  } else {
    next.version = previous.version;
    next.verified_at = previous.verified_at;
  }
  return {
    catalog: next,
    added: added.sort(),
    changed: changed.sort(),
    aliasesChanged,
    retained,
    omitted: Object.keys(previous.models).filter((id) => !parsed[id]),
    warnings,
    modified,
    metadataChanged,
  };
}
export function validateCatalog(catalog) {
  assert(
    catalog.units === "USD per million tokens",
    "Unexpected catalog units",
  );
  assert(
    Number.isFinite(Date.parse(catalog.verified_at)),
    "Invalid verification timestamp",
  );
  for (const [id, m] of Object.entries(catalog.models)) {
    assert(
      ID.test(id) &&
        ["openai", "anthropic"].includes(m.provider) &&
        m.tiers.standard,
      "Invalid model",
    );
    assert(
      Number.isFinite(Date.parse(m.verified_at || catalog.verified_at)),
      `Invalid model date: ${id}`,
    );
    if (m.context_threshold != null)
      assert(
        Number.isSafeInteger(m.context_threshold) && m.context_threshold > 0,
        "Invalid threshold",
      );
    for (const [tier, contexts] of Object.entries(m.tiers)) {
      assert(
        ["standard", "fast", "ultrafast", "batch", "flex"].includes(tier),
        "Unknown tier",
      );
      for (const [context, prices] of Object.entries(contexts)) {
        assert(
          ["short", "long"].includes(context) &&
            prices.input > 0 &&
            prices.output > 0,
          "Incomplete rate set",
        );
        for (const [metric, rate] of Object.entries(prices))
          assert(
            METRICS.includes(metric) &&
              Number.isFinite(rate) &&
              rate > 0 &&
              Math.abs(rate * 1e6 - Math.round(rate * 1e6)) < 1e-5,
            "Invalid catalog rate",
          );
      }
    }
  }
  for (const [alias, id] of Object.entries(catalog.aliases))
    assert(
      ID.test(alias) && catalog.models[id] && !catalog.models[alias],
      `Invalid alias: ${alias}`,
    );
}
export function repricingSql(result) {
  const names = new Set([
    ...result.added,
    ...result.changed,
    ...result.aliasesChanged,
  ]);
  for (const [alias, target] of Object.entries(result.catalog.aliases))
    if (names.has(target)) names.add(alias);
  if (!names.size) return null;
  const q = (s) => "'" + s.replaceAll("'", "''") + "'";
  const clauses = [...names].sort().map((name) => {
    assert(ID.test(name), "Invalid migration model ID");
    const start = name.length + 2;
    const digits = (position, length) =>
      `substr(model,${position},${length}) NOT GLOB '*[^0-9]*'`;
    // D1 caps LIKE/GLOB pattern complexity below native SQLite defaults. Match
    // the prefix/length separately and use only short numeric predicates.
    return `(model=${q(name)} OR (substr(model,1,${name.length + 1})=${q(name + "-")} AND ((length(model)=${name.length + 9} AND ${digits(start, 8)}) OR (length(model)=${name.length + 11} AND substr(model,${start + 4},1)='-' AND substr(model,${start + 7},1)='-' AND ${digits(start, 4)} AND ${digits(start + 5, 2)} AND ${digits(start + 8, 2)}))) OR (substr(model,1,${name.length + 1})=${q(name + "@")} AND substr(model,${start})!='' AND substr(model,${start}) NOT GLOB '*[^0-9]*'))`;
  });
  return `-- Generated pricing refresh ${result.catalog.version}; deploy the matching catalog before applying.\n-- Only retained evidence for changed models is queued; frozen summaries remain unchanged.\nUPDATE usage_records SET pricing_version=''\nWHERE archived=0 AND pricing_version!=${q(result.catalog.version)} AND (\n  ${clauses.join("\n  OR ")}\n);\n`;
}

export const FEED_URL = "https://www.llm-prices.com/current-v1.json";
export function parseFeed(feed, catalog) {
  assert(
    Array.isArray(feed.prices) && typeof feed.updated_at === "string",
    "Invalid pricing feed",
  );
  assert(
    /^\d{4}-\d{2}-\d{2}/.test(feed.updated_at) &&
      Number.isFinite(Date.parse(feed.updated_at)),
    "Invalid feed timestamp",
  );
  assert(
    Date.parse(feed.updated_at) <= Date.now() + 86400000,
    "Feed timestamp is in the future",
  );
  const models = {},
    seen = new Map(),
    duplicates = [];
  for (const row of feed.prices) {
    if (!["openai", "anthropic"].includes(row.vendor)) continue;
    assert(
      typeof row.id === "string" && ID.test(row.id),
      "Invalid feed model ID",
    );
    // The reporter records text usage only; multimodal/embedding billing needs
    // modality counters before it can safely be included here.
    if (
      /^(gpt-image|chatgpt-image|gpt-realtime|gpt-audio|gpt-live|text-embedding|tts-|whisper|omni-moderation)/.test(
        row.id,
      )
    )
      continue;
    const tier = /-(\d+)k$/.exec(row.id),
      base = tier ? row.id.slice(0, -tier[0].length) : row.id;
    const id = catalog.aliases[base] || base;
    const context = tier ? "long" : "short",
      prices = {};
    for (const [field, metric] of [
      ["input", "input"],
      ["input_cached", "cache_read"],
      ["output", "output"],
    ]) {
      if (row[field] == null) continue;
      assert(
        typeof row[field] === "number" &&
          Number.isFinite(row[field]) &&
          row[field] > 0 &&
          Math.abs(row[field] * 1e6 - Math.round(row[field] * 1e6)) < 1e-5,
        `Invalid ${field} rate for ${row.id}`,
      );
      prices[metric] = row[field];
    }
    assert(
      prices.input && prices.output,
      `Missing input/output rate for ${row.id}`,
    );
    const key = `${row.vendor}/${id}/${context}`;
    if (seen.has(key)) {
      assert(
        isDeepStrictEqual(prices, seen.get(key)),
        `Conflicting duplicate feed model: ${key}`,
      );
      duplicates.push(key);
      continue;
    }
    seen.set(key, prices);
    const model = (models[id] ??= {
      provider: row.vendor,
      source: FEED_URL,
      verified_at: new Date(feed.updated_at).toISOString(),
      tiers: { standard: {} },
    });
    assert(model.provider === row.vendor, `Feed provider collision: ${id}`);
    model.tiers.standard[context] = prices;
    if (tier) {
      const threshold = Number(tier[1]) * 1000;
      assert(
        threshold > 0 && Number.isSafeInteger(threshold),
        "Invalid feed threshold",
      );
      if (model.context_threshold != null)
        assert(
          model.context_threshold === threshold,
          "Conflicting feed context thresholds",
        );
      model.context_threshold = threshold;
    }
  }
  assert(Object.keys(models).length > 0, "No supported text models in feed");
  for (const [id, m] of Object.entries(models))
    assert(m.tiers.standard.short, `Missing short-context feed row for ${id}`);
  return { models, duplicates, updated_at: feed.updated_at };
}
