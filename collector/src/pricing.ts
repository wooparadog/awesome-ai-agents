import catalogData from "../pricing/catalog.json" with { type: "json" };

export const metrics = [
  "input",
  "output",
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
] as const;
export type Counters = Partial<Record<(typeof metrics)[number], number>>;
export type PricingContext = {
  service_tier?: string;
  speed?: string;
  inference_geo?: string;
  billing_provider?: string;
};
type Model = {
  provider: string;
  context_threshold?: number;
  regional?: boolean;
  source: string;
  tiers: Record<string, { short: Counters; long?: Counters }>;
};
export const catalog = catalogData as {
  version: string;
  verified_at: string;
  aliases: Record<string, string>;
  models: Record<string, Model>;
};

export function modelPrice(
  provider: string,
  model: string | null,
): Model | undefined {
  if (!model) return;
  // Snapshot suffixes only; never price a new model by an older family prefix.
  const base = model.replace(/(?:-\d{8}|-\d{4}-\d{2}-\d{2}|@\d+)$/, "");
  const found =
    catalog.models[model] ||
    catalog.models[catalog.aliases[model]] ||
    catalog.models[base] ||
    catalog.models[catalog.aliases[base]];
  return found?.provider === provider ? found : undefined;
}

// Integer pico-USD/token preserves fractional nano-USD rates (Batch/Flex/cache).
// Metadata travels with each materialized rate set, including archived rollups.
export function resolveRates(
  provider: string,
  model: string | null,
  kind: string,
  counts: Counters,
  context: PricingContext,
  occurredAt: number,
): Record<string, number> {
  const m = modelPrice(provider, model);
  if (!m) return {};
  if (context.billing_provider && context.billing_provider !== "direct")
    return {};
  let tier = context.service_tier || "standard";
  if (tier === "default") tier = "standard";
  if (provider === "openai" && tier === "priority") tier = "fast";
  if (context.speed && !["standard", "normal", "fast"].includes(context.speed))
    return {};
  if (context.speed === "fast") {
    if (!["standard", "fast"].includes(tier)) return {};
    tier = "fast";
  }
  const prices = m.tiers[tier];
  if (!prices) return {};
  const prompt =
    (counts.input || 0) +
    (counts.cache_read || 0) +
    (counts.cache_write_5m || 0) +
    (counts.cache_write_1h || 0);
  const long =
    kind === "delta" &&
    m.context_threshold != null &&
    prompt > m.context_threshold;
  const selected = long ? prices.long : prices.short;
  if (!selected) return {}; // No published rate for this tier/context combination.
  const geo = context.inference_geo || "global";
  if (!["global", "us", "eu", "regional"].includes(geo)) return {};
  if (geo !== "global" && !m.regional) return {};
  if (provider === "anthropic" && !["global", "us"].includes(geo)) return {};
  if (m === catalog.models["gpt-6-astra"] && tier === "fast" && geo === "eu")
    return {};
  const verified = Date.parse(catalog.verified_at);
  const estimated =
    kind !== "delta" ||
    !context.service_tier ||
    !context.billing_provider ||
    (m.regional && !context.inference_geo) ||
    (provider === "anthropic" &&
      !!m.tiers.fast &&
      !context.speed &&
      tier === "standard") ||
    occurredAt < verified ||
    occurredAt > verified + 30 * 86400000;
  const result: Record<string, number> = {
    _unit: 1e12,
    _estimated: Number(!!estimated),
  };
  for (const metric of metrics) {
    const rate = selected[metric];
    // Missing cache prices are unknown, never free.
    if (rate != null)
      result[metric] = Math.round(rate * 1e6 * (geo === "global" ? 1 : 1.1));
  }
  return result;
}
