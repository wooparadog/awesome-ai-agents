-- Recompute freshness locally even if the collector cannot be reached.
local function expire(state, now)
  state.total, state.busy, state.asking, state.done = 0, 0, 0, 0
  state.stale, state.unverified = 0, 0
  local next_at = state.to or math.huge
  for _, runs in pairs(state.agents) do
    for _, run in ipairs(runs) do
      local deadline = run.presence_expires_at
      if deadline and deadline <= now then
        run.freshness = "stale"
      end
      if run.freshness == "live" then
        state.total = state.total + 1
        if run.state == "busy" or run.state == "asking" or run.state == "done" then
          state[run.state] = state[run.state] + 1
        end
        next_at = math.min(next_at, deadline or math.huge)
      elseif run.freshness == "stale" then
        state.stale = state.stale + 1
      else
        state.unverified = state.unverified + 1
      end
    end
  end
  return next_at
end
return expire
