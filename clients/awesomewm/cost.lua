#! /usr/bin/env lua

-- Token/cost accounting for Claude Code and Codex transcripts.
--
-- Transcripts are append-only JSONL, which is what makes this cheap: every file
-- carries a byte offset in a persisted cache, so a refresh only parses the bytes
-- appended since last time — a few KB per finished turn. Nothing polls; the
-- session tracker calls cost.refresh() when an agent reports it stopped.
--
-- The one expensive moment is the cold start (~7MB for a busy day). It runs on
-- GLib's idle queue in bounded chunks so AwesomeWM's single main loop never
-- stalls; the popup shows whatever has been digested so far.
--
-- Lines are scraped with Lua patterns rather than decoded as JSON: a full dkjson
-- decode of a day's transcripts costs seconds, while the fields we need (usage
-- counters, model, timestamp) are unambiguous enough to match directly.

local lgi = require("lgi")
local GLib = lgi.GLib
local gears = require("gears")
-- Sibling modules are resolved relative to wherever this library was installed,
-- so it works at lib/ai, at the top level, or anywhere else on package.path.
local base = (...):match("(.-)[^%.]+$")
local pricing = require(base .. "pricing")
local util = require(base .. "util")
local json = require(base .. "dkjson")

local cost = {}

local HOME = os.getenv("HOME")

-- Overridable via cost.configure(), for a non-standard CODEX_HOME/CLAUDE_CONFIG_DIR.
local CLAUDE_PROJECTS = HOME .. "/.claude/projects"
local CODEX_SESSIONS = HOME .. "/.codex/sessions"
local CACHE_PATH = GLib.get_user_cache_dir() .. "/awesome/ai-agents.json"

-- Transcript bytes parsed per idle callback. 512K of pattern matching lands well
-- under a frame; the scan resumes on the next idle tick.
local CHUNK_BYTES = 512 * 1024
local KEEP_DAYS = 3
local FORGET_AFTER = 7 * 86400

local state = { files = {} }
local subscribers = {}
local queue, scanning = {}, false
local save_timer

-- Assistant messages are deduplicated across *all* transcripts, not per file: a
-- forked or resumed session copies its parent's history into a new file, which
-- would otherwise count the same turn twice (~10% high on a day with forks).
-- Keyed by day so the set resets itself and cannot grow without bound.
local seen = { day = nil, keys = {} }

local function first_sighting(day, key)
  if seen.day ~= day then
    seen.day, seen.keys = day, {}
  end
  if seen.keys[key] then
    return false
  end
  seen.keys[key] = true
  return true
end

-- ── Time helpers ─────────────────────────────────────────────────────────────

local function day_key(when)
  return os.date("%Y-%m-%d", when)
end

local function midnight(when)
  local t = os.date("*t", when or os.time())
  t.hour, t.min, t.sec, t.isdst = 0, 0, 0, nil
  return os.time(t)
end

-- Start of the local day as the UTC ISO-8601 that transcripts write, so day
-- membership is a plain string comparison against each line's timestamp.
local function day_start_iso()
  return os.date("!%Y-%m-%dT%H:%M:%S", midnight())
end

-- ── Bookkeeping helpers ──────────────────────────────────────────────────────

local COUNTERS = { "input", "output", "cache_read", "cache_write_5m", "cache_write_1h" }

local function add_counts(dst, src)
  for _, k in ipairs(COUNTERS) do
    dst[k] = (dst[k] or 0) + (src[k] or 0)
  end
  return dst
end

local function total_tokens(counts)
  local n = 0
  for _, k in ipairs(COUNTERS) do
    n = n + (counts[k] or 0)
  end
  return n
end

local function notify()
  for _, cb in ipairs(subscribers) do
    cb()
  end
end

local function schedule_save()
  if not save_timer then
    save_timer = gears.timer({
      timeout = 5,
      single_shot = true,
      callback = function()
        cost.save()
      end,
    })
  end
  save_timer:again()
end

local function file_entry(path, agent)
  local e = state.files[path]
  if not e then
    e = { agent = agent, offset = 0, days = {} }
    state.files[path] = e
  end
  e.agent = e.agent or agent
  e.days = e.days or {}
  e.seen_at = os.time()
  return e
end

local function day_bucket(entry, day)
  entry.days[day] = entry.days[day] or { models = {} }
  entry.days[day].models = entry.days[day].models or {}
  return entry.days[day]
end

-- ── Line parsers ─────────────────────────────────────────────────────────────

