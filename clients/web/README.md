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

## Live data

The browser creates a 60-second, single-use connection ticket with its read token,
then sends the ticket in the WebSocket subprotocol header. No persistent token or
connection ticket goes in a WebSocket URL. The subscription uses the collector's
existing revision notifications, acknowledgements, five-minute authorization
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
