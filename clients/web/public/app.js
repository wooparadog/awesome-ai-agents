const $ = (id) => document.getElementById(id);
const KEY = "ai-agents.read-token.v1";
const integer = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
});
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
let auth = null,
  snapshot = null,
  socket = null,
  selectedAgent = "all";
let epoch = 0,
  attempts = 0,
  fetching = false,
  wanted = 0,
  retryAt = 0,
  lastFetch = 0;
let refreshTimer, reconnectTimer, heartbeatTimer, watchdogTimer, freshnessTimer;
let receivedPong = 0,
  signals = [];
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}
function connection(state, text) {
  $("connection").dataset.state = state;
  $("connection-text").textContent = text;
}
function notice(text = "") {
  $("notice").textContent = text;
  $("notice").hidden = !text;
}
function log(kind, message) {
  signals.unshift({
    time: new Date().toLocaleTimeString("en-GB"),
    kind,
    message,
  });
  signals = signals.slice(0, 40);
  $("activity").replaceChildren(
    ...signals.map((s) => {
      const row = node("div", "log-line");
      row.append(
        node("span", "log-time", s.time),
        node("span", "log-kind" + (s.kind === "WARN" ? " warn" : ""), s.kind),
        node("span", "log-message", s.message),
      );
      return row;
    }),
  );
}
function serverNow() {
  return snapshot
    ? snapshot.server_time + (Date.now() - snapshot.received_at)
    : Date.now();
}
function age(time) {
  if (!time) return "never";
  const seconds = Math.max(0, Math.floor((serverNow() - time) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
function fresh(run) {
  return run.presence_expires_at
    ? run.presence_expires_at > serverNow()
      ? "live"
      : "stale"
    : "unverified";
}
function displayName(agent) {
  return agent === "codex"
    ? "Codex"
    : agent === "claude"
      ? "Claude Code"
      : agent;
}
function cost(usage) {
  if (usage?.available && !usage.priced && !usage.dollars && usage.tokens)
    return "unpriced";
  return usage?.available
    ? `${usage.priced && usage.estimated === false ? "" : "≈ "}${money.format(usage.dollars || 0)}`
    : "n/a";
}
function updateView() {
  if (!snapshot) return;
  const runs = Object.entries(snapshot.agents).flatMap(([agent, runs]) =>
    runs.map((r) => ({ ...r, agent })),
  );
  const live = runs.filter((r) => fresh(r) === "live");
  const totals = Object.values(snapshot.cost).filter((c) => c.available);
  const tokens = totals.reduce((n, c) => n + c.tokens, 0);
  const dollars = totals.reduce((n, c) => n + c.dollars, 0);
  const priced = totals.every((c) => c.priced);
  const estimated = totals.some((c) => c.estimated !== false);
  const online = snapshot.installations.filter(
    (i) => i.last_contact_at > serverNow() - 600000,
  );
  $("live-count").textContent = String(live.length).padStart(2, "0");
  $("live-note").textContent =
    `${live.filter((r) => r.state === "busy").length} working · ${live.filter((r) => r.state === "asking").length} need attention`;
  $("token-count").textContent = totals.length ? compact.format(tokens) : "n/a";
  $("token-count").title = totals.length
    ? `${integer.format(tokens)} reported tokens`
    : "No usage reported yet";
  $("token-note").textContent = totals.length
    ? `${integer.format(tokens)} tokens ${snapshot.usage_reset_at > snapshot.from ? "since reset" : "reported"}`
    : "Awaiting usage reports";
  $("cost-count").textContent = totals.length
    ? !priced && !dollars && tokens
      ? "unpriced"
      : `${priced && !estimated ? "" : "≈ "}${money.format(dollars)}`
    : "n/a";
  $("cost-note").textContent = !priced
    ? "USD · partial token estimate"
    : estimated
      ? "USD · estimated API token cost"
      : "USD · API token cost";
  $("machine-count").textContent =
    `${online.length.toString().padStart(2, "0")} / ${snapshot.installations.length.toString().padStart(2, "0")}`;
  $("machine-note").textContent =
    online.length === snapshot.installations.length
      ? "All reporters connected"
      : `${snapshot.installations.length - online.length} reporter(s) stale`;
  $("period").textContent =
    `TODAY / ${new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: snapshot.timezone }).format(new Date(snapshot.server_time)).toUpperCase()} · ${snapshot.timezone}`;
  $("session-count").textContent = runs.length;
  const query = $("search").value.trim().toLowerCase();
  const filtered = runs.filter(
    (r) =>
      (selectedAgent === "all" || r.agent === selectedAgent) &&
      [r.cwd, r.machine, r.model, r.native_session_id].some((v) =>
        String(v || "")
          .toLowerCase()
          .includes(query),
      ),
  );
  $("sessions").replaceChildren(
    ...filtered.map((r) => {
      const row = node("article", "session");
      const top = node("div", "session-top");
      const title = node("div", "session-title");
      const cwd = r.cwd || "";
      const project =
        cwd.split("/").filter(Boolean).at(-1) || "Untitled session";
      title.append(
        node("div", "project", project),
        node(
          "div",
          "session-meta",
          `${r.machine || r.installation_id} / ${displayName(r.agent)} / ${r.usage?.model || r.model || "model unknown"}`,
        ),
      );
      title.title = cwd;
      const state = fresh(r) === "live" ? r.state : fresh(r);
      const badge = node("span", "badge " + state);
      badge.append(
        node("span", "dot"),
        node(
          "span",
          "",
          { busy: "working", asking: "needs input" }[state] || state,
        ),
      );
      top.append(
        node("div", "agent-icon " + r.agent, r.agent === "claude" ? "✳" : ">_"),
        title,
        badge,
      );
      const bottom = node("div", "session-bottom");
      const tokenCell = node("span");
      tokenCell.append(
        node(
          "strong",
          "",
          r.usage?.available ? compact.format(r.usage.tokens) : "n/a",
        ),
        document.createTextNode(" tokens"),
      );
      bottom.append(
        tokenCell,
        node("strong", "", cost(r.usage)),
        node("span", "session-age", age(r.last_activity_at)),
      );
      row.append(
        top,
        bottom,
        node(
          "div",
          "session-identity",
          `${r.native_session_id || r.id} · ${fresh(r) === "live" ? "process verified" : fresh(r)}`,
        ),
      );
      return row;
    }),
  );
  if (!filtered.length)
    $("sessions").append(
      node(
        "div",
        "empty",
        runs.length
          ? "No sessions match this filter."
          : "No active sessions. Start an agent on a connected machine.",
      ),
    );
  const usageRows = Object.entries(snapshot.cost).sort(
    (a, b) => b[1].tokens - a[1].tokens,
  );
  $("agent-usage").replaceChildren(
    ...usageRows.map(([agent, usage]) => {
      const row = node("div", "usage-row");
      const top = node("div", "usage-top");
      const name = node("span", "usage-name " + agent);
      name.append(
        node("span", "dot"),
        document.createTextNode(displayName(agent)),
      );
      top.append(name, node("span", "", cost(usage)));
      const bar = node("div", "usage-bar " + agent);
      const progress = node("progress");
      progress.max = Math.max(tokens, 1);
      progress.value = usage.tokens;
      progress.setAttribute("aria-label", `${displayName(agent)} token share`);
      bar.append(progress);
      const bottom = node("div", "usage-bottom");
      bottom.append(
        node(
          "span",
          "",
          usage.available
            ? `${integer.format(usage.tokens)} tokens`
            : "No usage yet",
        ),
        node(
          "span",
          "",
          tokens
            ? `${Math.round((usage.tokens / tokens) * 100)}% of tokens`
            : "—",
        ),
      );
      row.append(top, bar, bottom);
      return row;
    }),
  );
  if (!usageRows.length)
    $("agent-usage").append(
      node("div", "empty", "Usage will appear after the first report."),
    );
  $("machines").replaceChildren(
    ...snapshot.installations.map((i) => {
      const row = node("div", "machine");
      const alive = i.last_contact_at > serverNow() - 600000;
      const details = node("div", "machine-details");
      details.append(
        node("div", "machine-name", i.label || i.id),
        node(
          "div",
          "machine-note",
          !alive
            ? "Reporter stale"
            : i.capabilities.dropped
              ? `${i.capabilities.dropped} dropped records`
              : i.capabilities.usage
                ? "Usage coverage complete"
                : "Usage coverage incomplete",
        ),
      );
      row.append(
        node("span", "machine-led" + (alive ? "" : " offline")),
        details,
        node("span", "machine-age", age(i.last_contact_at)),
      );
      return row;
    }),
  );
  if (!snapshot.installations.length)
    $("machines").append(node("div", "empty", "No reporters registered."));
  const incomplete =
    !snapshot.usage_complete ||
    totals.some((c) => !c.complete) ||
    online.length !== snapshot.installations.length;
  const reasons = snapshot.installations
    .filter(
      (i) =>
        !i.capabilities.usage ||
        i.capabilities.dropped ||
        i.last_contact_at <= serverNow() - 600000,
    )
    .map((i) => i.label || i.id);
  $("coverage").textContent = incomplete
    ? `△ Usage coverage incomplete${reasons.length ? " · Check " + reasons.join(", ") : ""}. Totals reflect available reports.`
    : "✓ Usage coverage complete · All reporters accounted for";
  $("footer-status").textContent =
    `REV ${snapshot.revision} · UPDATED ${age(snapshot.server_time).toUpperCase()} · READ ONLY`;
}
class ApiError extends Error {
  constructor(status, message, retry = 0) {
    super(message);
    this.status = status;
    this.retry = retry;
  }
}
async function api(path, payload, credential = auth?.token) {
  const headers = {};
  if (credential) headers.Authorization = `Bearer ${credential}`;
  if (payload) headers["Content-Type"] = "application/json";
  const response = await fetch(path, {
    method: payload ? "POST" : "GET",
    headers,
    body: payload
      ? JSON.stringify({ schema_version: 1, ...payload })
      : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
    credentials: "omit",
    redirect: "error",
  });
  const value = await response.json();
  if (!response.ok) {
    const retry = Number(response.headers.get("Retry-After")) || 0;
    if ([429, 503].includes(response.status))
      retryAt = Math.max(retryAt, Date.now() + Math.max(1, retry) * 1000);
    throw new ApiError(response.status, value.error || "Request failed", retry);
  }
  return value;
}
function clearTimers() {
  clearTimeout(refreshTimer);
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  clearTimeout(watchdogTimer);
  clearInterval(freshnessTimer);
  refreshTimer = null;
  reconnectTimer = null;
}
function forget(message) {
  epoch++;
  auth = null;
  clearTimers();
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* The in-memory credential is still cleared. */
  }
  snapshot = null;
  signals = [];
  $("dashboard").hidden = true;
  $("welcome").hidden = false;
  $("logout").hidden = true;
  $("sessions").replaceChildren();
  $("activity").replaceChildren();
  connection("offline", "ACCESS REQUIRED");
  notice(message);
}
function authFailure(error) {
  if (error instanceof ApiError && [401, 403].includes(error.status)) {
    forget(
      "Browser access expired or was revoked. Generate a new login link with ai-agents web.",
    );
    return true;
  }
  return false;
}
function scheduleRefresh(delay = 120) {
  if (!auth || document.hidden) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(
    refresh,
    Math.max(delay, retryAt - Date.now(), 500 - (Date.now() - lastFetch)),
  );
}
async function refresh() {
  if (!auth || fetching || document.hidden) return;
  if (Date.now() < retryAt) {
    scheduleRefresh();
    return;
  }
  fetching = true;
  const current = epoch;
  lastFetch = Date.now();
  $("refresh").disabled = true;
  let failed = false;
  try {
    const value = await api("/v1/snapshot");
    if (current !== epoch) return;
    const previous = snapshot;
    if (!previous || value.revision >= previous.revision) {
      snapshot = { ...value, received_at: Date.now() };
      if (previous && value.revision > previous.revision) {
        const before = new Map(
          Object.values(previous.agents)
            .flat()
            .map((r) => [r.id, r.state]),
        );
        const changed = Object.values(value.agents)
          .flat()
          .filter((r) => before.get(r.id) !== r.state);
        if (changed.length)
          for (const r of changed.slice(0, 4))
            log(
              "STATE",
              `${r.machine || r.installation_id} / ${r.agent || "agent"} → ${r.state}`,
            );
        else
          log(
            "SYNC",
            `Revision ${value.revision} · usage and presence updated`,
          );
      } else if (!previous)
        log(
          "SYNC",
          `Snapshot received · ${value.installations.length} machines registered`,
        );
      updateView();
    }
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "ack", revision: snapshot.revision }));
      connection("live", "LIVE CONNECTION");
      notice();
    }
    // Server time boundaries include local lease expiry and reporting midnight.
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(
      () => {
        updateView();
        scheduleRefresh(0);
      },
      Math.max(
        1000,
        Math.min(
          86400000,
          snapshot.next_refresh_at - snapshot.server_time + 100,
        ),
      ),
    );
  } catch (error) {
    failed = true;
    if (current !== epoch || authFailure(error)) return;
    connection("offline", "SNAPSHOT DELAYED");
    notice(
      `${error.message}. Showing the last received data; retrying automatically.`,
    );
    scheduleRefresh(Math.max(error.retry * 1000 || 0, 10000));
  } finally {
    fetching = false;
    $("refresh").disabled = false;
    if (!failed && current === epoch && snapshot && wanted > snapshot.revision)
      scheduleRefresh();
  }
}
function reconnect(delay) {
  if (!auth || document.hidden) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, Math.max(delay, retryAt - Date.now()));
}
async function connect() {
  if (!auth || document.hidden) return;
  if (auth.expires_at <= Date.now()) {
    forget("Browser access expired. Generate a new link with ai-agents web.");
    return;
  }
  const current = epoch;
  connection("connecting", attempts ? "RECONNECTING" : "CONNECTING");
  try {
    const { ticket } = await api("/v1/browser-ticket", {});
    if (current !== epoch || document.hidden) return;
    const url = new URL("/v1/browser-subscribe", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url, ["ai-agents.v1", "ticket." + ticket]);
    socket = ws;
    watchdogTimer = setTimeout(() => ws.close(), 10000);
    ws.onmessage = (event) => {
      if (current !== epoch || socket !== ws) return;
      if (event.data === "pong") {
        receivedPong = Date.now();
        return;
      }
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        ws.close();
        return;
      }
      if (message.type === "ready") {
        clearTimeout(watchdogTimer);
        attempts = 0;
        receivedPong = Date.now();
        connection("live", "LIVE CONNECTION");
        log("LINK", "Subscription established · listening for changes");
        scheduleRefresh(0);
        clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => {
          if (Date.now() - receivedPong > 50000) ws.close();
          else if (ws.readyState === WebSocket.OPEN) ws.send("ping");
        }, 20000);
      } else if (
        message.type === "state.changed" &&
        Number.isSafeInteger(message.revision)
      ) {
        wanted = Math.max(wanted, message.revision);
        if (snapshot && snapshot.revision >= wanted)
          ws.send(JSON.stringify({ type: "ack", revision: snapshot.revision }));
        else scheduleRefresh();
      }
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      if (current !== epoch || socket !== ws) return;
      clearTimeout(watchdogTimer);
      clearInterval(heartbeatTimer);
      socket = null;
      connection("offline", "RECONNECTING");
      log("WARN", "Live connection paused · reconnecting");
      if (!snapshot) scheduleRefresh(0);
      reconnect(
        Math.min(60000, 1000 * 2 ** Math.min(attempts++, 6)) +
          Math.random() * 1000,
      );
    };
  } catch (error) {
    if (current !== epoch || authFailure(error)) return;
    connection("offline", "RECONNECTING");
    notice(`${error.message}. Connection will retry automatically.`);
    if (!snapshot) scheduleRefresh(0);
    reconnect(
      Math.max(
        error.retry * 1000 || 0,
        Math.min(60000, 1000 * 2 ** Math.min(attempts++, 6)),
      ),
    );
  }
}
function start() {
  $("welcome").hidden = true;
  $("dashboard").hidden = false;
  $("logout").hidden = false;
  $("workspace").textContent = `WORKSPACE / ${auth.workspace_id.toUpperCase()}`;
  log("AUTH", "Read-only browser access established");
  freshnessTimer = setInterval(updateView, 15000);
  connect();
}
$("copy-command").onclick = async () => {
  try {
    await navigator.clipboard.writeText("ai-agents web --expires 10m");
    $("copy-command").textContent = "COPIED";
    setTimeout(() => {
      $("copy-command").textContent = "COPY";
    }, 1500);
  } catch {
    notice(
      "Run this command on your reporting machine: ai-agents web --expires 10m",
    );
  }
};
$("logout").onclick = async () => {
  const token = auth?.token;
  try {
    await api("/v1/browser-logout", {}, token);
    forget("Signed out. Generate a new link to reconnect.");
  } catch (error) {
    if (!authFailure(error))
      notice(
        "Could not revoke browser access. Check the connection and try signing out again.",
      );
  }
};
$("refresh").onclick = () => scheduleRefresh(0);
$("search").oninput = updateView;
$("agent-tabs").onclick = (event) => {
  const button = event.target.closest("[data-agent]");
  if (!button) return;
  selectedAgent = button.dataset.agent;
  for (const tab of $("agent-tabs").children) {
    const active = tab === button;
    tab.classList.toggle("selected", active);
    tab.setAttribute("aria-pressed", String(active));
  }
  updateView();
};
addEventListener("online", () => {
  if (auth) {
    if (!socket) reconnect(0);
    scheduleRefresh(0);
  }
});
addEventListener("storage", (event) => {
  if (event.key === KEY && event.newValue === null)
    forget("Signed out in another tab.");
});
addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearTimeout(refreshTimer);
    clearTimeout(reconnectTimer);
    clearTimeout(watchdogTimer);
    clearInterval(heartbeatTimer);
    const old = socket;
    socket = null;
    old?.close();
    if (auth) connection("offline", "PAUSED WHILE HIDDEN");
  } else if (auth) {
    updateView();
    // Subscribe first, then fetch a new snapshot: revisions changed while hidden
    // must not be lost between a snapshot read and connection establishment.
    if (!socket) reconnect(0);
    else scheduleRefresh(0);
  }
});
async function boot() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const login = fragment.get("token");
  if (location.hash)
    history.replaceState(
      null,
      "",
      location.pathname === "/login" ? "/" : location.pathname,
    );
  if (login) {
    connection("connecting", "AUTHORIZING");
    notice("Establishing browser access…");
    try {
      // Check storage before consuming a single-use link.
      localStorage.setItem(KEY + ".check", "1");
      localStorage.removeItem(KEY + ".check");
      const value = await api("/v1/browser-login", { token: login }, null);
      localStorage.setItem(KEY, JSON.stringify(value));
      auth = value;
      history.replaceState(null, "", "/");
      notice();
      start();
    } catch (error) {
      connection("offline", "ACCESS REQUIRED");
      notice(
        `${error.message}. Generate a fresh link with ai-agents web; browser storage must be enabled.`,
      );
    }
    return;
  }
  try {
    const stored = JSON.parse(localStorage.getItem(KEY));
    if (
      stored?.token &&
      typeof stored.workspace_id === "string" &&
      stored.expires_at > Date.now()
    )
      auth = stored;
    else if (stored) localStorage.removeItem(KEY);
  } catch {
    notice(
      "Browser storage is unavailable. Enable local storage to keep read-only access.",
    );
  }
  if (auth) start();
  else if (location.pathname === "/login")
    notice(
      "This login link is incomplete. Generate a new one with ai-agents web.",
    );
}
boot();
