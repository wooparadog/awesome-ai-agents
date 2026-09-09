#! /usr/bin/env lua

-- Wibar indicator for running Claude Code / Codex sessions.
--
--   require("lib.ai.clients.awesomewm")({ settings = function(state, widget) ... end })
--
-- The widget reports how many agent sessions are alive, how many are blocked on
-- a decision, and how many finished a turn and are waiting for the next prompt.
-- Hovering shows today's per-agent token and dollar totals; right-clicking
-- forces a rescan.
--
-- Arguments (all optional):
--   settings(state, widget)  render callback; `state` carries total/busy/asking/
--                            done, `state.agents` grouped sessions, `state.cost`
--   widget                   textbox to drive (one is created otherwise)
--   colors                   { asking, done, dim } used in the popup
--   notification_preset      naughty preset for the hover popup
--   claude_projects          default ~/.claude/projects
--   codex_sessions           default ~/.codex/sessions
--   cache_path               default $XDG_CACHE_HOME/awesome/ai-agents.json
--   event_dir                default $XDG_RUNTIME_DIR/ai-agents (match hook.sh)
--
-- Everything is event-driven (see sessions.lua): no timer runs, so an idle
-- desktop with idle agents costs no CPU at all.
--
-- The returned handle exposes `widget`, `state`, `update()`, `show_popup()` and
-- `hide_popup()`.

local wibox = require("wibox")
local awful = require("awful")
local naughty = require("naughty")
local gears = require("gears")

-- Sibling modules are resolved relative to wherever this library was installed,
-- so it works at lib/ai, at the top level, or anywhere else on package.path.
local base = (...):gsub("%.init$", "") .. "."
local cost = require(base .. "cost")
local sessions = require(base .. "sessions")

local AGENT_LABEL = { claude = "claude code", codex = "codex" }
local STATE_LABEL = { asking = "needs you", busy = "working", done = "done", idle = "idle" }
-- Directory names that say nothing on their own, so the parent comes along.
local GENERIC_DIR = {
  master = true,
  main = true,
  dev = true,
  develop = true,
  trunk = true,
  src = true,
  ["-repo"] = true,
}

local function fmt_tokens(n)
  n = n or 0
  if n >= 1e6 then
    return string.format("%.1fM", n / 1e6)
  elseif n >= 1e3 then
    return string.format("%.0fk", n / 1e3)
  end
  return string.format("%d", n)
end

local function fmt_dollars(agg)
  if agg and agg.available == false then
    return "usage n/a"
  end
  if not agg or agg.dollars == 0 then
    return agg and not agg.priced and "cost n/a" or "$0.00"
  end
  return string.format("$%.2f%s", agg.dollars, agg.priced and "" or "+")
end

