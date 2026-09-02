# awesome-ai-agents

An AwesomeWM wibar indicator for **Claude Code** and **Codex** sessions: how many
are running, how many are blocked waiting on you, and what today's tokens cost.

```
󰚩 3          three sessions, all working
󰚩 3 ?1       one is asking you something          (red)
󰚩 3 ✓2       two finished a turn, awaiting input  (green)
```

Hovering opens a per-agent breakdown; right-clicking forces a rescan.

```
AI agents
claude code  3 sessions
 ? toki-web/master    needs you   claude-opus-5   25.9M
 ✓ dash               done        claude-opus-5    7.6M
 · notes              idle        claude-opus-5     77k
   today  69.6M tokens · $58.75

codex  1 session
 ● orion              working     gpt-5.6-sol      3.7M
   today  3.7M tokens · cost n/a · weekly limit 94%

total today  $58.75
```

## Why it costs almost nothing to run

**Running agents report themselves.** Both CLIs support hooks, so each one says
when it starts, submits a prompt, blocks on a permission prompt, finishes a turn,
or exits. Between those events, tracking a busy agent costs nothing at all.

**Except for one thing no hook reports: an agent that hasn't run a turn yet.**
Codex creates its session — and its rollout file — only when the first prompt is
submitted, so a freshly opened TUI is invisible to hooks *and* to the filesystem.
That gap is covered by a `/proc` walk every `scan_interval` seconds (default 15,
~3ms a pass, `0` disables it and falls back to scanning on hook events and when
the popup opens).

**Costs are computed incrementally.** Transcripts are append-only JSONL, so each
file carries a byte offset and a refresh only parses the bytes appended since
last time — a few KB per finished turn, folded in when the agent says it
stopped, which is why hovering is instant. The cold start (a whole day of
transcripts) runs on GLib's idle queue in bounded chunks and never blocks
AwesomeWM's single main loop.

Everything is pure Lua (lgi/Gio for file monitoring and directory listing), apart
from an 8-line POSIX `hook.sh`. No `jq`, no `node`, no external cost tool.

## Install

As a submodule of your AwesomeWM config:

```sh
cd ~/.config/awesome
git submodule add https://github.com/wooparadog/awesome-ai-agents.git lib/ai
lib/ai/install-hooks.sh          # or --dry-run first
```

`install-hooks.sh` merges the hook entries into `~/.claude/settings.json` and
`~/.codex/hooks.json`, backing both up and leaving every other key (and any
hooks belonging to other tools) untouched. `--uninstall` removes exactly what it
added.

> **Codex requires trusting hooks once.** They stay inert until you accept the
> prompt its TUI shows when it notices a new or changed `hooks.json`. Editing
> that file later invalidates the stored trust hash and re-prompts.

Then in your theme:

```lua
local ai_agents = require("lib.ai")

local ai = ai_agents({
  settings = function(state, widget)
    local text = "󰚩 " .. state.total
    if state.asking > 0 then text = text .. " ?" .. state.asking end
    if state.done > 0 then text = text .. " ✓" .. state.done end
    widget:set_markup(text)
  end,
})

-- ai.widget goes in your wibar
```

### Arguments

| argument | default | meaning |
| --- | --- | --- |
| `settings(state, widget)` | — | render callback, see below |
| `widget` | a new textbox | the widget to drive |
| `colors` | red/green/grey | `{ asking, done, dim }`, used in the popup |
| `notification_preset` | — | naughty preset for the hover popup |
| `claude_projects` | `~/.claude/projects` | Claude transcript root |
| `codex_sessions` | `~/.codex/sessions` | Codex rollout root |
| `cache_path` | `$XDG_CACHE_HOME/awesome/ai-agents.json` | offset/usage cache |
| `event_dir` | `$XDG_RUNTIME_DIR/ai-agents` | must match `hook.sh` (`AI_AGENTS_EVENT_DIR`) |
| `scan_interval` | `15` | seconds between `/proc` discovery passes; `0` disables |

