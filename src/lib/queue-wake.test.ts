import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@upstash/qstash", async () => (await import("@tests/helpers/qstash")).qstashModule());
vi.mock("@/lib/alerts", () => ({ sendAlert: vi.fn(async () => undefined) }));

import { sendAlert } from "@/lib/alerts";
import { db } from "@/lib/db";
import { scheduleFollowUp, syncQueueWakes } from "@/lib/queue-wake";
import { createAgency, createClient, resetDb } from "@tests/helpers/db";
import { qstashMock, resetQstashMock } from "@tests/helpers/qstash";
import { createPublishSettings } from "@tests/helpers/queue";

// Pazartesi 08:00 İstanbul. Yalnızca Pazartesi slotları: 6 günlük ufukta tam
// iki uyandırma (bugün 09:00 ve 20:00), sayımlar elle doğrulanabilir kalsın.
const NOW = new Date("2026-11-02T05:00:00Z");
const AT_0900 = new Date("2026-11-02T06:00:00Z");
const AT_1000 = new Date("2026-11-02T07:00:00Z");
const AT_2000 = new Date("2026-11-02T17:00:00Z");

let clientId: string;

beforeEach(async () => {
  await resetDb();
  resetQstashMock();
  vi.mocked(sendAlert).mockClear();
  vi.stubEnv("QSTASH_TOKEN", "test-token");
  vi.stubEnv("APP_URL", "https://cas.test/");
  const agency = await createAgency();
  clientId = (await createClient(agency.id)).id;
  await createPublishSettings(clientId, { slots: ["09:00", "20:00"], days: [1] });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const wakes = async () =>
  (await db.queueWake.findMany({ orderBy: { at: "asc" } })).map((w) => ({
    at: w.at.toISOString(),
    messageId: w.messageId,
  }));

describe("syncQueueWakes", () => {
  it("ilk senkron her slot anı için bir mesaj kurar ve satırı messageId ile yazar", async () => {
    const result = await syncQueueWakes(NOW);

    expect(result).toMatchObject({ armed: 2, cancelled: 0, failed: 0 });
    // Kurulum paralel — sıraya değil kümeye bak.
    const byTime = [...qstashMock.published].sort((a, b) => a.notBefore! - b.notBefore!);
    expect(byTime).toEqual([
      expect.objectContaining({
        url: "https://cas.test/api/queue/tick",
        body: { kind: "slot" },
        notBefore: AT_0900.getTime() / 1000,
        retries: 3,
      }),
      expect.objectContaining({ notBefore: AT_2000.getTime() / 1000 }),
    ]);
    const rows = await wakes();
    expect(rows.map((w) => w.at)).toEqual([AT_0900.toISOString(), AT_2000.toISOString()]);
    expect(new Set(rows.map((w) => w.messageId))).toEqual(new Set(["msg-1", "msg-2"]));
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("ikinci senkron hiç mesaj atmaz — günlük senkron kotayı şişirmez", async () => {
    await syncQueueWakes(NOW);
    const second = await syncQueueWakes(NOW);

    expect(second).toMatchObject({ armed: 0, cancelled: 0, failed: 0 });
    expect(qstashMock.published).toHaveLength(2);
  });

  it("saat 09:00 → 10:00 değişince eski mesaj iptal edilir, yeni saat kurulur", async () => {
    await syncQueueWakes(NOW);
    const old0900 = (await wakes()).find((w) => w.at === AT_0900.toISOString())!.messageId;
    await db.publishSettings.update({ where: { clientId }, data: { slots: ["10:00", "20:00"] } });

    const result = await syncQueueWakes(NOW);

    expect(result).toMatchObject({ armed: 1, cancelled: 1, failed: 0 });
    expect(qstashMock.cancelled).toEqual([old0900]);
    expect((await wakes()).map((w) => w.at)).toEqual([AT_1000.toISOString(), AT_2000.toISOString()]);
  });

  it("mesaj atılamazsa satır geri alınır, uyarı gider; sonraki senkron yeniden kurar", async () => {
    qstashMock.failPublishAfter = 1; // ilk mesaj gider, ikincisi patlar

    const failed = await syncQueueWakes(NOW);

    expect(failed).toMatchObject({ armed: 1, failed: 1 });
    // Hangisinin patladığı paralel sıraya bağlı; önemli olan biri kurulu, diğeri geri alınmış.
    expect(await wakes()).toHaveLength(1);
    expect((await wakes())[0].messageId).not.toBeNull();
    expect(sendAlert).toHaveBeenCalledWith(
      "queue:wake:sync",
      expect.any(String),
      expect.objectContaining({ failed: 1 })
    );

    qstashMock.failPublishAfter = null;
    const retry = await syncQueueWakes(NOW);

    expect(retry).toMatchObject({ armed: 1, failed: 0 });
    expect((await wakes()).map((w) => w.at)).toEqual([AT_0900.toISOString(), AT_2000.toISOString()]);
  });

  it("QStash tamamen çökse de throw etmez", async () => {
    qstashMock.failPublishAfter = 0;
    await expect(syncQueueWakes(NOW)).resolves.toMatchObject({ armed: 0, failed: 2 });
    expect(await db.queueWake.count()).toBe(0);
  });

  it("iptal patlarsa satır yine silinir, senkron sürer", async () => {
    await syncQueueWakes(NOW);
    await db.publishSettings.update({ where: { clientId }, data: { slots: ["20:00"] } });
    qstashMock.failCancel = true;

    const result = await syncQueueWakes(NOW);

    expect(result).toMatchObject({ cancelled: 1, failed: 0 });
    expect((await wakes()).map((w) => w.at)).toEqual([AT_2000.toISOString()]);
  });

  it("eşzamanlı iki senkron bir an için yalnızca bir mesaj atar", async () => {
    const [a, b] = await Promise.all([syncQueueWakes(NOW), syncQueueWakes(NOW)]);

    expect(a.armed + b.armed).toBe(2);
    expect(qstashMock.published).toHaveLength(2);
    expect(new Set(qstashMock.published.map((p) => p.notBefore)).size).toBe(2);
  });

  it("bir günden eski satırları budar, yakın geçmişi bırakır", async () => {
    await db.queueWake.createMany({
      data: [
        { at: new Date(NOW.getTime() - 2 * 86_400_000), messageId: "eski" },
        { at: new Date(NOW.getTime() - 3_600_000), messageId: "yakin" },
      ],
    });

    const result = await syncQueueWakes(NOW);

    expect(result.pruned).toBe(1);
    expect((await wakes()).map((w) => w.messageId)).toContain("yakin");
    // Geçmişteki satır "istenmeyen gelecek" sayılıp iptal edilmez.
    expect(qstashMock.cancelled).toEqual([]);
  });

  it("mesajı yazılmamış eski (yetim) satır yeniden kurulur, tazesine dokunulmaz", async () => {
    // Senkron satırı sahiplendi, mesajı atamadan öldü (zaman aşımı).
    await db.queueWake.create({
      data: { at: AT_0900, messageId: null, createdAt: new Date(Date.now() - 5 * 60_000) },
    });
    // Başka bir senkron şu an kuruyor: taze, mesajsız.
    await db.queueWake.create({ data: { at: AT_2000, messageId: null } });

    const result = await syncQueueWakes(NOW);

    expect(result).toMatchObject({ armed: 1, failed: 0 });
    expect(qstashMock.published.map((p) => p.notBefore)).toEqual([AT_0900.getTime() / 1000]);
    const rows = await wakes();
    expect(rows.find((w) => w.at === AT_0900.toISOString())?.messageId).toBe("msg-1");
    expect(rows.find((w) => w.at === AT_2000.toISOString())?.messageId).toBeNull();
  });

  it("duraklatılmış müşteri için de kurar", async () => {
    await db.publishSettings.update({ where: { clientId }, data: { paused: true } });
    expect((await syncQueueWakes(NOW)).armed).toBe(2);
  });

  it("QSTASH_TOKEN ya da APP_URL yoksa atlar, DB'ye yazmaz", async () => {
    vi.stubEnv("QSTASH_TOKEN", "");
    const noToken = await syncQueueWakes(NOW);
    vi.stubEnv("QSTASH_TOKEN", "test-token");
    vi.stubEnv("APP_URL", "");
    const noUrl = await syncQueueWakes(NOW);

    expect(noToken.skipped).toBeDefined();
    expect(noUrl.skipped).toBeDefined();
    expect(qstashMock.published).toEqual([]);
    expect(await db.queueWake.count()).toBe(0);
  });
});

describe("scheduleFollowUp", () => {
  it("gecikmeli follow mesajı ve kovaya bağlı tekilleştirme kimliği atar", async () => {
    expect(await scheduleFollowUp(120, "test")).toBe(true);

    expect(qstashMock.published).toEqual([
      expect.objectContaining({
        url: "https://cas.test/api/queue/tick",
        body: { kind: "follow" },
        delay: 120,
        deduplicationId: expect.stringMatching(/^follow-120-\d+$/),
      }),
    ]);
  });

  it("patlarsa throw etmez, false döner ve uyarır", async () => {
    qstashMock.failPublishAfter = 0;
    expect(await scheduleFollowUp(60, "test")).toBe(false);
    expect(sendAlert).toHaveBeenCalledWith("queue:wake:follow", expect.any(String), {
      reason: "test",
    });
  });

  it("yapılandırma yoksa false, istek yok", async () => {
    vi.stubEnv("QSTASH_TOKEN", "");
    expect(await scheduleFollowUp(60, "test")).toBe(false);
    expect(qstashMock.published).toEqual([]);
  });
});
