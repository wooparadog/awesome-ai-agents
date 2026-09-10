#!/usr/bin/env python3
"""Register this repo's hook.sh with Claude Code and Codex.

  ./install-hooks.py              install into ~/.claude and ~/.codex
  ./install-hooks.py --dry-run    print what would change, touch nothing
  ./install-hooks.py --uninstall  remove only the entries this script added

Claude Code's settings.json is merged (every other key is preserved and the file
is backed up first); Codex's hooks.json is merged the same way. Existing hooks
belonging to other tools are left alone.
"""

import argparse
import json
import os
import re
import shutil
import shlex
import subprocess
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
    return f"{shlex.quote(HOOK)} {agent} {event}"


# Matched by shape rather than by absolute path, so a moved checkout is
# recognised and replaced instead of silently duplicated.
OURS = re.compile(r"(^|/)(?:hook\.sh['\"]?\s+|ai-agents['\"]?\s+hook\s+)(claude|codex)\s+\S+\s*$")


def is_ours(entry):
    """True for a hook entry this script wrote."""
    return any(OURS.search(hook.get("command", "")) for hook in entry.get("hooks", []))


def strip_ours(entries):
    """Preserve other commands even when someone put them in our hook group."""
    result = []
    for entry in entries:
        if not is_ours(entry):
            result.append(entry)
            continue
        remaining = [hook for hook in entry.get("hooks", []) if not OURS.search(hook.get("command", ""))]
        if remaining:
            result.append({**entry, "hooks": remaining})
    return result


def merge(config, agent, events, timeout):
    hooks = config.setdefault("hooks", {})
    for event in events:
        entries = strip_ours(hooks.get(event, []))
        entries.append({"hooks": [{"type": "command", "command": command(agent, event), "timeout": timeout}]})
        hooks[event] = entries
    return config


def strip(config, events):
    hooks = config.get("hooks", {})
    for event in events:
        remaining = strip_ours(hooks.get(event, []))
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
    global HOOK
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--uninstall", action="store_true")
    parser.add_argument("--agent", choices=("all", "claude", "codex"), default="all", help="register hooks only for the selected agent")
    parser.add_argument("--cloud-url", help="collector HTTPS URL (loopback HTTP for development)")
    parser.add_argument("--installation-id", help="installation associated with the write token")
    parser.add_argument("--token-file", help="path to a provisioned write token; never pass the token itself")
    parser.add_argument("--timer", action="store_true", help="install background delivery and the user reconciliation timer")
    parser.add_argument("--compat", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.compat:
        HOOK = os.path.abspath(os.path.join(HERE, "../..", "hook.sh"))

    cloud = (args.cloud_url, args.installation_id, args.token_file)
    if any(cloud) and not all(cloud):
        parser.error("--cloud-url, --installation-id, and --token-file must be supplied together")
    if args.uninstall and any(cloud):
        parser.error("cloud setup cannot be combined with --uninstall")
    config_dir = os.environ.get("AI_AGENTS_CONFIG_DIR", os.path.join(os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config")), "ai-agents"))
    if args.timer and not args.uninstall and not all(cloud) and not os.path.exists(os.path.join(config_dir, "config.json")):
        parser.error("--timer requires cloud configuration")
    if not args.compat and not args.uninstall and not all(cloud) and not os.path.exists(os.path.join(config_dir, "config.json")):
        parser.error("configure a collector with --cloud-url, --installation-id, and --token-file first")
    if all(cloud):
        if args.dry_run:
            print(f"would configure collector {args.cloud_url} for installation {args.installation_id}")
        else:
            subprocess.run([os.path.join(HERE, "reporter.sh"), "init", *cloud], check=True)

    if not os.access(HOOK, os.X_OK):
        sys.exit(f"{HOOK} is not executable — run: chmod +x {HOOK}")

    for path, agent, events, timeout in (
        (CLAUDE_SETTINGS, "claude", CLAUDE_EVENTS, 5),
        (CODEX_HOOKS, "codex", CODEX_EVENTS, 3),
    ):
        if args.agent not in ("all", agent):
            continue
        try:
            config = load(path)
        except json.JSONDecodeError as exc:
            print(f"skipping {path}: not valid JSON ({exc})", file=sys.stderr)
            continue
        updated = strip(config, events) if args.uninstall else merge(config, agent, events, timeout)
        write(path, updated, args.dry_run)

    if args.timer:
        unit_dir = os.path.join(os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config")), "systemd/user")
        names = ("ai-agents-reconcile.service", "ai-agents-reconcile.timer", "ai-agents-upload.service", "ai-agents-upload.path")
        def unit_value(value):
            return value.replace("%", "%%").replace('\\', '\\\\').replace('"', '\\"')
        reporter = unit_value(os.path.join(HERE, "reporter.sh"))
        state_dir = os.environ.get("AI_AGENTS_STATE_DIR", os.path.join(os.environ.get("XDG_STATE_HOME", os.path.expanduser("~/.local/state")), "ai-agents"))
        environment = (f'Environment="AI_AGENTS_CONFIG_DIR={unit_value(config_dir)}"\n'
                       f'Environment="AI_AGENTS_STATE_DIR={unit_value(state_dir)}"\n')
        units = (
            '[Unit]\nDescription=Report AI agent activity\n\n[Service]\nType=oneshot\n' +
            environment + f'ExecStart="{reporter}" reconcile\nTimeoutStartSec=180\n',
            '[Unit]\nDescription=Reconcile AI agent activity\n\n[Timer]\nOnBootSec=5min\n'
            'OnUnitInactiveSec=5min\nAccuracySec=1s\n\n[Install]\nWantedBy=timers.target\n',
            '[Unit]\nDescription=Upload queued AI agent activity\nStartLimitIntervalSec=0\n\n'
            '[Service]\nType=oneshot\n' + environment +
            f'ExecStart="{reporter}" deliver\nTimeoutStartSec=180\nRestart=on-failure\nRestartSec=5\nUMask=0077\n',
            '[Unit]\nDescription=Watch queued AI agent activity\n\n[Path]\n'
            f'DirectoryNotEmpty={state_dir.replace("%", "%%")}/outbox\n'
            f'PathExists={state_dir.replace("%", "%%")}/presence-pending\n'
            'Unit=ai-agents-upload.service\nTriggerLimitIntervalSec=0\n\n[Install]\nWantedBy=default.target\n',
        )
        if args.dry_run:
            print("would " + ("remove" if args.uninstall else "install and enable") + " user reconciliation timer")
        elif args.uninstall:
            subprocess.run(["systemctl", "--user", "disable", "--now", names[1], names[3]], check=True)
            subprocess.run(["systemctl", "--user", "stop", names[2]], check=True)
            for name in names:
                path = os.path.join(unit_dir, name)
                if os.path.exists(path):
                    os.remove(path)
            subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
            marker = os.path.join(config_dir, "background-upload")
            if os.path.exists(marker):
                os.remove(marker)
        else:
            os.makedirs(unit_dir, exist_ok=True)
            os.makedirs(os.path.join(state_dir, "outbox"), exist_ok=True)
            for name, content in zip(names, units):
                with open(os.path.join(unit_dir, name), "w") as fh:
                    fh.write(content)
            subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
            subprocess.run(["systemctl", "--user", "enable", "--now", names[1], names[3]], check=True)
            with open(os.path.join(config_dir, "background-upload"), "w") as fh:
                fh.write("systemd path watcher enabled\n")

    if not args.uninstall:
        print(
            "\nCodex requires trusting hooks once: start its TUI and accept the\n"
            "prompt that appears when it notices the new hooks.json."
        )


if __name__ == "__main__":
    main()
