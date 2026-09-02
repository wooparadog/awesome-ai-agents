#! /usr/bin/env lua

local source = debug.getinfo(1, "S").source:gsub("^@", "")
local ai_dir = source:match("^(.*)/tests/run%.lua$") or "."
if ai_dir == "" then
  ai_dir = "."
end
package.path = ai_dir .. "/../?.lua;" .. ai_dir .. "/../?/init.lua;" .. package.path

local passed = 0
local function test(name, fn)
  local ok, err = pcall(fn)
  if not ok then
    io.stderr:write("not ok - " .. name .. "\n" .. tostring(err) .. "\n")
    os.exit(1)
  end
  passed = passed + 1
  print("ok - " .. name)
end

local function near(actual, expected)
  assert(math.abs(actual - expected) < 1e-12, string.format("expected %.12f, got %.12f", expected, actual))
end

test("prices GPT-5.6 Sol input, cache reads, cache writes, and output", function()
  local pricing = require("ai.pricing")
  local dollars, known = pricing.cost("gpt-5.6-sol", {
    input = 500,
    cache_read = 400,
    cache_write_5m = 100,
    output = 50,
  })
  assert(known)
  near(dollars, 0.00366)

  local alias_dollars, alias_known = pricing.cost("gpt-5.6", { input = 1e6 })
  assert(alias_known)
  near(alias_dollars, 4.00)
end)

test("separates Codex cache writes from ordinary input", function()
  package.loaded.lgi = {
    GLib = {
      PRIORITY_LOW = 0,
      get_user_cache_dir = function()
        return "/tmp"
      end,
      idle_add = function()
        return 0
      end,
    },
  }
  package.loaded.gears = {
    timer = function()
      return { again = function() end }
    end,
  }
  package.loaded["ai.util"] = {
    list_dir = function()
      return {}
    end,
    mkdir_p = function() end,
  }
  package.loaded["ai.cost"] = nil

  local cost = require("ai.cost")
  local transcript = os.tmpname()
  local fh = assert(io.open(transcript, "w"))
  local stamp = os.date("!%Y-%m-%dT%H:%M:%SZ")
  fh:write('{"timestamp":"', stamp, '","type":"turn_context","model":"gpt-5.6-sol"}\n')
  fh:write(
    '{"timestamp":"',
    stamp,
    '","type":"token_count","total_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"cache_write_input_tokens":100,"output_tokens":50}}\n'
  )
  fh:close()

  assert(cost.digest_sync(transcript, "codex"))
  local usage = cost.for_transcript(transcript)
  os.remove(transcript)

  assert(usage.tokens == 1050, "cache categories must not inflate the token total")
  assert(usage.priced)
  near(usage.dollars, 0.00366)
end)

test("shows today's totals for inactive agent types", function()
  local current_snapshot = {
    total = 1,
    order = { "claude" },
    agents = {
      claude = {
        { state = "busy", cwd = "/tmp/project", model = "claude-sonnet-4", transcript = "claude.jsonl" },
      },
    },
  }
  local totals = {
    claude = { tokens = 2000, dollars = 2, priced = true },
    codex = { tokens = 1000, dollars = 1, priced = true },
    scanning = false,
  }
  local notice_args
  local widget = {
    connect_signal = function() end,
    buttons = function() end,
  }

  package.loaded.wibox = { widget = { textbox = function()
    return widget
  end } }
  package.loaded.awful = {
    button = function()
      return {}
    end,
    screen = { focused = function()
      return 1
    end },
  }
  package.loaded.naughty = {
    notify = function(args)
      notice_args = args
      return { destroy = function() end }
    end,
  }
  package.loaded.gears = {
    table = {
      crush = function(defaults, overrides)
        for key, value in pairs(overrides) do
          defaults[key] = value
        end
        return defaults
      end,
      join = function(...)
        return { ... }
      end,
    },
  }
  package.loaded["ai.cost"] = {
    totals = function()
      return totals
    end,
    for_transcript = function()
      return { tokens = 2000, dollars = 2, priced = true, model = "claude-sonnet-4" }
    end,
    subscribe = function() end,
    configure = function() end,
    init = function() end,
    discover = function() end,
  }
  package.loaded["ai.sessions"] = {
    snapshot = function()
      return current_snapshot
    end,
    subscribe = function() end,
    configure = function() end,
    start = function() end,
    refresh = function() end,
  }
  package.loaded["ai.init"] = nil

  local ai = require("ai.init")({ widget = widget })
  ai.show_popup()
  assert(notice_args.message:find("<b>codex</b>", 1, true), "inactive Codex subtotal is missing")
  assert(notice_args.message:find("total today  $3.00", 1, true), "inactive Codex cost is missing from grand total")

  ai.hide_popup()
  current_snapshot = { total = 0, order = {}, agents = {} }
  ai.show_popup()
  assert(notice_args.message:find("<b>claude code</b>", 1, true), "inactive Claude subtotal is missing")
  assert(notice_args.message:find("<b>codex</b>", 1, true), "inactive Codex subtotal is missing")
  assert(notice_args.message:find("total today  $3.00", 1, true), "all-inactive grand total is missing")
end)

print(string.format("%d tests passed", passed))