local function digest_claude_line(entry, line, today, today_iso)
  if not line:find('"type":"assistant"', 1, true) then
    return
  end
  local ts = line:match('"timestamp":"([^"]+)"')
  if not ts or ts < today_iso then
    return
  end
  local usage = line:match('"usage":(%b{})')
  if not usage then
    return
  end
  local model = line:match('"model":"([^"]+)"')
  if not model or model == "<synthetic>" then
    return
  end

  -- The same assistant message gets written more than once (sidechain replay,
  -- fork/resume), so drop repeats by message id the way ccusage does.
  local key = line:match('"id":"(msg_[^"]+)"')
  if key and not first_sighting(today, key .. "|" .. (line:match('"requestId":"([^"]+)"') or "")) then
    return
  end

  -- usage.iterations repeats every counter per API round-trip; strip it so the
  -- patterns below cannot pick up a nested copy.
  usage = usage:gsub('"iterations":%b[]', "")

  local counts = {
    input = tonumber(usage:match('"input_tokens":(%d+)')) or 0,
    output = tonumber(usage:match('"output_tokens":(%d+)')) or 0,
    cache_read = tonumber(usage:match('"cache_read_input_tokens":(%d+)')) or 0,
    cache_write_5m = tonumber(usage:match('"ephemeral_5m_input_tokens":(%d+)')) or 0,
    cache_write_1h = tonumber(usage:match('"ephemeral_1h_input_tokens":(%d+)')) or 0,
  }
  if counts.cache_write_5m == 0 and counts.cache_write_1h == 0 then
    counts.cache_write_5m = tonumber(usage:match('"cache_creation_input_tokens":(%d+)')) or 0
  end

  local bucket = day_bucket(entry, today)
  bucket.models[model] = add_counts(bucket.models[model] or {}, counts)
  entry.model = model
end

-- Codex logs *cumulative* totals per turn, so a day costs the difference between
-- its last snapshot and the last snapshot taken before the day began.
local function digest_codex_line(entry, line, today, today_iso)
  if line:find('"type":"session_meta"', 1, true) then
    entry.cwd = line:match('"cwd":"([^"]+)"') or entry.cwd
    entry.session_id = line:match('"session_id":"([^"]+)"') or entry.session_id
    return
  end
  if line:find('"type":"turn_context"', 1, true) then
    entry.model = line:match('"model":"([^"]+)"') or entry.model
    entry.cwd = line:match('"cwd":"([^"]+)"') or entry.cwd
    return
  end
  if not line:find('"type":"token_count"', 1, true) then
    return
  end

  local info = line:match('"total_token_usage":(%b{})')
  if not info then
    return
  end
  local snapshot = {
    input = tonumber(info:match('"input_tokens":(%d+)')) or 0,
    cached = tonumber(info:match('"cached_input_tokens":(%d+)')) or 0,
    output = tonumber(info:match('"output_tokens":(%d+)')) or 0,
  }
  local used = tonumber(line:match('"used_percent":([%d%.]+)'))
  local stamp = line:match('"timestamp":"([^"]+)"')
  if used then
    entry.rate_limit, entry.rate_limit_ts = used, stamp
  end

  local ts = line:match('"timestamp":"([^"]+)"')
  if not ts or ts < today_iso then
    entry.cumulative = snapshot -- baseline for whichever day comes next
    return
  end

  local bucket = day_bucket(entry, today)
  bucket.codex = bucket.codex or { base = entry.cumulative or { input = 0, cached = 0, output = 0 } }
  bucket.codex.last = snapshot
  entry.cumulative = snapshot
end

-- Cumulative snapshots → the same counter names the Anthropic side uses.
-- OpenAI's input_tokens includes the cached portion, so bill the difference.
local function codex_counts(cx)
  if not cx or not cx.last then
    return nil
  end
  local base = cx.base or {}
  local input = math.max((cx.last.input or 0) - (base.input or 0), 0)
  local cached = math.max((cx.last.cached or 0) - (base.cached or 0), 0)
  local output = math.max((cx.last.output or 0) - (base.output or 0), 0)
  return { input = math.max(input - cached, 0), cache_read = cached, output = output }
end

-- ── Incremental digestion ────────────────────────────────────────────────────

