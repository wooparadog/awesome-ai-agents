#! /usr/bin/env lua

-- Live Claude Code / Codex session tracking, driven entirely by agent hooks.
--
-- hook.sh drops each hook payload into $XDG_RUNTIME_DIR/ai-agents as a file named
-- "<agent>.<Event>.<pid>.<nanos>.json". A Gio directory monitor wakes this module
-- when one lands, so reacting to a running agent costs nothing between events.
--
-- Hooks cannot be trusted for liveness — a kill -9'd agent never fires SessionEnd
-- — so every read of the session list first reaps entries whose pid has left
-- /proc.
--
-- An agent that has not run a turn yet has fired no hook and is therefore not
-- tracked: Codex in particular creates its session, and its rollout file, only
-- when the first prompt is submitted.

local lgi = require("lgi")
local Gio = lgi.Gio
local gears = require("gears")
-- Sibling modules are resolved relative to wherever this library was installed,
-- so it works at lib/ai, at the top level, or anywhere else on package.path.
local base = (...):match("(.-)[^%.]+$")
local json = require(base .. "dkjson")
local util = require(base .. "util")
local cost = require(base .. "cost")

local sessions = {}

-- Overridable via sessions.configure(); must match what hook.sh writes to.
local EVENT_DIR = (os.getenv("XDG_RUNTIME_DIR") or "/tmp") .. "/ai-agents"
-- A half-written payload whose CLI died before the rename; nothing will finish
-- it, so sweep it away once it is clearly stale.
local TMP_GRACE = 60

local live = {}
local subscribers = {}
local monitor, debounce
local watches = {}
local recent = {}

-- ── State machine ────────────────────────────────────────────────────────────
--
--   busy    the agent is working
--   asking  it is blocked on you (a permission prompt or a question)
--   done    it finished its turn and is waiting for your next prompt
--   idle    session open, nothing said yet

local function emit()
  for _, cb in ipairs(subscribers) do
    cb()
  end
end

local function transcript_of(s)
  if not s.transcript and s.agent == "codex" then
    s.transcript = cost.find_codex_transcript(s.id)
  end
  return s.transcript
end

-- While a session is blocked on you, nothing else will report that you answered.
-- Watching its transcript covers that: the agent writes again the moment it is
-- unblocked (tool result, or the next assistant message), so the "?" badge
-- clears itself instead of sticking until the turn ends.
local function unwatch(key)
  if watches[key] then
    pcall(function()
      watches[key]:cancel()
    end)
    watches[key] = nil
  end
end

local function watch_transcript(key)
  unwatch(key)
  local s = live[key]
  local path = s and transcript_of(s)
  if not path then
    return
  end
  local ok, m = pcall(function()
    return Gio.File.new_for_path(path):monitor_file(Gio.FileMonitorFlags.NONE, nil)
  end)
  if not ok or not m then
    return
  end
  watches[key] = m
  m.on_changed = function()
    local current = live[key]
    if current and current.state == "asking" then
      current.state = "busy"
      current.updated = os.time()
      unwatch(key)
      emit()
    end
  end
end

-- One CLI process runs one session at a time, so a new session on a pid retires
-- whatever was there before (`/clear` and `/resume` both land here). Without
-- this, superseded sessions linger for as long as the process lives and the
-- count creeps upward.
local function retire_others(pid, keep)
  if not pid or pid == 0 then
    return
  end
  for key, s in pairs(live) do
    if key ~= keep and s.pid == pid then
      unwatch(key)
      live[key] = nil
    end
  end
end

