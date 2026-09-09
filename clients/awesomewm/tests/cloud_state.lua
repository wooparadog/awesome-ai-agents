package.path = "./?.lua;" .. package.path
local expire = require("clients.awesomewm.cloud_state")
local state = {
  to = 1000,
  connection = "disconnected",
  agents = {
    claude = {
      { state = "asking", freshness = "live", presence_expires_at = 100 },
      { state = "busy", freshness = "live", presence_expires_at = 200 },
      { state = "done", freshness = "unverified" },
    },
  },
}
assert(expire(state, 99) == 100)
assert(state.total == 2 and state.asking == 1 and state.unverified == 1)
assert(expire(state, 100) == 200)
assert(state.total == 1 and state.asking == 0 and state.stale == 1)
assert(expire(state, 201) == 1000)
assert(state.total == 0 and state.busy == 0 and state.stale == 2)
assert(state.agents.claude[1].state == "asking")
print("Offline freshness expiry verified")
