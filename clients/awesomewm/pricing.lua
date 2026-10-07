#! /usr/bin/env lua
-- Standard API token estimates for legacy local daily aggregates.
-- Per-request context, speed and billing modifiers are handled by the collector.
local base = (...):match("(.-)[^%.]+$")
local data = require(base .. "pricing_data")
local pricing = { models = data.models }

-- Resolve a model id to a price table. A key matches the id exactly, or with a
-- dated/versioned snapshot suffix ("claude-sonnet-4-5-20250929",
-- "claude-opus-4-5@20251101") — but never as a loose prefix: "gpt-5" must not
-- silently price an unknown future family variant. An unpriced model
-- is not an error; the widget reports its tokens and omits it from the dollar
-- total.
function pricing.lookup(model)
  if not model or model == "" or model == "<synthetic>" then
    return nil
  end
  model = data.aliases[model] or model
  local best, best_len = nil, -1
  for prefix, prices in pairs(pricing.models) do
    if #prefix > best_len and model:sub(1, #prefix) == prefix then
      local suffix = model:sub(#prefix + 1)
      if
        suffix == ""
        or suffix:match("^%-%d%d%d%d%d%d%d%d$")
        or suffix:match("^%-%d%d%d%d%-%d%d%-%d%d$")
        or suffix:match("^@%d+$")
      then
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
  local dollars, known = 0, true
  for _, metric in ipairs({ "input", "output", "cache_read", "cache_write_5m", "cache_write_1h" }) do
    local count = counts[metric] or 0
    if count > 0 and p[metric] == nil then
      known = false
    else
      dollars = dollars + count * (p[metric] or 0)
    end
  end
  return dollars / 1e6, known
end

return pricing