local function project_label(cwd)
  if not cwd or cwd == "" then
    return "?"
  end
  local parts = {}
  for part in cwd:gmatch("[^/]+") do
    parts[#parts + 1] = part
  end
  local last = parts[#parts]
  if not last then
    return "/"
  end
  -- A bare "master" or ".repo" says nothing about which project it belongs to,
  -- so keep the parent for those.
  if (GENERIC_DIR[last] or last:sub(1, 1) == ".") and parts[#parts - 1] then
    return parts[#parts - 1] .. "/" .. last
  end
  return last
end

-- Claude Code's configured model can carry a variant suffix ("claude-opus-5[1m]")
-- that transcripts never record. Strip it so the fallback and the transcript
-- render the same id instead of the column changing after the first turn.
local function base_model(id)
  return id and (id:gsub("%b[]", "")) or nil
end

local function escape(text)
  return tostring(text or ""):gsub("&", "&amp;"):gsub("<", "&lt;"):gsub(">", "&gt;")
end

-- ── Popup ────────────────────────────────────────────────────────────────────

local function popup_text(colors, snap)
  local totals = snap.cost
  local marker = {
    asking = string.format("<span foreground='%s'>?</span>", colors.asking),
    done = string.format("<span foreground='%s'>✓</span>", colors.done),
    busy = "●",
    idle = "·",
  }

  local lines, grand, priced = {}, 0, true
  local order, seen = {}, {}
  for _, agent in ipairs(snap.order) do
    order[#order + 1] = agent
    seen[agent] = true
  end
  for agent, agg in pairs(totals) do
    if type(agg) == "table" and not seen[agent] and (agg.tokens or 0) > 0 then
      order[#order + 1] = agent
    end
  end

  for _, agent in ipairs(order) do
    local group = snap.agents[agent] or {}
    local agg = totals[agent] or { tokens = 0, dollars = 0, priced = true }

    if #lines > 0 then
      lines[#lines + 1] = ""
    end
    lines[#lines + 1] = string.format(
      "<b>%s</b>  <span foreground='%s'>%d session%s</span>",
      escape(AGENT_LABEL[agent] or agent),
      colors.dim,
      #group,
      #group == 1 and "" or "s"
    )

    for _, s in ipairs(group) do
      local usage = s.usage or cost.for_transcript(s.transcript)
      -- The transcript wins. A hook payload's `model` is the model the session
      -- *started* with and never changes, so a session that switched keeps
      -- reporting the old one for the rest of its life; the transcript records
      -- what each turn actually ran. The payload is only a fallback, for a
      -- session that has not completed a turn yet.
      lines[#lines + 1] = string.format(
        " %s %-20s %-10s %-17s %6s",
        marker[s.state] or "·",
        escape((s.machine and s.machine .. " / " or "") .. project_label(s.cwd)),
        s.freshness and s.freshness ~= "live" and s.freshness or STATE_LABEL[s.state] or s.state,
        escape(usage.model or base_model(s.model) or "?"),
        usage.available == false and "n/a" or fmt_tokens(usage.tokens)
      )
    end

    local extra = ""
    if agent == "codex" and totals.codex.rate_limit then
      extra = string.format(" · weekly limit %d%%", math.floor(totals.codex.rate_limit + 0.5))
    end
    lines[#lines + 1] = string.format(
      "<span foreground='%s'>   today  %s tokens · %s%s</span>",
      colors.dim,
      fmt_tokens(agg.tokens),
      fmt_dollars(agg),
      extra
    )

    grand = grand + agg.dollars
    priced = priced and agg.priced
  end

  if #lines == 0 then
    lines[#lines + 1] = string.format("<span foreground='%s'>no agents running</span>", colors.dim)
    for agent, agg in pairs(totals) do
      if type(agg) == "table" and (agg.tokens or 0) > 0 then
        lines[#lines + 1] = string.format(
          "%-12s today  %s tokens · %s",
          escape(AGENT_LABEL[agent] or agent),
          fmt_tokens(agg.tokens),
          fmt_dollars(agg)
        )
        grand = grand + agg.dollars
        priced = priced and agg.priced
      end
    end
  end

  if grand > 0 then
    lines[#lines + 1] = ""
    lines[#lines + 1] = string.format("<b>total today  $%.2f%s</b>", grand, priced and "" or "+")
  end
  if totals.scanning then
    lines[#lines + 1] = string.format("<span foreground='%s'>(still reading today's transcripts…)</span>", colors.dim)
  end
  if snap.connection and snap.connection ~= "connected" then
    lines[#lines + 1] = "collector: " .. escape(snap.connection)
  end
  if snap.usage_complete == false then
    lines[#lines + 1] = "usage coverage incomplete"
  end

  return table.concat(lines, "\n")
end

-- ── Factory ──────────────────────────────────────────────────────────────────

local function factory(args)
  args = args or {}
  local tracker = args.cloud and require(base .. "cloud")(args.cloud) or sessions

  local ai = { widget = args.widget or wibox.widget.textbox() }
  local settings = args.settings or function() end
  local colors = gears.table.crush({
    asking = "#C83F11",
    done = "#7BC043",
    dim = "#9A9A9A",
  }, args.colors or {})

  local popup

  function ai.update()
    local snap = tracker.snapshot()
    snap.cost = snap.cost or cost.totals()
    ai.state = snap
    settings(snap, ai.widget)
    if popup then
      -- naughty.widget.message tracks the notification's `message` property, so
      -- the open popup refreshes in place instead of flickering.
      pcall(function()
        popup.message = popup_text(colors, snap)
      end)
    end
  end

  function ai.show_popup()
    if popup then
      return
    end
    popup = naughty.notify({
      title = "AI agents",
      message = popup_text(colors, ai.state),
      timeout = 0,
      screen = awful.screen.focused(),
      preset = args.notification_preset,
      destroy = function()
        popup = nil
      end,
    })
  end

  function ai.hide_popup()
    if popup then
      pcall(function()
        popup:destroy()
      end)
      popup = nil
    end
  end

  ai.widget:connect_signal("mouse::enter", function()
    -- Pick up anything the directory monitor has not delivered yet.
    tracker.refresh()
    ai.update()
    ai.show_popup()
  end)
  ai.widget:connect_signal("mouse::leave", function()
    ai.hide_popup()
  end)
  ai.widget:buttons(gears.table.join(awful.button({}, 3, function()
    -- Escape hatch: re-read every transcript touched today, in case a hook was
    -- ever missed.
    if not args.cloud then
      cost.discover()
    end
    tracker.refresh()
    ai.update()
  end)))

  tracker.subscribe(ai.update)
  if not args.cloud then
    cost.subscribe(ai.update)
    cost.configure(args)
    sessions.configure(args)
    cost.init()
  end
  tracker.start()
  ai.update()
  function ai.stop()
    ai.hide_popup()
    if tracker.stop then
      tracker.stop()
    end
  end

  return ai
end

return factory
