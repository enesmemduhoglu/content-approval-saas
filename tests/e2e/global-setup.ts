import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { E2E_DATABASE_URL } from "../../playwright.config";

// 1x1 kırmızı PNG — post oluşturma formu için upload fixture'ı
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export default async function globalSetup() {
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL },
  });

  const db = new PrismaClient({ datasourceUrl: E2E_DATABASE_URL });
  try {
    await db.$executeRawUnsafe(
      'TRUNCATE TABLE "ApprovalAudit", "ApprovalLink", "Post", "Client", "Agency" CASCADE'
    );
  } finally {
    await db.$disconnect();
  }

  const fixturesDir = path.join(__dirname, "fixtures");
  mkdirSync(fixturesDir, { recursive: true });
  writeFileSync(
    path.join(fixturesDir, "test-image.png"),
    Buffer.from(TINY_PNG_BASE64, "base64")
  );
}
