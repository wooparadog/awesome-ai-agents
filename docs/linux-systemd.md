# Linux installation with systemd

Run the reporter as the same Linux user who runs Codex or Claude Code. The
repository supplies a portable [user service](../reporters/rust/systemd/ai-agents.service)
and an optional [network override](../reporters/rust/systemd/10-network.conf.example).
The daemon owns collection, reconciliation, and retry scheduling; only one service
is needed.

## Install from a checkout

Requirements: Linux with `/proc`, a working systemd user manager, Python 3 for
installation, and Rust 1.89 or newer plus a C toolchain/linker for building. A
prebuilt binary removes the Rust/build-tool requirement on the destination machine.

Run these commands from the repository root in the reporting user's login session:

```sh
cargo build --release --locked --manifest-path reporters/rust/Cargo.toml
systemctl --user show-environment >/dev/null
```

For a new machine, first [provision its own write credential](../collector/README.md),
then install:

```sh
python3 reporters/rust/install.py --service \
  --cloud-url https://your-collector.example \
  --installation-id your-machine \
  --token-file /path/to/credential.token
```

For an existing configured reporter, upgrade or migrate with:

```sh
python3 reporters/rust/install.py --service
```

Add `--agent codex` or `--agent claude` to select one agent. Use the same selection
on subsequent upgrades and uninstall. Add `--dry-run` to preview hook settings,
the service unit, and any custom-path override without changing files.

The installer copies the binary to `~/.local/bin/ai-agents`, merges agent hooks,
backs up existing hook configurations, and copies the repository's service to
`${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/ai-agents.service`. It reloads the
user manager, enables the service, and starts/restarts it. Run the installer as
your regular user, without `sudo`.

During migration it disables and stops `ai-agents-reconcile.timer`,
`ai-agents-upload.path`, and their services. Their files and existing state remain
available for rollback. Existing network/service drop-ins are carried forward.
For a previous cron-based installation, remove that reporter's cron entry before
starting the daemon.

Codex may ask for trust when its hook configuration changes. Already-running
agents with cached shell hooks can forward to Rust when their installed
`reporters/shell/hook.sh` is updated too. On machines with separately copied
scripts, update that shim or restart the agent after accepting the new hooks.

## Install a prebuilt binary on another machine

Build for the target architecture and libc. Copy these files together, preserving
the relative `systemd/` directory:

```text
ai-agents
install.py
systemd/
  ai-agents.service
  10-network.conf.example    # optional
```

`install.py` and the systemd files come from `reporters/rust/`; the binary comes
from `reporters/rust/target/release/ai-agents`. On the destination, run:

```sh
python3 install.py --binary ./ai-agents --service
```

Supply the three cloud options above if the destination is not configured yet.
The installer reads `systemd/ai-agents.service` beside itself and checks that it
is present before changing hooks or services.

## Start at boot and keep running after logout

Enabling a user service starts it when that user's service manager starts. For a
headless server that must report before login and after logout, enable lingering:

```sh
sudo loginctl enable-linger "$(id -un)"
loginctl show-user "$(id -un)" --property=Linger
```

Lingering starts the user's manager at boot and keeps it after logout. This is an
explicit host choice; the installer does not enable it automatically. See
[systemd's loginctl documentation](https://www.freedesktop.org/software/systemd/man/252/loginctl.html).

If `systemctl --user` cannot connect to the bus, run the commands from a normal
login/SSH session for that user and ensure the host provides its systemd user
manager. A container without a user manager can run `ai-agents daemon` under its
own supervisor instead.

## Custom paths and network settings

The shared service uses `%h` for the reporting user's home directory, with
`~/.local/bin/ai-agents`, `~/.config/ai-agents`, and `~/.local/state/ai-agents` as its
defaults. The service has no machine-specific username or collector credential.

The installer supports `--bin-dir`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`,
`AI_AGENTS_CONFIG_DIR`, and `AI_AGENTS_STATE_DIR`. If paths differ from the defaults,
it generates `ai-agents.service.d/00-installer-paths.conf`, with the same resolved
paths used by the hook commands. Rerun with those same options/environment when
upgrading. Returning to default paths removes that generated override; existing
state is not relocated automatically.

Use an executable installation path without literal quote characters: systemd
rejects those in `ExecStart` paths. Spaces and percent signs are supported by the
installer's escaping.

To share a proxy between the daemon and CLI, add a `proxy_url` string to
`~/.config/ai-agents/config.json` (preserving its URL and installation ID), then
restart the service. For example: `"proxy_url": "http://127.0.0.1:7890"`.

For systemd environment configuration instead, create
`~/.config/ai-agents/network.env` containing your network
environment, for example:

```ini
HTTPS_PROXY=http://127.0.0.1:7890
NO_PROXY=localhost,127.0.0.1,::1
```

Then install the supplied override from the repository root:

```sh
chmod 600 ~/.config/ai-agents/network.env
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/ai-agents.service.d"
cp reporters/rust/systemd/10-network.conf.example \
  "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/ai-agents.service.d/10-network.conf"
systemctl --user daemon-reload
systemctl --user restart ai-agents.service
```

The example explicitly references `%h/.config/ai-agents/network.env`; edit that
reference if you keep the environment file elsewhere. The example is optional
and is not installed automatically. Previously migrated proxy overrides can keep
using their existing environment files.

Keep local service changes in drop-ins: upgrades replace the base unit with the
repository version. Reserve `00-installer-paths.conf` for the installer. The
service runs the daemon in the foreground and restarts failures after five seconds.

## Manual service installation

For a new installation with default paths, first configure the binary and hooks
using `install.py` without `--service` (including cloud options when required).
Then copy and enable the unit directly:

```sh
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
cp reporters/rust/systemd/ai-agents.service \
  "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/ai-agents.service"
systemctl --user daemon-reload
systemctl --user enable --now ai-agents.service
```

Use the installer with `--service` when migrating legacy services or using custom
paths: it handles disabling old units and generating the path override together.

## Check, upgrade, and remove

```sh
systemctl --user status ai-agents.service
systemctl --user cat ai-agents.service
journalctl --user -u ai-agents.service -n 50 --no-pager
~/.local/bin/ai-agents status
~/.local/bin/ai-agents status --json
~/.local/bin/ai-agents web --expires 10m
```

Open the URL printed by `ai-agents web` for the [live web panel](../clients/web/README.md).
`status` is human-readable; `status --json` is intended for scripts. CLI network
commands and the daemon can share a `proxy_url` setting in the reporter's private
`config.json`. Without that setting, CLI commands inherit the shell environment;
systemd-only environment files apply to the daemon.

Check that the service is running and pending hooks/uploads drain. Rebuild and
rerun the installer to upgrade; the executable is replaced by rename and the
service is restarted. Restart the service after rotating its write credential.

To remove hooks and stop/disable the service:

```sh
python3 reporters/rust/install.py --uninstall --service
```

This removes the base unit and installer-generated path override. It preserves
credentials, pending data, the binary, and user/network drop-ins. Lingering is
also preserved because other user services may rely on it. See the
[daemon guide](../reporters/rust/README.md#operate-and-validate) for rollback and
local validation commands.
