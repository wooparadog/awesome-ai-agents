#! /usr/bin/env lua

-- Per-model token prices, in US dollars per *million* tokens.
--
-- Anthropic publishes base input/output rates; the cache rates follow fixed
-- multipliers off the base input rate (5-minute write 1.25x, 1-hour write 2x,
-- read 0.1x) unless a model overrides them. OpenAI publishes an input, a
-- cached-input and an output rate, which map onto the same fields.
--
-- Hand-maintained: bump these when prices change. A model that is missing here
-- is not an error — the widget still reports its token counts and simply omits
-- it from the dollar total (see `pricing.lookup`).

local pricing = {}

-- input / output / cache write (5m) / cache write (1h) / cache read
local function anthropic(input, output, cache_read)
  return {
    input = input,
    output = output,
    cache_write_5m = input * 1.25,
    cache_write_1h = input * 2.0,
    cache_read = cache_read or input * 0.1,
  }
end

local function openai(input, cached_input, output)
  return {
    input = input,
    output = output,
    -- OpenAI bills a cached *read* at a discount and never charges to write.
    cache_write_5m = 0,
    cache_write_1h = 0,
    cache_read = cached_input,
  }
end

-- Longest key wins, so "claude-opus-4-8" beats "claude-opus-4".
pricing.models = {
  -- ── Anthropic ─────────────────────────────────────────────────────────────
  ["claude-fable-5-1"] = anthropic(10.00, 50.00, 0.25),
  ["claude-mythos-5-1"] = anthropic(10.00, 50.00, 0.25),
  ["claude-fable-5"] = anthropic(10.00, 50.00),
  ["claude-mythos-5"] = anthropic(10.00, 50.00),
  ["claude-opus-5"] = anthropic(5.00, 25.00),
  ["claude-opus-4-8"] = anthropic(5.00, 25.00),
  ["claude-opus-4-7"] = anthropic(5.00, 25.00),
  ["claude-opus-4-6"] = anthropic(5.00, 25.00),
  ["claude-opus-4-5"] = anthropic(5.00, 25.00),
  ["claude-opus-4-1"] = anthropic(15.00, 75.00),
  ["claude-opus-4"] = anthropic(15.00, 75.00),
  ["claude-sonnet-5"] = anthropic(2.00, 10.00),
  ["claude-sonnet-4-6"] = anthropic(3.00, 15.00),
  ["claude-sonnet-4-5"] = anthropic(3.00, 15.00),
  ["claude-sonnet-4"] = anthropic(3.00, 15.00),
  ["claude-3-7-sonnet"] = anthropic(3.00, 15.00),
  ["claude-3-5-sonnet"] = anthropic(3.00, 15.00),
  ["claude-haiku-4-5"] = anthropic(1.00, 5.00),
  ["claude-3-5-haiku"] = anthropic(0.80, 4.00),

  -- ── OpenAI (Codex) ────────────────────────────────────────────────────────
  -- Approximate: Codex runs on a subscription, so these are informational.
  -- Models absent here show token counts without a dollar figure.
  ["gpt-5-codex"] = openai(1.25, 0.125, 10.00),
  ["gpt-5-mini"] = openai(0.25, 0.025, 2.00),
  ["gpt-5-nano"] = openai(0.05, 0.005, 0.40),
  ["gpt-5"] = openai(1.25, 0.125, 10.00),
}

-- Resolve a model id to a price table. A key matches the id exactly, or with a
-- dated/versioned snapshot suffix ("claude-sonnet-4-5-20250929",
-- "claude-opus-4-5@20251101") — but never as a loose prefix: "gpt-5" must not
-- silently price "gpt-5.6-sol", whose real rate we don't know. An unpriced model
-- is not an error; the widget reports its tokens and omits it from the dollar
-- total.
function pricing.lookup(model)
  if not model or model == "" or model == "<synthetic>" then
    return nil
  end
  local best, best_len = nil, -1
  for prefix, prices in pairs(pricing.models) do
    if #prefix > best_len and model:sub(1, #prefix) == prefix then
      local suffix = model:sub(#prefix + 1)
      if suffix == "" or suffix:match("^%-%d%d%d%d%d%d%d%d$") or suffix:match("^@%d+$") then
        best, best_len = prices, #prefix
      end
    end
  end
  return best
end

-- Dollar cost of one usage record. `counts` uses the field names produced by
-- lib/ai/cost.lua. Returns 0 for a model with no known price.
function pricing.cost(model, counts)
  local p = pricing.lookup(model)
  if not p then
    return 0, false
  end
  local dollars = (counts.input or 0) * p.input
    + (counts.output or 0) * p.output
    + (counts.cache_write_5m or 0) * p.cache_write_5m
    + (counts.cache_write_1h or 0) * p.cache_write_1h
    + (counts.cache_read or 0) * p.cache_read
  return dollars / 1e6, true
end

return pricing
