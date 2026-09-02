# awesome-ai-agents

An AwesomeWM wibar indicator for **Claude Code** and **Codex** sessions: how many
are running, how many are blocked waiting on you, and what today's tokens cost.

```
󰚩 3          three sessions, all working
󰚩 3 ?1       one is asking you something          (red)
󰚩 3 ✓2       two finished a turn, awaiting input  (green)
```

Hovering opens a per-agent breakdown; left-clicking focuses the terminal of
whichever session wants you; right-clicking forces a rescan. With no agents
running the widget reports zero, so the surrounding wibar segment can hide
itself entirely.

```
AI agents
claude code  3 sessions
 ? toki-web/master    needs you   claude-opus-5   25.9M
 ✓ dash               done        claude-opus-5    7.6M
 ✓ notes              done        claude-opus-5     77k
   today  69.6M tokens · $58.75

codex  1 session
 ● orion              working     gpt-5.6-sol      3.7M
   today  3.7M tokens · cost n/a · weekly limit 30%

total today  $58.75
```

## Why it costs nothing to run

**Nothing polls.** Both CLIs support hooks, so each one reports when it starts, submits a
prompt, blocks on a permission prompt, finishes a turn, or exits. An idle desktop
with idle agents costs exactly zero CPU — there is no timer anywhere in the
module.

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

`state` carries `total`, `busy`, `asking`, `done`, `order` (agent names),
`agents` (grouped session lists) and `cost` (today's per-agent totals). Each
session has `agent`, `state`, `cwd`, `model`, `pid` and `transcript`.

The returned handle exposes `widget`, `state`, `update()`, `show_popup()`,
`hide_popup()` and `jump()`.

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

Session states: `busy` (working) → `asking` (blocked on a permission prompt or
question) → `done` (turn finished, awaiting your next prompt). Hooks alone can't
be trusted for liveness — a `kill -9`'d agent never fires `SessionEnd` — so every
read of the session list first reaps sessions whose pid has left `/proc`, with a
`comm` check to survive pid reuse.

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

- A session already running when the hooks were installed stays invisible until
  its next turn fires a hook.
- Click-to-focus follows the process tree to a window. Agents inside **tmux** are
  handled specially (pane lookup, then the attached client's window), but an
  agent over ssh or in a detached tmux session has no local window to focus.
- Prices are hand-maintained. An unknown model is not an error: its tokens are
  still counted, it is left out of the dollar figure, and the total is marked
  `+`. Codex's `gpt-5.6-sol` is currently unpriced.
- Costs cover **today** only (local midnight) and are estimates: they price the
  tokens the transcripts record, with no visibility into subscription billing.
- Linux only — liveness and click-to-focus read `/proc`.

## License

MIT. Vendors `dkjson.lua` (MIT, David Heiko Kolf).
