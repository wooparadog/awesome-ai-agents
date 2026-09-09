import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: { fileParallelism: false },
  define: {
    TEST_MIGRATIONS: JSON.stringify(await readD1Migrations("migrations")),
  },
});
