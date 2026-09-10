# Viewer clients

Clients consume collector snapshots and subscribe to changes with read credentials.
They do not inspect agent processes, parse transcripts, calculate authoritative
usage totals, or ingest events merely to display them.

| Client | Status | Platform |
| --- | --- | --- |
| [Web panel](web/README.md) | Implemented | Modern desktop/mobile browser |
| [AwesomeWM](awesomewm/README.md) | Implemented | Linux desktop |
| Windows tray | Future | Not implemented |
| macOS menu bar | Future | Not implemented |

Every viewer uses the same [HTTP/WebSocket protocol](../docs/client-protocol.md).
A Windows or macOS viewer can display activity from any reporting machine without
sharing that machine's filesystem or PID namespace. A native reporter is a separate
integration when agents themselves run on those operating systems.

Add future clients in their own subdirectory, with their dependencies, UI,
packaging, and tests. Keep desktop-specific code out of the collector and document
which protocol version the client supports. Reuse the server's state and usage
semantics rather than reproducing the reducer on each platform.
