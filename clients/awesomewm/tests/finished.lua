package.path = "./?.lua;" .. package.path
local finished = require("clients.awesomewm.finished")
local function snap(states)
  local runs = {}
  for id, s in pairs(states) do
    runs[#runs + 1] = { id = id, state = s[1], machine = s[2], installation_id = s[2], freshness = s[3] or "live" }
  end
  return { agents = { claude = runs } }
end

local detect = finished({ "Yoga-Arch" })
-- First snapshot only records state.
assert(#detect(snap({ a = { "done", "rain" }, b = { "busy", "rain" } })) == 0)
-- Remote busy -> done fires; local and stale transitions do not.
assert(#detect(snap({ b = { "busy", "rain" }, c = { "busy", "yoga-arch" }, d = { "busy", "karry" } })) == 0)
local out = detect(snap({ b = { "done", "rain" }, c = { "done", "yoga-arch" }, d = { "done", "karry", "stale" } }))
assert(#out == 1 and out[1].id == "b")
-- Staying done does not repeat.
assert(#detect(snap({ b = { "done", "rain" } })) == 0)
-- asking -> done is not a finished turn worth repeating; busy -> asking isn't either.
assert(#detect(snap({ b = { "asking", "rain" } })) == 0)
assert(#detect(snap({ b = { "done", "rain" } })) == 0)
print("Remote completion detection verified")
