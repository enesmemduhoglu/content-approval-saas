import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5455/content_approval_test";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@tests": path.resolve(__dirname, "tests"),
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      AUTH_SECRET: "test-secret",
    },
    globalSetup: "./tests/vitest.global-setup.ts",
    // Integration testleri tek DB paylaşır — dosyalar sırayla çalışır
    fileParallelism: false,
  },
});
