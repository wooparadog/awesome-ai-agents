#!/usr/bin/env python3
"""Install the Rust reporter and migrate registered agent hooks."""
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
SERVICE_SOURCE = os.path.join(HERE, "systemd", "ai-agents.service")
BINARY = os.path.expanduser("~/.local/bin/ai-agents")
CONFIG_DIR = ""
STATE_DIR = ""

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
    return (f"AI_AGENTS_CONFIG_DIR={shlex.quote(CONFIG_DIR)} AI_AGENTS_STATE_DIR={shlex.quote(STATE_DIR)} "
            f"{shlex.quote(BINARY)} hook {agent} {event}")


# Matched by shape rather than by absolute path, so a moved checkout is
# recognised and replaced instead of silently duplicated.
OURS = re.compile(r"(^|/)hook\.sh['\"]?\s+(claude|codex)\s+\S+\s*$")



def ours(command):
    return bool(OURS.search(command) or re.search(r"(^|[/\s])ai-agents['\"]?\s+hook\s+(claude|codex)\s+\S+\s*$", command))

def is_ours(entry):
    """True for a hook entry this script wrote."""
    return any(ours(hook.get("command", "")) for hook in entry.get("hooks", []))


def strip_ours(entries):
    """Preserve other commands even when someone put them in our hook group."""
    result = []
    for entry in entries:
        if not is_ours(entry):
            result.append(entry)
            continue
        remaining = [hook for hook in entry.get("hooks", []) if not ours(hook.get("command", ""))]
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



def unit_value(value):
    return str(value).replace("%", "%%").replace("\\", "\\\\").replace('"', '\\"')


def path_override():
    defaults = (os.path.expanduser("~/.local/bin/ai-agents"),
                os.path.expanduser("~/.config/ai-agents"),
                os.path.expanduser("~/.local/state/ai-agents"))
    if (BINARY, CONFIG_DIR, STATE_DIR) == defaults:
        return None
    return ('# Managed by ai-agents install.py; rerun the installer to change paths.\n'
            '[Service]\n'
            f'Environment="AI_AGENTS_CONFIG_DIR={unit_value(CONFIG_DIR)}"\n'
            f'Environment="AI_AGENTS_STATE_DIR={unit_value(STATE_DIR)}"\n'
            'ExecStart=\n'
            f'ExecStart="{unit_value(BINARY)}" daemon\n')


