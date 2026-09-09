# Reporters

Reporters run alongside coding agents. They observe native hooks, processes, and
usage metadata, then submit observations to the collector using installation-bound
write credentials. They do not render the collector's state or require a viewer.

| Reporter | Status | Requirements |
| --- | --- | --- |
| [Shell](shell/README.md) | Implemented | Linux, `/proc`, `sh`, `curl`, `jq`, coreutils, `flock` |
| Native Windows | Future | Not implemented |
| Native macOS | Future | Not implemented |

A new reporter must preserve retry IDs and per-execution ordering, distinguish
fresh process observations from historical replay, and submit only allowed
metadata. Agent/PID discovery, transcript formats, local persistence, and scheduling
belong here; they must not become dependencies of the collector or a viewer.

See [the ingestion contract](../docs/client-protocol.md#reporting-observations)
and [architecture](../docs/architecture.md). Source OS limitations are independent
of the platforms on which viewer clients run.
