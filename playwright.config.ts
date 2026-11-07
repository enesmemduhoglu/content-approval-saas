import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "@playwright/test";

export const E2E_PORT = 3111;
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5455/content_approval_e2e";
/** Test süreci de giriş kodu üretiyor (`createLoginToken`); sunucuyla AYNI anahtar şart. */
export const E2E_AUTH_SECRET = "e2e-test-secret";
export const FAKE_QSTASH_PORT = 3112;
export const FAKE_QSTASH_URL = `http://localhost:${FAKE_QSTASH_PORT}`;

/**
 * `next dev` `.env.local`'i yükler ve orada prod'un GERÇEK anahtarları duruyor
 * (QStash, R2 — prod bucket'ı, Upstash Redis, Anthropic, Blob, VAPID, Neon API).
 * Yalnızca DB'yi ezmek yetmiyordu: portal testleri prod token'ıyla QStash
 * mesajı yayınlar, R2'ye yazardı; hız sınırı sayaçları zaten prod Redis'e
 * düşüyordu. Next, süreçte TANIMLI bir anahtarı (boş string dahil) env
 * dosyasıyla ezmiyor — bu yüzden dosyalardaki her anahtar boş verilip yalnızca
 * testin ihtiyacı olanlar açıkça dolduruluyor. Liste dosyalardan okunuyor ki
 * `.env.local`'e yarın eklenecek bir sır da kendiliğinden kapansın.
 */
function blankedLocalEnv(): Record<string, string> {
  const keys = new Set<string>();
  for (const file of [".env", ".env.local", ".env.development", ".env.development.local"]) {
    if (!existsSync(file)) continue;
    for (const match of readFileSync(file, "utf8").matchAll(/^\s*(?:export\s+)?([\w.-]+)\s*=/gm)) {
      keys.add(match[1]);
    }
  }
  return Object.fromEntries([...keys].map((key) => [key, ""]));
}

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 60_000,
  // Testler aynı DB'yi ve dev sunucusunu paylaşır — sırayla koşar
  workers: 1,
  use: {
    baseURL: E2E_BASE_URL,
  },
  webServer: [
    {
      command: `node tests/e2e/fake-qstash.mjs ${FAKE_QSTASH_PORT}`,
      port: FAKE_QSTASH_PORT,
      reuseExistingServer: false,
    },
    {
      command: `npx next dev -p ${E2E_PORT}`,
      port: E2E_PORT,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...blankedLocalEnv(),
        DATABASE_URL: E2E_DATABASE_URL,
        DATABASE_URL_UNPOOLED: E2E_DATABASE_URL,
        AUTH_SECRET: E2E_AUTH_SECRET,
        ENABLE_TEST_AUTH: "1",
        APP_URL: E2E_BASE_URL,
        // Token sahte; SDK yalnızca dolu olmasını istiyor, istek sahte sunucuya gider.
        QSTASH_URL: FAKE_QSTASH_URL,
        QSTASH_TOKEN: "e2e-sahte-token",
      },
    },
  ],
});
