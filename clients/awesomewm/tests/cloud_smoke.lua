-- Run against a locally started collector with a provisioned read token.
package.path = "./?.lua;" .. package.path
local lgi = require("lgi")
local loop = lgi.GLib.MainLoop()
local api = require("clients.awesomewm.cloud")({ url = arg[1], token_file = arg[2] })
local success = false
api.subscribe(function()
  local s = api.snapshot()
  if s.connection == "connected" and s.revision then
    success = true
    print("WebSocket and snapshot received; revision " .. s.revision)
    api.stop()
    loop:quit()
  end
end)
lgi.GLib.timeout_add(lgi.GLib.PRIORITY_DEFAULT, 10000, function()
  api.stop()
  loop:quit()
  return false
end)
api.start()
loop:run()
assert(success, "cloud connection did not deliver a snapshot")
