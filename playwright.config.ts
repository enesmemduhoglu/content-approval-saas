import { defineConfig } from "@playwright/test";

export const E2E_PORT = 3111;
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5455/content_approval_e2e";

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 60_000,
  // Testler aynı DB'yi ve dev sunucusunu paylaşır — sırayla koşar
  workers: 1,
  use: {
    baseURL: E2E_BASE_URL,
  },
  webServer: {
    command: `npx next dev -p ${E2E_PORT}`,
    port: E2E_PORT,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: E2E_DATABASE_URL,
      AUTH_SECRET: "e2e-test-secret",
      ENABLE_TEST_AUTH: "1",
      APP_URL: E2E_BASE_URL,
    },
  },
});
