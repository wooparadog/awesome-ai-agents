package.path = "./?.lua;" .. package.path
local lgi = require("lgi")
local loop = lgi.GLib.MainLoop()
local api = require("clients.awesomewm.cloud")({ url = arg[1], token_file = arg[2] })
local initial, success
api.subscribe(function()
  local state = api.snapshot()
  if state.revision then
    if not initial then
      initial = state.revision
      local fh = assert(io.open(arg[3], "w"))
      fh:write("ready")
      fh:close()
    elseif state.revision > initial then
      for _, runs in pairs(state.agents) do
        for _, run in ipairs(runs) do
          if run.native_session_id == arg[4] and run.state == "done" and run.usage.available then
            success = true
            print("Live hook → D1 → hibernating WebSocket → Lua snapshot and usage verified")
            api.stop()
            loop:quit()
          end
        end
      end
    end
  end
end)
lgi.GLib.timeout_add(lgi.GLib.PRIORITY_DEFAULT, 20000, function()
  api.stop()
  loop:quit()
  return false
end)
api.start()
loop:run()
assert(success, "live update was not received")
