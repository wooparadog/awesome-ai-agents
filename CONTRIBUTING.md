# Contributing

The collector is the core product. Its API is shared by reporters and viewer
clients; desktop integrations must not define server behavior.

## Component boundaries

- `collector/`: authentication, validation, session reduction, usage accounting,
  persistence, retention, and notification delivery. No Lua, AwesomeWM, or OS UI
  dependencies. Server tests live in `collector/test/`.
- `reporters/<name>/`: agent hooks and local observations. A reporter owns process
  discovery, transcript adaptation, retry persistence, and platform scheduling.
  Its runtime, installation steps, and tests belong in its own directory.
- `clients/<name>/`: presentation, read credentials, snapshot requests, WebSocket
  subscriptions, reconnect handling, and packaging. A viewer should not parse
  agent transcripts or recalculate authoritative costs.
- `docs/client-protocol.md`: public v1 contract. Update it alongside API changes.
  Preserve compatibility for existing consumers or version a breaking change.

Windows and macOS viewers can be added without changing reporter platforms. Native
agent reporting on those systems is separate work under `reporters/`. Do not list
a platform as supported until its implementation and validation are available.

The root `init.lua`, `hook.sh`, and `install-hooks.sh` are migration forwarders;
new functionality belongs in a component, not those files.

## Local checks

For collector-only work, install Node.js compatible with the locked Wrangler
version and pnpm 11, then run:

```sh
cd collector
pnpm install --frozen-lockfile
pnpm types
pnpm check
pnpm test
```

To check all components, also install Rust 1.89 or newer, Python 3, the shell reporter's Linux runtime
dependencies, ShellCheck, StyLua, and Lua 5.4 with `lgi` and libsoup 3 introspection:

```sh
./scripts/check.sh
```

Reporter tests use temporary configuration directories and a local HTTP server.
AwesomeWM import tests substitute the UI modules and do not need a running window
manager. Interactive connection checks are described in the
[client README](clients/awesomewm/README.md).

All supplied checks run locally. The scripts do not register hooks in your personal
agent configuration, enable reporting services, push commits, or deploy Cloudflare
resources. Provisioning and development-server setup are explicit commands in the
[collector guide](collector/README.md).
