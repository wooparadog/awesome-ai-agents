-- Compatibility for existing require("lib.ai") installations.
-- New installs should require("lib.ai.clients.awesomewm") explicitly.
local base = (...):gsub("%.init$", "")
return require(base .. ".clients.awesomewm")
