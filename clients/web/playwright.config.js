import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:8788",
    viewport: { width: 1440, height: 1100 },
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
      args: ["--no-sandbox"],
    },
  },
  webServer: {
    command: "node tests/serve.mjs",
    url: "http://127.0.0.1:8788",
    timeout: 120000,
    reuseExistingServer: false,
  },
});
