#! /usr/bin/env lua

-- Wibar indicator for running Claude Code / Codex sessions.
--
--   require("lib.ai")({ settings = function(state, widget) ... end })
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

local function escape(text)
  return tostring(text or ""):gsub("&", "&amp;"):gsub("<", "&lt;"):gsub(">", "&gt;")
end

-- ── Popup ────────────────────────────────────────────────────────────────────

local function popup_text(colors)
  local snap = sessions.snapshot()
  local totals = cost.totals()
  local marker = {
    asking = string.format("<span foreground='%s'>?</span>", colors.asking),
    done = string.format("<span foreground='%s'>✓</span>", colors.done),
    busy = "●",
    idle = "·",
  }

  local lines, grand, priced = {}, 0, true

  for _, agent in ipairs(snap.order) do
    local group = snap.agents[agent]
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
      local usage = cost.for_transcript(s.transcript)
      -- The session's own report wins: hook payloads carry the model it is
      -- configured with *now*, so switching models shows up on the session's next
      -- event. The transcript only names the new model once a turn has completed
      -- under it, which lags a switch by a whole turn.
      lines[#lines + 1] = string.format(
        " %s %-20s %-10s %-17s %6s",
        marker[s.state] or "·",
        escape(project_label(s.cwd)),
        STATE_LABEL[s.state] or s.state,
        escape(s.model or usage.model or "?"),
        fmt_tokens(usage.tokens)
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
    for _, agent in ipairs({ "claude", "codex" }) do
      local agg = totals[agent]
      if agg and agg.tokens > 0 then
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

  return table.concat(lines, "\n")
end

-- ── Factory ──────────────────────────────────────────────────────────────────

local function factory(args)
  args = args or {}

  local ai = { widget = args.widget or wibox.widget.textbox() }
  local settings = args.settings or function() end
  local colors = gears.table.crush({
    asking = "#C83F11",
    done = "#7BC043",
    dim = "#9A9A9A",
  }, args.colors or {})

  local popup
  local cycle = 0

  function ai.update()
    local snap = sessions.snapshot()
    snap.cost = cost.totals()
    ai.state = snap
    settings(snap, ai.widget)
    if popup then
      -- naughty.widget.message tracks the notification's `message` property, so
      -- the open popup refreshes in place instead of flickering.
      pcall(function()
        popup.message = popup_text(colors)
      end)
    end
  end

  function ai.show_popup()
    if popup then
      return
    end
    popup = naughty.notify({
      title = "AI agents",
      message = popup_text(colors),
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
    sessions.refresh()
    ai.update()
    ai.show_popup()
  end)
  ai.widget:connect_signal("mouse::leave", function()
    ai.hide_popup()
  end)
  ai.widget:buttons(gears.table.join(awful.button({}, 3, function()
    -- Escape hatch: re-read every transcript touched today, in case a hook was
    -- ever missed.
    cost.discover()
    sessions.refresh()
    ai.update()
  end)))

  sessions.subscribe(ai.update)
  cost.subscribe(ai.update)

  cost.configure(args)
  sessions.configure(args)
  cost.init()
  sessions.start()
  ai.update()

  return ai
end

return factory