-- Parse the bytes appended to `path` since the last pass, up to roughly
-- `max_bytes`. Returns true when the file is caught up.
local function digest(path, agent, max_bytes)
  local entry = file_entry(path, agent)
  local fh = io.open(path, "rb")
  if not fh then
    state.files[path] = nil
    return true
  end

  local size = fh:seek("end")
  if size <= entry.offset then
    fh:close()
    -- A transcript that shrank was rewritten; start it over.
    if size < entry.offset then
      entry.offset = 0
    end
    return true
  end

  fh:seek("set", entry.offset)
  local chunk = fh:read(max_bytes or CHUNK_BYTES) or ""
  -- Finish the line the byte cap cut in half, so a huge line can never wedge
  -- the reader at a fixed offset.
  if #chunk > 0 and chunk:sub(-1) ~= "\n" then
    chunk = chunk .. (fh:read("L") or "")
  end
  fh:close()

  -- Consume whole lines only; a partial tail (the agent is mid-write) waits.
  local complete = chunk:match("^.*\n")
  if not complete then
    return true
  end
  entry.offset = entry.offset + #complete

  local today, today_iso = day_key(), day_start_iso()
  local parse = (agent == "codex") and digest_codex_line or digest_claude_line
  for line in complete:gmatch("[^\n]+") do
    parse(entry, line, today, today_iso)
  end

  return entry.offset >= size
end

local function pump()
  local budget = CHUNK_BYTES
  while budget > 0 do
    local job = queue[1]
    if not job then
      scanning = false
      cost.prune()
      cost.save()
      notify()
      return false
    end
    local before = (state.files[job.path] or {}).offset or 0
    local done = digest(job.path, job.agent, budget)
    local after = (state.files[job.path] or {}).offset or before
    -- The floor keeps the loop terminating even for files that yield nothing.
    budget = budget - math.max(after - before, 4096)
    if done then
      table.remove(queue, 1)
    end
  end
  return true
end

