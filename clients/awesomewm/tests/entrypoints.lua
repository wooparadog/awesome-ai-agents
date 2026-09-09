-- Loading either entry point must resolve the same client without starting it.
package.path = "./?.lua;./?/init.lua;" .. package.path
for _, name in ipairs({ "wibox", "awful", "naughty", "gears" }) do
  package.preload[name] = function()
    return {}
  end
end
local client = require("clients.awesomewm")
assert(type(client) == "function")
package.preload["example.ai.clients.awesomewm"] = function()
  return client
end
local legacy = assert(loadfile("init.lua"))
assert(legacy("example.ai") == client)
assert(legacy("example.ai.init") == client)
print("Canonical and compatibility client imports verified")
