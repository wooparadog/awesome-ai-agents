#!/usr/bin/env python3
"""Register this repo's hook.sh with Claude Code and Codex.

  ./install-hooks.sh              install into ~/.claude and ~/.codex
  ./install-hooks.sh --dry-run    print what would change, touch nothing
  ./install-hooks.sh --uninstall  remove only the entries this script added

Claude Code's settings.json is merged (every other key is preserved and the file
is backed up first); Codex's hooks.json is merged the same way. Existing hooks
belonging to other tools are left alone.
"""

import argparse
import json
import os
import re
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "hook.sh")

# PreToolUse/PostToolUse are deliberately absent: they fire hundreds of times per
# turn and carry no signal this widget needs.
CLAUDE_EVENTS = [
    "SessionStart",
    "UserPromptSubmit",
    "PermissionRequest",
    "Notification",
    "Stop",
    "SessionEnd",
]
# Codex has no Notification event, and caps the SessionEnd hook timeout at 3s.
CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "PermissionRequest", "Stop", "SessionEnd"]

CLAUDE_SETTINGS = os.path.expanduser(os.environ.get("CLAUDE_CONFIG_DIR", "~/.claude") + "/settings.json")
CODEX_HOOKS = os.path.expanduser(os.environ.get("CODEX_HOME", "~/.codex") + "/hooks.json")


def command(agent, event):
    return f"{HOOK} {agent} {event}"


# Matched by shape rather than by absolute path, so a moved checkout is
# recognised and replaced instead of silently duplicated.
OURS = re.compile(r"(^|/)hook\.sh\s+(claude|codex)\s+\S+\s*$")


def is_ours(entry):
    """True for a hook entry this script wrote."""
    return any(OURS.search(hook.get("command", "")) for hook in entry.get("hooks", []))


def merge(config, agent, events, timeout):
    hooks = config.setdefault("hooks", {})
    for event in events:
        entries = [e for e in hooks.get(event, []) if not is_ours(e)]
        entries.append({"hooks": [{"type": "command", "command": command(agent, event), "timeout": timeout}]})
        hooks[event] = entries
    return config


def strip(config, events):
    hooks = config.get("hooks", {})
    for event in events:
        remaining = [e for e in hooks.get(event, []) if not is_ours(e)]
        if remaining:
            hooks[event] = remaining
        else:
            hooks.pop(event, None)
    if not hooks:
        config.pop("hooks", None)
    return config


def load(path):
    if not os.path.exists(path):
        return {}
    with open(path) as fh:
        text = fh.read().strip()
    return json.loads(text) if text else {}


def write(path, config, dry_run):
    rendered = json.dumps(config, indent=2) + "\n"
    if dry_run:
        print(f"--- would write {path} ---\n{rendered}")
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        backup = f"{path}.bak.{time.strftime('%Y%m%d%H%M%S')}"
        shutil.copy2(path, backup)
        print(f"backed up {path} -> {backup}")
    with open(path, "w") as fh:
        fh.write(rendered)
    print(f"wrote {path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--uninstall", action="store_true")
    args = parser.parse_args()

    if not os.access(HOOK, os.X_OK):
        sys.exit(f"{HOOK} is not executable — run: chmod +x {HOOK}")

    for path, agent, events, timeout in (
        (CLAUDE_SETTINGS, "claude", CLAUDE_EVENTS, 5),
        (CODEX_HOOKS, "codex", CODEX_EVENTS, 3),
    ):
        try:
            config = load(path)
        except json.JSONDecodeError as exc:
            print(f"skipping {path}: not valid JSON ({exc})", file=sys.stderr)
            continue
        updated = strip(config, events) if args.uninstall else merge(config, agent, events, timeout)
        write(path, updated, args.dry_run)

    if not args.uninstall:
        print(
            "\nCodex requires trusting hooks once: start its TUI and accept the\n"
            "prompt that appears when it notices the new hooks.json."
        )


if __name__ == "__main__":
    main()
