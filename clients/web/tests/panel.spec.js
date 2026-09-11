import { test, expect } from "@playwright/test";
const writer = "web-test-writer." + "e".repeat(43);
const key = "ai-agents.read-token.v1";
let sequence = 0;
async function post(request, path, data, token = writer) {
  const response = await request.post(path, {
    headers: { Authorization: `Bearer ${token}` },
    data: { schema_version: 1, ...data },
  });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}
async function login(page, request) {
  const link = await post(request, "/v1/browser-links", { expires_in: 600 });
  await page.goto(link.url);
  await expect(page.locator("#dashboard")).toBeVisible();
  await expect(page.locator("#connection-text")).toHaveText("LIVE CONNECTION");
  await expect(page.locator("#machine-count")).not.toHaveText("—");
  return link;
}
function event(overrides = {}) {
  const n = ++sequence;
  return {
    event_id: `web-event-${n}`,
    installation_id: "web-test-writer",
    execution_id: `web-execution-${n}`,
    run_id: `web-run-${n}`,
    run_generation: 1,
    sequence: 1,
    observed_at: Date.now(),
    agent: "codex",
    native_session_id: `019-demo-session-${n}`,
    source_event: "UserPromptSubmit",
    data: { cwd: `/home/dev/awesome-ai-agents`, model: "gpt-6-astra" },
    ...overrides,
  };
}
test("homepage explains CLI access without querying private stats", async ({
  page,
}) => {
  const privateRequests = [];
  page.on("request", (r) => {
    if (r.url().includes("/v1/")) privateRequests.push(r.url());
  });
  await page.goto("/");
  await expect(page.locator("h1").first()).toContainText(
    "Your agents are working.",
  );
  await expect(page.locator("code")).toContainText(
    "ai-agents web --expires 10m",
  );
  await expect(page.locator("#dashboard")).toBeHidden();
  expect(privateRequests).toHaveLength(0);
  await page.screenshot({ path: "test-results/homepage.png", fullPage: true });
});
test("login persists read access, strips secret, and receives live usage without polling", async ({
  page,
  request,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  const grant = await login(page, request);
  expect(new URL(page.url()).hash).toBe("");
  expect(
    requests.every((url) => !url.includes(new URL(grant.url).hash.slice(1))),
  ).toBeTruthy();
  const auth = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    key,
  );
  expect(auth.token).toBeTruthy();
  expect(auth.token).not.toBe(writer);
  const e = event();
  await post(request, "/v1/events", { events: [e] });
  await post(request, "/v1/presence", {
    observed_at: Date.now(),
    runs: [{ run_id: e.run_id, execution_id: e.execution_id, sequence: 2 }],
    usage: true,
    dropped: 0,
  });
  await post(request, "/v1/usage", {
    records: [
      {
        run_id: e.run_id,
        agent: "codex",
        provider: "openai",
        native_record_id: "web-response-" + sequence,
        stream_id: e.native_session_id,
        counter_epoch: "responses-v1",
        model: "gpt-6-astra",
        occurred_at: Date.now(),
        measurement_kind: "delta",
        counters: {
          input: 12000,
          output: 2500,
          cache_read: 6000,
          cache_write_5m: 0,
          cache_write_1h: 0,
        },
      },
    ],
  });
  await expect(page.locator("#token-count")).toHaveText("20.5K");
  await expect(page.locator("#cost-count")).toHaveText("≈ $0.25");
  await expect(page.locator("#cost-note")).toHaveText(
    "USD · estimated API token cost",
  );
  await expect(page.locator("#sessions")).toContainText("awesome-ai-agents");
  await page.reload();
  await expect(page.locator("#token-count")).toHaveText("20.5K");
  const before = requests.filter((url) => url.endsWith("/v1/snapshot")).length;
  await page.waitForTimeout(1500);
  expect(requests.filter((url) => url.endsWith("/v1/snapshot")).length).toBe(
    before,
  );
  expect(errors).toEqual([]);
});
test("shows a useful error for consumed links and logout revokes the token", async ({
  page,
  request,
}) => {
  const grant = await login(page, request);
  const auth = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    key,
  );
  await page.locator("#logout").click();
  await expect(page.locator("#welcome")).toBeVisible();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), key),
  ).toBeNull();
  const denied = await request.get("/v1/snapshot", {
    headers: { Authorization: `Bearer ${auth.token}` },
  });
  expect(denied.status()).toBe(401);
  await page.goto(grant.url);
  await expect(page.locator("#notice")).toContainText("already used");
  await expect(page.locator("#dashboard")).toBeHidden();
});
test("hidden tabs make no background requests and catch up when visible", async ({
  page,
  request,
}) => {
  await login(page, request);
  await expect(page.locator("#sessions")).toBeVisible();
  await page.clock.install();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const reads = [];
  page.on("request", (r) => {
    if (r.url().includes("/v1/")) reads.push(r.url());
  });
  await page.clock.fastForward(30 * 60000);
  expect(reads).toHaveLength(0);
  await post(request, "/v1/events", {
    events: [event({ data: { cwd: "/work/hidden-catchup" } })],
  });
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(2000);
  await expect(page.locator("#sessions")).toContainText("hidden-catchup");
  expect(reads.some((url) => url.endsWith("/v1/snapshot"))).toBe(true);
});
test("renders diverse states safely, filters sessions, and fits phone screens", async ({
  page,
  request,
}) => {
  const rows = [
    event({
      agent: "claude",
      source_event: "PermissionRequest",
      data: { cwd: "/home/dev/platform-api", model: "claude-opus-4-6" },
    }),
    event({
      data: { cwd: "/home/dev/dotfiles", model: "gpt-6-astra" },
      source_event: "Stop",
    }),
    event({ data: { cwd: "/home/dev/build-tools", model: "gpt-6-astra" } }),
    event({
      data: { cwd: "/tmp/<img src=x onerror=alert(1)>", model: "gpt-6-astra" },
    }),
  ];
  await post(request, "/v1/events", { events: rows });
  await post(request, "/v1/presence", {
    observed_at: Date.now(),
    runs: rows
      .slice(0, 3)
      .map((e) => ({
        run_id: e.run_id,
        execution_id: e.execution_id,
        sequence: 2,
      })),
    usage: true,
    dropped: 0,
  });
  await login(page, request);
  await expect(page.locator("#sessions")).toContainText("platform-api");
  await expect(page.locator("#sessions")).toContainText("needs input");
  expect(await page.locator("#sessions img").count()).toBe(0);
  await page.locator('[data-agent="claude"]').click();
  await expect(page.locator(".session")).toHaveCount(1);
  await page.locator('[data-agent="all"]').click();
  await page.locator("#search").fill("dotfiles");
  await expect(page.locator(".session")).toHaveCount(1);
  await page.locator("#search").fill("");
  await page.screenshot({
    path: "test-results/panel-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#dashboard")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: "test-results/panel-mobile.png",
    fullPage: true,
  });
});
test("retains the snapshot during an outage and reconnects after network recovery", async ({
  page,
  request,
  context,
}) => {
  await login(page, request);
  const tokens = await page.locator("#token-count").textContent();
  await context.setOffline(true);
  await page.locator("#refresh").click();
  await expect(page.locator("#notice")).toContainText("last received data");
  await expect(page.locator("#token-count")).toHaveText(tokens);
  await context.setOffline(false);
  await expect(page.locator("#connection-text")).toHaveText("LIVE CONNECTION", {
    timeout: 15000,
  });
});
