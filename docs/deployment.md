# Hosted deployment

The collector is live at [ai-agents-collector.stdimg.workers.dev](https://ai-agents-collector.stdimg.workers.dev).
All application endpoints require authentication; opening the URL without a token returns 401.

| Resource | Value |
| --- | --- |
| Worker | `ai-agents-collector` |
| Deployed version | `f13c7c22-8ddc-4613-aad2-a7f70ea2dc5c` |
| Initial deployment | 2026-09-09, 05:22 UTC |
| D1 database | `ai-agents` |
| D1 ID | `5104c85f-ece5-4bad-b122-6145081fd0b7` |
| Database region | APAC |
| Subscription class | `Subscriptions`, SQLite-backed, hibernating WebSockets |
| Maintenance schedule | Every minute |
| Machine reconciliation | At least five minutes between runs |
| Presence freshness | Ten minutes |
| Workspace | `personal` |
| Initial reporter installation | `desktop` |

The account and database identifiers are recorded in `collector/wrangler.jsonc`.
Local development and tests still use local storage unless remote operations are explicitly requested.

## Credentials and connecting clients

Initial credentials were generated privately on the deploying machine under:

```text
~/.config/ai-agents/collector/production/
  reader/credential.token       read access for viewers
  reader/identity.json
  desktop/credential.token      write access bound to installation desktop
  desktop/identity.json
```

Token files have mode 0600 and are not in the repository. The database contains only token hashes.
Use the read token with a viewer and the desktop write token with the `desktop` reporter installation.
Provision separate write credentials for additional installations rather than copying one machine's identity.

Deployment does not install hooks, change the desktop widget, or enable a local reconciliation timer.
See the [reporter guide](../reporters/shell/README.md) and
[AwesomeWM client guide](../clients/awesomewm/README.md) for those steps.

## Publishing updates

From `collector/`, after reviewing changes and running checks:

```sh
pnpm check
pnpm test
pnpm exec wrangler deploy --dry-run
pnpm exec wrangler d1 migrations apply ai-agents --remote
pnpm exec wrangler deploy
```

For additional credentials, the provisioner generates a private SQL file without changing the database
unless `--local` is supplied. Apply the generated SQL to the intended remote database explicitly:

```sh
pnpm provision --workspace personal --installation another-machine \
  --scope write --output /private/new-credential-directory
pnpm exec wrangler d1 execute ai-agents --remote \
  --file /private/new-credential-directory/provision.sql
```

The first remote migration exposed a parsing difference between local execution and D1's remote SQL endpoint.
Migration `0001.sql` now parenthesizes `CASE` expressions to keep trigger bodies intact.
All four migrations applied successfully; the collector tests include a regression check for swallowed DDL statements.

On September 9, migrations `0005_codex_responses.sql`, `0006_astra_prices.sql`,
`0007_claude_usage_duplicates.sql`, and `0008_codex_response_cutover.sql` were also applied remotely. They recover exact
Codex response accounting, add published Astra API estimates, and tolerate repeated
Claude content-block timestamps without double counting. Updated reporters are
installed on Desktop, `yoga-arch`, and `karry`. The Worker now checks each distinct
run's ownership once per usage request, avoiding repeated database round trips
for batches from the same transcript. Earlier cumulative history is retained when
a thread spans an upgrade to per-response records.

Live verification on `yoga-arch` confirmed the running AwesomeWM widget receives
three live sessions, zero stale/unverified sessions, complete usage coverage, and
priced totals for both agents. All three reporter outboxes and quarantine queues
were empty; recovered Claude warning markers were archived after acknowledgement.

## Verification

The deployed service passed these checks:

- Missing credentials return 401; write credentials cannot read snapshots (403).
- A read credential returns the initialized personal workspace (200).
- Authenticated WebSocket upgrade returns 101 and the `ready` message.
- Text `ping` receives the runtime's `pong` response.
- After an idle interval, lifecycle ingestion, duplicate retry, fresh presence, and usage ingestion succeed
  and produce a WebSocket invalidation and updated snapshot in an isolated verification workspace.

The verification workspace and its credentials were removed after testing. These checks verify live connectivity
and notification behavior; they do not measure billing or directly observe the runtime's internal hibernation decisions.

This machine requires its outbound HTTPS proxy to reach the hosted WebSocket. The default GLib proxy resolver
failed its direct TLS connection, so the live WebSocket check explicitly used the existing proxy.
The unmodified AwesomeWM smoke test did not connect with that default resolver; configure the desktop's proxy
resolver before using it from this network. No TLS verification was disabled.

The repository was not pushed as part of deployment.