local function enqueue(path, agent)
  for _, job in ipairs(queue) do
    if job.path == path then
      return
    end
  end
  queue[#queue + 1] = { path = path, agent = agent }
end

local function start_pump()
  if scanning or #queue == 0 then
    return
  end
  scanning = true
  GLib.idle_add(GLib.PRIORITY_LOW, pump)
end

-- ── Persistence ──────────────────────────────────────────────────────────────

function cost.prune()
  local keep = {}
  for i = 0, KEEP_DAYS - 1 do
    keep[day_key(os.time() - i * 86400)] = true
  end
  local now = os.time()
  for path, e in pairs(state.files) do
    for day in pairs(e.days or {}) do
      if not keep[day] then
        e.days[day] = nil
      end
    end
    -- Entries exist to remember byte offsets; drop them once the transcript is
    -- long finished or gone, so the cache cannot grow without bound.
    if (e.seen_at or 0) < now - FORGET_AFTER then
      state.files[path] = nil
    else
      local fh = io.open(path, "r")
      if fh then
        fh:close()
      else
        state.files[path] = nil
      end
    end
  end
end

function cost.load()
  local fh = io.open(CACHE_PATH, "r")
  if not fh then
    return
  end
  local raw = fh:read("a")
  fh:close()
  local ok, decoded = pcall(json.decode, raw)
  if ok and type(decoded) == "table" and type(decoded.files) == "table" then
    state.files = decoded.files
  end
  for _, e in pairs(state.files) do
    e.days = e.days or {}
  end
  cost.prune()
end

function cost.save()
  util.mkdir_p(CACHE_PATH:match("^(.*)/[^/]*$"))
  local dump = { version = 1, files = {} }
  for path, e in pairs(state.files) do
    dump.files[path] = {
      agent = e.agent,
      offset = e.offset,
      days = e.days,
      model = e.model,
      cwd = e.cwd,
      session_id = e.session_id,
      cumulative = e.cumulative,
      rate_limit = e.rate_limit,
      rate_limit_ts = e.rate_limit_ts,
      seen_at = e.seen_at,
    }
  end
  local fh = io.open(CACHE_PATH, "w")
  if not fh then
    return
  end
  fh:write(json.encode(dump))
  fh:close()
end

-- ── Public API ───────────────────────────────────────────────────────────────

function cost.configure(opts)
  opts = opts or {}
  CLAUDE_PROJECTS = opts.claude_projects or CLAUDE_PROJECTS
  CODEX_SESSIONS = opts.codex_sessions or CODEX_SESSIONS
  CACHE_PATH = opts.cache_path or CACHE_PATH
end

function cost.subscribe(cb)
  subscribers[#subscribers + 1] = cb
end

-- Queue every transcript touched since local midnight. Cheap: one Gio listing
-- per project directory, and only files that actually moved today get parsed.
function cost.discover()
  local cutoff = midnight()

  for _, project in ipairs(util.list_dir(CLAUDE_PROJECTS)) do
    if project.is_dir then
      for _, f in ipairs(util.list_dir(project.path)) do
        if not f.is_dir and f.name:match("%.jsonl$") and f.mtime >= cutoff then
          enqueue(f.path, "claude")
        end
      end
    end
  end

  -- Yesterday's directory too: a session that started before midnight keeps
  -- appending to the file it was born in.
  for _, back in ipairs({ 0, 86400 }) do
    local dir = CODEX_SESSIONS .. "/" .. os.date("%Y/%m/%d", os.time() - back)
    for _, f in ipairs(util.list_dir(dir)) do
      if not f.is_dir and f.name:match("%.jsonl$") and f.mtime >= cutoff then
        enqueue(f.path, "codex")
      end
    end
  end

  start_pump()
end

-- Parse one transcript to completion, blocking. Only for a single small file
-- (a test, or a deliberate rescan) — the widget's normal path is cost.refresh,
-- which spreads the work across idle callbacks.
function cost.digest_sync(path, agent)
  for _ = 1, 4096 do
    if digest(path, agent, CHUNK_BYTES) then
      return true
    end
  end
  return false
end

-- Re-read one transcript now (called when a session reports it stopped).
function cost.refresh(path, agent)
  if not path then
    return
  end
  enqueue(path, agent)
  start_pump()
  schedule_save()
end

-- Locate a Codex rollout by session id, for hook payloads that omit the path.
function cost.find_codex_transcript(session_id)
  if not session_id then
    return nil
  end
  for _, back in ipairs({ 0, 86400 }) do
    local dir = CODEX_SESSIONS .. "/" .. os.date("%Y/%m/%d", os.time() - back)
    for _, f in ipairs(util.list_dir(dir)) do
      if f.name:find(session_id, 1, true) then
        return f.path
      end
    end
  end
  return nil
end

-- Today's usage for a single transcript.
function cost.for_transcript(path)
  local e = path and state.files[path]
  local bucket = e and e.days and e.days[day_key()]
  if not bucket then
    return { tokens = 0, dollars = 0, model = e and e.model, priced = true, estimated = true }
  end

  -- `e.model` is the last model parsed out of the file, i.e. the one the session
  -- most recently ran. Deliberately not taken from the loop below: bucket.models
  -- is keyed by model, and pairs() order is arbitrary, so a session that used two
  -- models today would report whichever one happened to come out last.
  local out = { tokens = 0, dollars = 0, model = e.model, priced = true, estimated = true }
  for model, counts in pairs(bucket.models) do
    local dollars, known = pricing.cost(model, counts)
    out.tokens = out.tokens + total_tokens(counts)
    out.dollars = out.dollars + dollars
    out.priced = out.priced and known
  end
  local cx = codex_counts(bucket.codex)
  if cx then
    local dollars, known = pricing.cost(e.model, cx)
    out.tokens = out.tokens + total_tokens(cx)
    out.dollars = out.dollars + dollars
    out.priced = out.priced and known
  end
  return out
end

-- Today's usage per agent.
function cost.totals()
  local today = day_key()
  local out = {
    claude = { tokens = 0, dollars = 0, priced = true, estimated = true },
    codex = { tokens = 0, dollars = 0, priced = true, estimated = true },
    scanning = scanning,
  }

  for _, e in pairs(state.files) do
    local agg = out[e.agent]
    local bucket = agg and e.days and e.days[today]
    if bucket then
      for model, counts in pairs(bucket.models) do
        local dollars, known = pricing.cost(model, counts)
        agg.tokens = agg.tokens + total_tokens(counts)
        agg.dollars = agg.dollars + dollars
        agg.priced = agg.priced and known
      end
      local cx = codex_counts(bucket.codex)
      if cx then
        local dollars, known = pricing.cost(e.model, cx)
        agg.tokens = agg.tokens + total_tokens(cx)
        agg.dollars = agg.dollars + dollars
        agg.priced = agg.priced and known
        -- Codex reports how much of the plan's weekly window is spent. Order by
        -- when the sample was *taken*, not when we happened to parse the file —
        -- concurrent sessions are digested in arbitrary order.
        if e.rate_limit and (e.rate_limit_ts or "") > (out.codex.rate_limit_ts or "") then
          out.codex.rate_limit, out.codex.rate_limit_ts = e.rate_limit, e.rate_limit_ts
        end
      end
    end
  end

  return out
end

function cost.init()
  cost.load()
  cost.discover()
end

return cost
