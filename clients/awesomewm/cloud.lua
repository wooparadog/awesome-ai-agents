-- Authenticated cloud backend. GLib async I/O; hibernating WebSocket invalidations.
local lgi = require("lgi")
local Soup = lgi.require("Soup", "3.0")
local GLib, Gio = lgi.GLib, lgi.Gio
local base = (...):match("(.-)[^%.]+$")
local json = require(base .. "dkjson")
local expire = require(base .. "cloud_state")
local function empty()
  return {
    total = 0,
    busy = 0,
    asking = 0,
    done = 0,
    stale = 0,
    unverified = 0,
    order = {},
    agents = {},
    cost = {},
    connection = "connecting",
  }
end
local function new(opts)
  assert(opts.url and opts.token_file, "cloud requires url and token_file")
  local url = opts.url:gsub("/+$", "")
  assert(
    url:match("^https://") or url:match("^http://127%.0%.0%.1:") or url:match("^http://localhost:"),
    "HTTPS required"
  )
  local api, state = {}, empty()
  local callbacks, timers = {}, {}
  local http = Soup.Session({ timeout = 10 })
  local socket, stopped, fetching, pending = nil, false, false, false
  local wanted, reconnect_attempt, refresh_attempt = 0, 0, 0
  local generation, pong_at = 0, 0
  local received_at = 0
  local cancel = Gio.Cancellable()
  local function emit()
    for _, cb in ipairs(callbacks) do
      cb()
    end
  end
  local function remove_timer(name)
    if timers[name] then
      GLib.source_remove(timers[name])
      timers[name] = nil
    end
  end
  local function later(name, seconds, fn)
    remove_timer(name)
    timers[name] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, math.max(1, math.floor(seconds * 1000)), function()
      timers[name] = nil
      if not stopped then
        fn()
      end
      return false
    end)
  end
  local function message(path)
    local fh = io.open(opts.token_file, "r")
    if not fh then
      return nil
    end
    local token = fh:read("*a"):gsub("%s+$", "")
    fh:close()
    if not token:match("^[%w_%-]+%.[%w_%-]+$") then
      return nil
    end
    local msg = Soup.Message.new("GET", url .. path)
    msg:get_request_headers():append("Authorization", "Bearer " .. token)
    return msg
  end
  local function decode(bytes)
    local ok, value = pcall(json.decode, bytes:get_data(), 1, nil)
    if ok and type(value) == "table" then
      return value
    end
  end
  local function refresh_retry()
    refresh_attempt = math.min(refresh_attempt + 1, 6)
    later("refresh", math.min(60, 2 ^ refresh_attempt) + math.random(), api.refresh)
  end
  local function boundary()
    local now = state.server_time + math.max(0, GLib.get_real_time() / 1000 - received_at)
    local next_at = expire(state, now)
    emit()
    if now >= state.to then
      api.refresh()
    else
      later("boundary", math.max(0.1, (next_at - now) / 1000), boundary)
    end
  end
  function api.refresh()
    if stopped then
      return
    end
    if fetching then
      pending = true
      return
    end
    local msg = message("/v1/snapshot")
    if not msg then
      state.connection = "credentials unavailable"
      emit()
      refresh_retry()
      return
    end
    fetching = true
    pending = false
    http:send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancel, function(session, result)
      fetching = false
      if stopped then
        return
      end
      local ok, bytes = pcall(session.send_and_read_finish, session, result)
      local value = ok and msg.status_code == 200 and decode(bytes)
      if type(value) ~= "table" or type(value.agents) ~= "table" or type(value.revision) ~= "number" then
        state.connection = "snapshot unavailable"
        emit()
        refresh_retry()
        return
      end
      if state.revision and value.revision < state.revision then
        refresh_retry()
        return
      end
      state = value
      received_at = GLib.get_real_time() / 1000
      state.connection = socket and "connected" or "disconnected"
      if socket then
        pcall(socket.send_text, socket, json.encode({ type = "ack", revision = state.revision }))
      end
      refresh_attempt = 0
      local seconds = math.max(0.1, ((state.next_refresh_at or state.to) - state.server_time) / 1000)
      later("boundary", seconds, boundary)
      emit()
      if pending or value.revision < wanted then
        later("refresh", 0.05, api.refresh)
      end
    end)
  end
  local connect
  local function reconnect()
    if stopped then
      return
    end
    generation = generation + 1
    local old = socket
    socket = nil
    if old then
      pcall(old.close, old, 1000, "reconnecting")
    end
    state.connection = "disconnected"
    emit()
    remove_timer("heartbeat")
    reconnect_attempt = math.min(reconnect_attempt + 1, 6)
    later("reconnect", math.min(60, 2 ^ (reconnect_attempt - 1)) + math.random(), connect)
  end
  local function heartbeat()
    if not socket then
      return
    end
    if GLib.get_monotonic_time() / 1e6 - pong_at > 50 then
      reconnect()
      return
    end
    local ok = pcall(socket.send_text, socket, "ping")
    if not ok then
      reconnect()
      return
    end
    later("heartbeat", 20, heartbeat)
  end
  connect = function()
    if stopped then
      return
    end
    local msg = message("/v1/subscribe")
    if not msg then
      reconnect()
      return
    end
    generation = generation + 1
    local current = generation
    http:websocket_connect_async(msg, nil, nil, GLib.PRIORITY_DEFAULT, cancel, function(session, result)
      local ok, conn = pcall(session.websocket_connect_finish, session, result)
      if stopped or current ~= generation then
        if ok and conn then
          conn:close(1000, "superseded")
        end
        return
      end
      if not ok or not conn then
        reconnect()
        return
      end
      socket = conn
      pong_at = GLib.get_monotonic_time() / 1e6
      conn.on_message = function(_, kind, bytes)
        if current ~= generation then
          return
        end
        local raw = bytes:get_data()
        if raw == "pong" then
          pong_at = GLib.get_monotonic_time() / 1e6
          return
        end
        local value = decode(bytes)
        if not value then
          return
        end
        if value.type == "ready" then
          api.refresh()
        elseif value.type == "state.changed" and type(value.revision) == "number" then
          wanted = math.max(wanted, value.revision)
          if wanted > (state.revision or -1) then
            later("refresh", 0.05, api.refresh)
          else
            conn:send_text(json.encode({ type = "ack", revision = state.revision }))
          end
        end
      end
      conn.on_closed = function()
        if current == generation then
          reconnect()
        end
      end
      conn.on_error = function()
        if current == generation then
          reconnect()
        end
      end
      state.connection = "connected"
      emit()
      -- The server accepts before returning the upgrade; snapshot follows acceptance
      -- even if a ready frame was delivered before callbacks were installed.
      api.refresh()
      later("heartbeat", 20, heartbeat)
      later("stable", 30, function()
        if current == generation then
          reconnect_attempt = 0
        end
      end)
    end)
  end
  function api.snapshot()
    return state
  end
  function api.subscribe(cb)
    callbacks[#callbacks + 1] = cb
  end
  function api.start()
    connect()
  end
  function api.stop()
    stopped = true
    cancel:cancel()
    for name in pairs(timers) do
      remove_timer(name)
    end
    if socket then
      socket:close(1000, "widget stopped")
      socket = nil
    end
    http:abort()
  end
  -- On desktop resume the GLib timer runs promptly and renews the snapshot;
  -- missed heartbeat deadlines force a fresh subscription.
  return api
end
return new
