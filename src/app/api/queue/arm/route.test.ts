import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@upstash/qstash", async () => (await import("@tests/helpers/qstash")).qstashModule());

import { db } from "@/lib/db";
import { createAgency, createClient, resetDb } from "@tests/helpers/db";
import { qstashMock, resetQstashMock } from "@tests/helpers/qstash";
import { createPublishSettings } from "@tests/helpers/queue";
import { POST } from "./route";

const CRON_SECRET = "a".repeat(40);
const arm = (secret: string | null = CRON_SECRET) =>
  POST(
    new Request("http://localhost/api/queue/arm", {
      method: "POST",
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    })
  );

beforeEach(async () => {
  await resetDb();
  resetQstashMock();
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  vi.stubEnv("QSTASH_TOKEN", "test-token");
  vi.stubEnv("APP_URL", "https://cas.test");
  const agency = await createAgency();
  const client = await createClient(agency.id);
  await createPublishSettings(client.id, { slots: ["09:00", "20:00"] });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/queue/arm", () => {
  it("imzasız ya da yanlış sırla 401, hiçbir şey kurulmaz", async () => {
    expect((await arm(null)).status).toBe(401);
    expect((await arm("yanlis")).status).toBe(401);
    expect(qstashMock.published).toEqual([]);
    expect(await db.queueWake.count()).toBe(0);
  });

  it("doğru sırla uyandırmaları kurar, yanıtta yalnızca sayılar", async () => {
    const res = await arm();
    const body = await res.json();

    expect(res.status).toBe(200);
    // 6 günlük ufuk × 2 slot; saat dilimine göre 12 ya da 13 an (bugünün geçmiş slotları hariç).
    expect(body).toMatchObject({ ok: true, cancelled: 0, failed: 0 });
    expect(body.armed).toBeGreaterThanOrEqual(11);
    expect(body.armed).toBeLessThanOrEqual(13);
    expect(Object.keys(body).sort()).toEqual(["armed", "cancelled", "failed", "ok", "pruned"]);
    expect(await db.queueWake.count()).toBe(body.armed);
  });

  it("ikinci çağrı mesaj atmaz", async () => {
    await arm();
    const before = qstashMock.published.length;
    const body = await (await arm()).json();
    expect(body.armed).toBe(0);
    expect(qstashMock.published).toHaveLength(before);
  });
});
