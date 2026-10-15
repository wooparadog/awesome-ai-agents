-- Detect runs on other machines that just finished a turn.
--
--   local detect = finished({ "yoga-arch" })
--   for _, run in ipairs(detect(snapshot)) do ... end
--
-- A run "finishes" when a live run moves from busy to done. The first snapshot
-- only records states, so restarting AwesomeWM does not replay old completions.
-- Runs whose installation_id or machine is in `local_ids` (case-insensitive)
-- are ignored: the desktop already shows those.
local function new(local_ids)
  local is_local = {}
  for _, id in ipairs(local_ids or {}) do
    is_local[tostring(id):lower()] = true
  end
  local previous

  return function(snap)
    local current, out = {}, {}
    for _, runs in pairs(snap.agents or {}) do
      for _, run in ipairs(runs) do
        if run.id then
          current[run.id] = run.state
          local remote = not is_local[tostring(run.installation_id or ""):lower()]
            and not is_local[tostring(run.machine or ""):lower()]
          if
            previous
            and remote
            and run.freshness == "live"
            and run.state == "done"
            and previous[run.id] == "busy"
          then
            out[#out + 1] = run
          end
        end
      end
    end
    previous = current
    return out
  end
end

return new