def main():
    global BINARY, CONFIG_DIR, STATE_DIR
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", default=os.path.join(HERE, "target/release/ai-agents"))
    parser.add_argument("--bin-dir", default=os.path.expanduser("~/.local/bin"))
    parser.add_argument("--agent", choices=("all", "claude", "codex"), default="all")
    parser.add_argument("--service", action="store_true", help="install one user service and retire legacy timer/path units")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--uninstall", action="store_true")
    parser.add_argument("--cloud-url")
    parser.add_argument("--installation-id")
    parser.add_argument("--token-file")
    args = parser.parse_args()
    BINARY = os.path.abspath(os.path.join(args.bin_dir, "ai-agents"))
    CONFIG_DIR = os.path.abspath(os.environ.get("AI_AGENTS_CONFIG_DIR", os.path.join(os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config")), "ai-agents")))
    STATE_DIR = os.path.abspath(os.environ.get("AI_AGENTS_STATE_DIR", os.path.join(os.environ.get("XDG_STATE_HOME", os.path.expanduser("~/.local/state")), "ai-agents")))
    cloud = (args.cloud_url, args.installation_id, args.token_file)
    if any(cloud) and (not all(cloud) or args.uninstall):
        parser.error("supply all three cloud options, only when installing")
    if not args.uninstall and not all(cloud) and not os.path.isfile(os.path.join(CONFIG_DIR, "config.json")):
        parser.error("configure the collector first or supply the three cloud options")
    if not args.uninstall and not os.access(args.binary, os.X_OK):
        parser.error("build the Rust binary first or pass --binary")

    # Validate every selected file before changing the service or any hooks.
    updates = []
    for path, agent, events, timeout in ((CLAUDE_SETTINGS,"claude",CLAUDE_EVENTS,5),(CODEX_HOOKS,"codex",CODEX_EVENTS,3)):
        if args.agent not in ("all",agent):
            continue
        config = load(path)
        updates.append((path, strip(config,events) if args.uninstall else merge(config,agent,events,timeout)))
    unit_dir = os.path.join(os.environ.get("XDG_CONFIG_HOME",os.path.expanduser("~/.config")), "systemd/user")
    service = "ai-agents.service"
    override_file = os.path.join(unit_dir, service+".d", "00-installer-paths.conf")
    content = None
    override = None
    if args.service and not args.uninstall:
        try:
            with open(SERVICE_SOURCE) as fh:
                content = fh.read()
        except OSError as exc:
            parser.error(f"cannot read service unit {SERVICE_SOURCE}: {exc}; include the systemd directory beside install.py")
        override = path_override()
    legacy = ("ai-agents-reconcile.timer", "ai-agents-upload.path", "ai-agents-reconcile.service", "ai-agents-upload.service")
    if args.dry_run:
        for path, config in updates:
            write(path,config,True)
        if content is not None:
            print(f"--- would write {os.path.join(unit_dir,service)} ---\n{content}")
            if override is not None:
                print(f"--- would write {override_file} ---\n{override}")
            elif os.path.exists(override_file):
                print(f"would remove {override_file}")
        print("would " + ("stop reporter and remove hooks" if args.uninstall else "install binary and " + ("migrate to one user service" if args.service else "register hooks; run ai-agents daemon with your supervisor")))
        return
    env = dict(os.environ,AI_AGENTS_CONFIG_DIR=CONFIG_DIR,AI_AGENTS_STATE_DIR=STATE_DIR)
    if not args.uninstall:
        os.makedirs(args.bin_dir,exist_ok=True)
        # Rename so replacing a running executable never truncates it.
        if os.path.realpath(args.binary) != os.path.realpath(BINARY):
            shutil.copy2(args.binary,BINARY+".new")
            os.chmod(BINARY+".new",0o755)
            os.replace(BINARY+".new",BINARY)
        if all(cloud):
            subprocess.run([BINARY,"init",*cloud],env=env,check=True)
    if args.service:
        os.makedirs(unit_dir,exist_ok=True)
        if args.uninstall:
            subprocess.run(["systemctl","--user","disable","--now",service],check=True)
            unit = os.path.join(unit_dir,service)
            if os.path.exists(unit): os.remove(unit)
            if os.path.exists(override_file): os.remove(override_file)
        else:
            # Carry forward existing proxy/network environment overrides. Keep
            # originals for rollback. Copy only once, preserving new overrides.
            dest = os.path.join(unit_dir,service+".d")
            for name in ("ai-agents-reconcile.service","ai-agents-upload.service"):
                source = os.path.join(unit_dir,name+".d")
                if os.path.isdir(source):
                    os.makedirs(dest,exist_ok=True)
                    for entry in sorted(os.listdir(source)):
                        target = os.path.join(dest,entry)
                        if entry.endswith(".conf") and not os.path.exists(target):
                            shutil.copy2(os.path.join(source,entry),target)
            with open(os.path.join(unit_dir,service),"w") as fh: fh.write(content)
            if override is not None:
                os.makedirs(dest,exist_ok=True)
                with open(override_file,"w") as fh: fh.write(override)
            elif os.path.exists(override_file):
                os.remove(override_file)
            existing = [name for name in legacy if os.path.exists(os.path.join(unit_dir,name))]
            if existing:
                subprocess.run(["systemctl","--user","disable","--now",*existing],check=True)
        subprocess.run(["systemctl","--user","daemon-reload"],check=True)
    if not args.uninstall:
        os.makedirs(CONFIG_DIR,exist_ok=True)
        marker = os.path.join(CONFIG_DIR,"daemon-binary")
        with open(marker+".new","w") as fh: fh.write(BINARY+"\n")
        os.chmod(marker+".new",0o600)
        os.replace(marker+".new",marker)
    else:
        marker = os.path.join(CONFIG_DIR,"daemon-binary")
        if os.path.exists(marker): os.remove(marker)
    for path, config in updates:
        write(path,config,False)
    if args.service and not args.uninstall:
        subprocess.run(["systemctl","--user","enable",service],check=True)
        subprocess.run(["systemctl","--user","restart",service],check=True)
        subprocess.run(["systemctl","--user","is-active","--quiet",service],check=True)
    if not args.uninstall:
        print("Installed. Codex may request trust for the updated hooks. Pending state and credentials are preserved.")


if __name__ == "__main__":
    main()
