# AGENT//GRID web panel

A responsive, terminal-inspired viewer for current sessions, token usage, estimated
cost, and reporter health. The collector serves the HTML/CSS/JavaScript from
`public/` through its Workers Static Assets binding. No frontend build step,
third-party scripts, fonts, analytics, or runtime framework is required.

## Open the panel

On a configured reporting machine:

```sh
ai-agents web
ai-agents web --expires 5m
```

Open the printed URL in the browser you want to authorize. The link defaults to
10 minutes and can be set from 60 seconds to one hour (`60s`, `5m`, `1h`, or plain
seconds). It is single-use. The public Worker homepage explains this command.
The URL grants read access to the reporter's **whole workspace**; keep it private.

The browser exchanges the link for its own read token, stored in localStorage
under `ai-agents.read-token.v1`. Browser access lasts up to 30 days, bounded by
the originating reporter credential's expiry. Revisit the same Worker origin to
use that stored credential. Storage is origin-specific: the custom domain and
workers.dev hostname have separate browser logins.

Sign out revokes that browser token on the server and removes the local copy.
If the connection is unavailable, the panel asks you to retry sign-out rather
than claiming server revocation succeeded. Revoking/expiring the originating
write credential or disabling its installation also invalidates its browser
credentials. Existing operator read tokens keep their previous behavior.

## Manage tokens

Open **Tokens** in the web panel to manage your workspace credentials. Management
requires an explicitly authorized browser login:

```sh
ai-agents web --manage-tokens
```

Open the generated link in the browser you want to authorize. Existing browser
sessions and ordinary `ai-agents web` links remain read-only. The Tokens page
shows the command when the current browser lacks management permission. Management
logins retain the same single-use link, 30-day browser expiry, and parent-credential
revocation rules as normal logins; the CLI output identifies the added permission.

The Tokens page supports:

- **Create:** choose a label, read/write role, and expiration (or no expiration).
  Write tokens require an existing enabled installation. Their label defaults to
  the reported hostname (falling back to the installation label until a hostname
  is known); a custom label is preserved. The credential is shown
  once in a copyable dialog, never in token lists or localStorage. Save it before
  closing the dialog; a lost secret requires issuing a replacement token.
- **Edit:** change the label or expiration. The role and installation are fixed.
  Set an expiry within the next year, or no expiry for API tokens. Browser tokens
  remain bounded by their original 30-day lifetime and originating credential.
  Concurrent edits return a conflict so you can reload the latest metadata.
- **Delete:** confirm revocation. The token stops authenticating immediately,
  and browser credentials derived from it also lose access. The row moves to a
  **Revoked tokens** section, collapsed by default with a count of loaded revoked
  tokens. Expand it to inspect their metadata. Active and expired tokens stay in
  the main list. Revoked metadata remains for up to 30 days before maintenance
  removes it. The credential cannot be
  restored. Reporting history and usage are preserved.

The current browser token and its originating write token are protected from
editing/deletion to avoid losing the active management session. Use another
management session to change them, or Sign out to revoke the current browser.

Tokens created in the panel are independent API credentials: signing out of the
issuing browser does not revoke them. Created read tokens cannot manage tokens;
created write tokens can report for their installation and generate browser login
links (including management links), just like provisioned reporter credentials.
No management privilege is silently added to existing tokens. Token metadata is
loaded on demand, paginated at 100 rows, and never polled by the live dashboard.
The workspace limit is 256 active tokens created through this API.

## Live data

The browser creates a 60-second, single-use connection ticket with its read token,
then sends the ticket in the WebSocket subprotocol header. No persistent token or
connection ticket goes in a WebSocket URL. The subscription uses the collector's
existing revision notifications, acknowledgements, on-demand authorization
lease, and automatic ping/pong replies.

Snapshots are fetched after subscription, on changed revisions, at freshness/day
boundaries, on foreground/network recovery, or when Refresh is clicked. Requests
are coalesced, only one snapshot is in flight, and HTTP errors honor Retry-After.
There is no recurring short-interval network polling. Local timestamp/lease display
updates every 15 seconds. An outage preserves the last snapshot and visibly marks
the connection; unavailable usage is shown as `n/a`, not zero.

The panel shows server-authoritative totals in the workspace's reporting timezone.
Usage becomes visible when the reporters upload it: hooks trigger collection and
the daemon also checks local transcripts every 30 seconds. WebSocket delivery does
not turn transcript reporting into per-token streaming. The signal log records
updates observed by this browser session; it is not a stored audit/event history.

## Browser access security

The login secret is carried in a URL fragment and removed from browser history
before exchange; fragments are not sent in HTTP requests. The Worker stores hashes
of link, credential, and ticket secrets. D1 atomically claims each link and issues
one credential, including concurrent requests. Links, tickets, and expired browser
credentials have indexed, bounded maintenance cleanup. Each writer can have eight
outstanding links and 32 active browser tokens; each reader can have eight unused
connection tickets.

Browser mutations and WebSocket upgrades enforce same-origin access; APIs do not
provide cross-origin CORS access. The static panel uses a strict CSP, external
same-origin scripts/styles, no-referrer policy, and text-only insertion of session
metadata. localStorage credentials are readable by same-origin JavaScript, so
keep this origin dedicated to the collector and its reviewed frontend assets.

## Develop and test

Apply collector migrations, including `0010_browser_access.sql`, and provision
local credentials as described in the [collector guide](../../collector/README.md).
For local browsing, explicitly set the upstream origin so Wrangler generates
local login URLs and same-origin checks match the browser:

```sh
cd collector
pnpm dev --local-upstream 127.0.0.1:8787
```

Configure a reporter with `http://127.0.0.1:8787` and its local write credential,
then run `ai-agents web`. When changing the development port, change
`--local-upstream` to match. The configured production custom domain would
otherwise become Wrangler's default upstream origin.

Browser tests start their own local Worker on port 8788, apply all migrations to
an isolated `.test-state/` database, and seed test-only credentials. They cover
live usage, reload persistence, logout/replay, safe metadata rendering, filtering,
mobile overflow, and network recovery. They never use production credentials.

```sh
pnpm -C clients/web install --frozen-lockfile
pnpm -C clients/web exec playwright install chromium
pnpm -C clients/web test
```

To use a system Chromium instead of downloading a browser:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm -C clients/web test
```

Screenshots are generated in `test-results/` for visual review. Backend access
control and race tests live in `collector/test/browser.test.ts` and run with
`pnpm -C collector test`.
