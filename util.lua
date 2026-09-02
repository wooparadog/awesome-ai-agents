#! /usr/bin/env lua

-- Filesystem and /proc helpers shared by the AI agent widget modules.

local lgi = require("lgi")
local Gio = lgi.Gio

local util = {}

-- List a directory as {name, path, is_dir, mtime}; Gio keeps this in-process,
-- so no shelling out to ls.
function util.list_dir(path)
  local out = {}
  local ok, enum = pcall(function()
    return Gio.File.new_for_path(path):enumerate_children(
      "standard::name,standard::type,time::modified",
      Gio.FileQueryInfoFlags.NONE,
      nil
    )
  end)
  if not ok or not enum then
    return out
  end
  while true do
    local got, info = pcall(function()
      return enum:next_file(nil)
    end)
    if not got or not info then
      break
    end
    local name = info:get_name()
    out[#out + 1] = {
      name = name,
      path = path .. "/" .. name,
      -- Read the raw attribute rather than comparing get_file_type() against
      -- Gio.FileType.DIRECTORY: lgi hands back the enum's nickname string, so
      -- that comparison is silently false for every directory.
      -- (G_FILE_TYPE_DIRECTORY == 2)
      is_dir = info:get_attribute_uint32("standard::type") == 2,
      mtime = tonumber(info:get_attribute_uint64("time::modified")) or 0,
    }
  end
  pcall(function()
    enum:close(nil)
  end)
  return out
end

function util.mkdir_p(path)
  pcall(function()
    Gio.File.new_for_path(path):make_directory_with_parents()
  end)
end

function util.read_file(path)
  local fh = io.open(path, "r")
  if not fh then
    return nil
  end
  local content = fh:read("a")
  fh:close()
  return content
end

-- ── /proc ────────────────────────────────────────────────────────────────────

function util.proc_comm(pid)
  local comm = util.read_file("/proc/" .. tostring(pid) .. "/comm")
  return comm and comm:gsub("%s+$", "") or nil
end

function util.proc_ppid(pid)
  local stat = util.read_file("/proc/" .. tostring(pid) .. "/stat")
  if not stat then
    return nil
  end
  -- Field 4 is the parent pid, but field 2 (comm) may contain spaces and
  -- parentheses, so resume parsing after the final ')'.
  local rest = stat:match("%)%s*(.*)$")
  if not rest then
    return nil
  end
  local _state, ppid = rest:match("^(%S+)%s+(%d+)")
  return tonumber(ppid)
end

-- The pid chain from `pid` up towards init, `pid` first. Bounded so a cycle or
-- a stale /proc read can never spin.
function util.proc_ancestors(pid, limit)
  local out = {}
  local current = tonumber(pid)
  for _ = 1, limit or 12 do
    if not current or current <= 1 then
      break
    end
    out[#out + 1] = current
    current = util.proc_ppid(current)
  end
  return out
end

return util