`state` carries `total`, `busy`, `asking`, `done`, `order` (agent names),
`agents` (grouped session lists) and `cost` (today's per-agent totals). Each
session has `agent`, `state`, `cwd`, `model`, `pid` and `transcript`.

The returned handle exposes `widget`, `state`, `update()`, `show_popup()` and
`hide_popup()`. `sessions.log()` returns the last 64 events applied, which is the
first thing to look at when a state looks wrong.

## How it works

| file | role |
| --- | --- |
| `hook.sh` | writes each hook payload to `$XDG_RUNTIME_DIR/ai-agents/<agent>.<Event>.<pid>.<nanos>.json` |
| `sessions.lua` | Gio directory monitor; live session table and state machine |
| `cost.lua` | incremental transcript accounting, persisted byte offsets |
| `pricing.lua` | per-model prices |
| `util.lua` | Gio directory listing and `/proc` helpers |
| `init.lua` | the widget: markup, popup, click-to-focus |

`hook.sh` never builds JSON — the agent name, event and pid ride in the
*filename*, so the payload passes through byte-for-byte. Writes go to
`$XDG_RUNTIME_DIR` (tmpfs): no disk wear, and no stale state survives a reboot.

Session states: `idle` (open, nothing said yet) → `busy` (working) → `asking`
(blocked on a permission prompt or question) → `done` (turn finished, awaiting
your next prompt).

Several things make that tracking hold up in practice:

- **Liveness.** A `kill -9`'d agent never fires `SessionEnd`, so every read of the
  session list first reaps sessions whose pid has left `/proc`, with a `comm`
  check to survive pid reuse.
- **Compaction.** Claude Code fires `SessionStart` with `source: "compact"` in the
  *middle* of a turn. Treating that like a new session would report a busy agent
  as idle for the rest of the turn, so it's ignored.
- **Unrecognised notifications.** `Notification` covers both "needs your
  permission" and "waiting for your input". Anything else it might say leaves the
  state untouched — guessing would clear a working agent's badge.
- **One session per process.** A new session on a pid retires whatever was there
  before, so `/clear` and `/resume` don't leave superseded sessions behind
  inflating the count. This also means a session adopted from `/proc` is replaced
  cleanly once it fires its first hook.
- **Clearing `asking`.** Nothing reports that *you answered*. While a session is
  blocked, its transcript is watched: the agent writes again the moment it is
  unblocked, which clears the badge instead of leaving it stuck until the turn
  ends.
- **Helper processes.** The Claude daemon, its pty hosts, Codex's MCP/app servers
  and the `node` wrapper all carry an agent's name but are not sessions, and are
  filtered out of discovery.

`PreToolUse` / `PostToolUse` are deliberately not registered: they fire hundreds
of times per turn and add no signal.

### Cost accounting

Claude transcripts record per-message `usage` (input, output, 5m/1h cache writes,
cache reads) plus the model, which are priced from `pricing.lua`. Assistant
messages are deduplicated **globally**, not per file — a forked or resumed
session copies its parent's history into a new transcript, which otherwise
overcounts by ~10%. This matches [ccusage](https://github.com/ccusage/ccusage).

Codex logs *cumulative* totals per turn, so a day costs the difference between
its last snapshot and the last one taken before the day began. Its rollouts also
carry the plan's rate-limit percentage, which the popup shows.

Totals were validated against an independent `jq` implementation over real
transcripts — 69,233,739 tokens / $58.4294 across a day, matching exactly.

## Known limits

- A session running on another machine (ssh, a container) is invisible: both
  discovery paths are local.
- A discovered session has no session id to match a transcript against, so its
  usage is read from the most recent transcript for its working directory. With
  two agents in one directory that can attribute usage to the wrong row until the
  session fires its first hook.
- Prices are hand-maintained. An unknown model is not an error: its tokens are
  still counted, it is left out of the dollar figure, and the total is marked
  `+`. Codex's `gpt-5.6-sol` is currently unpriced.
- Costs cover **today** only (local midnight) and are estimates: they price the
  tokens the transcripts record, with no visibility into subscription billing.
- Linux only — liveness and click-to-focus read `/proc`.

## License

MIT. Vendors `dkjson.lua` (MIT, David Heiko Kolf).