local function log(agent, event, pid, id)
  recent[#recent + 1] = { at = os.time(), agent = agent, event = event, pid = pid, id = id }
  if #recent > 64 then
    table.remove(recent, 1)
  end
end

local function apply(agent, event, pid, payload)
  local id = payload.session_id or payload.sessionId
  if not id then
    return false
  end

  local key = agent .. "/" .. id
  local s = live[key]
  local fresh = not s
  if fresh then
    s = { agent = agent, id = id, state = "idle", started = os.time() }
    live[key] = s
  end
  if pid and pid > 0 then
    s.pid = pid
  end
  if fresh then
    retire_others(s.pid, key)
  end
  s.cwd = payload.cwd or s.cwd
  s.transcript = payload.transcript_path or s.transcript
  s.model = payload.model or s.model
  s.updated = os.time()

  -- Claude Code spells events "SessionStart", Codex spells them "session-start".
  local e = event:lower():gsub("[-_]", "")
  log(agent, e, s.pid, id)

  if e == "sessionend" then
    unwatch(key)
    live[key] = nil
    cost.refresh(transcript_of(s), agent)
  elseif e == "sessionstart" then
    -- source is one of startup / resume / clear / compact. Compaction happens
    -- *inside* a running turn, so treating it like a fresh session would report
    -- a busy agent as idle for the rest of the turn.
    if payload.source ~= "compact" then
      s.state = "idle"
      s.started = os.time()
    end
    unwatch(key)
  elseif e == "userpromptsubmit" or e == "pretooluse" or e == "posttooluse" then
    s.state = "busy"
    unwatch(key)
  elseif e == "permissionrequest" then
    s.state = "asking"
    watch_transcript(key)
  elseif e == "notification" then
    -- Claude Code's Notification covers two situations with one event: a pending
    -- permission prompt, and "waiting for your input" after an idle minute.
    -- Anything else it might notify about leaves the state alone — guessing
    -- "done" for an unrecognised message would clear a busy agent's badge.
    local message = tostring(payload.message or ""):lower()
    if message:find("permission") or message:find("approve") or message:find("confirm") then
      s.state = "asking"
      watch_transcript(key)
    elseif message:find("waiting") or message:find("input") or message:find("idle") then
      if s.state ~= "asking" then
        s.state = "done"
      end
    end
  elseif e == "stop" then
    s.state = "done"
    unwatch(key)
    -- The turn's transcript bytes are on disk now: fold them into today's
    -- totals while they are a few KB, so hovering the widget stays instant.
    cost.refresh(transcript_of(s), agent)
  end

  return true
end

-- ── Event directory ──────────────────────────────────────────────────────────

local function drain()
  local files = util.list_dir(EVENT_DIR)
  local events, now = {}, os.time()

  for _, f in ipairs(files) do
    local agent, event, pid, nanos = f.name:match("^([%w_%-]+)%.([%w_%-]+)%.(%d+)%.(%d+)%.json$")
    if agent then
      events[#events + 1] = {
        path = f.path,
        agent = agent,
        event = event,
        pid = tonumber(pid),
        nanos = tonumber(nanos) or 0,
      }
    elseif f.name:match("%.tmp$") and f.mtime < now - TMP_GRACE then
      os.remove(f.path)
    end
  end

  -- Hooks fire faster than the monitor delivers, so order by the timestamp in
  -- the name rather than by whatever order the directory listing came back in.
  table.sort(events, function(a, b)
    return a.nanos < b.nanos
  end)

  local changed = false
  for _, ev in ipairs(events) do
    local raw = util.read_file(ev.path)
    os.remove(ev.path)
    if raw then
      local ok, payload = pcall(json.decode, raw)
      if ok and type(payload) == "table" and apply(ev.agent, ev.event, ev.pid, payload) then
        changed = true
      end
    end
  end
  return changed
end

-- ── Liveness ─────────────────────────────────────────────────────────────────

-- A recorded pid of 0 means the hook could not identify the CLI process; those
-- sessions are kept until SessionEnd rather than reaped on a guess.
local function alive(s)
  if not s.pid or s.pid == 0 then
    return true
  end
  local comm = util.proc_comm(s.pid)
  if not comm then
    return false
  end
  -- Guard against pid reuse: the pid must still belong to an agent process.
  return comm:match("^claude") ~= nil or comm:match("^codex") ~= nil
end

function sessions.reap()
  local changed = false
  for key, s in pairs(live) do
    if not alive(s) then
      unwatch(key)
      live[key] = nil
      changed = true
    end
  end
  return changed
end

-- ── Public API ───────────────────────────────────────────────────────────────

function sessions.configure(opts)
  EVENT_DIR = (opts or {}).event_dir or EVENT_DIR
end

-- Consume any pending hook payloads without waiting for the directory monitor.
-- Used by the widget's rescan binding, and by tests that run outside a GLib main
-- loop.
function sessions.refresh()
  return drain()
end

-- Most recent events applied, oldest first — for debugging what an agent
-- actually reported.
function sessions.log()
  return recent
end

function sessions.subscribe(cb)
  subscribers[#subscribers + 1] = cb
end

-- Reaped, sorted view of what is running right now.
function sessions.snapshot()
  sessions.reap()

  local snap = {
    total = 0,
    asking = 0,
    done = 0,
    busy = 0,
    agents = {},
    order = {},
  }

  for _, s in pairs(live) do
    transcript_of(s)
    snap.total = snap.total + 1
    if s.state == "asking" then
      snap.asking = snap.asking + 1
    elseif s.state == "done" then
      snap.done = snap.done + 1
    elseif s.state == "busy" then
      snap.busy = snap.busy + 1
    end

    local group = snap.agents[s.agent]
    if not group then
      group = {}
      snap.agents[s.agent] = group
      snap.order[#snap.order + 1] = s.agent
    end
    group[#group + 1] = s
  end

  table.sort(snap.order)
  local rank = { asking = 1, busy = 2, done = 3, idle = 4 }
  for _, group in pairs(snap.agents) do
    table.sort(group, function(a, b)
      if a.state ~= b.state then
        return (rank[a.state] or 9) < (rank[b.state] or 9)
      end
      return (a.updated or 0) > (b.updated or 0)
    end)
  end

  return snap
end

function sessions.start()
  util.mkdir_p(EVENT_DIR)
  drain()

  -- Coalesce the burst a single turn produces (Stop plus its neighbours land
  -- within milliseconds of each other) into one widget update.
  debounce = gears.timer({
    timeout = 0.05,
    single_shot = true,
    callback = function()
      if drain() then
        emit()
      end
    end,
  })

  local ok, m = pcall(function()
    return Gio.File.new_for_path(EVENT_DIR):monitor_directory(Gio.FileMonitorFlags.NONE, nil)
  end)
  if ok and m then
    -- Kept on the module table so the GC cannot collect the monitor out from
    -- under the signal handler.
    monitor = m
    sessions._monitor = m
    m.on_changed = function()
      debounce:again()
    end
  end

  return sessions
end

return sessions
