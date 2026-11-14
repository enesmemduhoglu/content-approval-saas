import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Uçtan uca (V11): portal ayar kaydı → QStash'e kurulan uyandırma → o saatte
// tick → yayın. Dışarı çıkan her şey (QStash, Instagram, R2, e-posta, push)
// sahte; ayar route'u, senkron, tick, kuyruk ve yayın katmanı GERÇEK.
vi.mock("@upstash/qstash", async () => (await import("@tests/helpers/qstash")).qstashModule());
vi.mock("@/lib/instagram", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/instagram")>()),
  createReelContainer: vi.fn(async () => "reel-1"),
  finalizeContainer: vi.fn(async () => ({
    state: "published",
    mediaId: "media-1",
    permalink: "https://instagram.com/reel/1/",
  })),
}));
vi.mock("@/lib/storage-r2", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage-r2")>()),
  signGetUrl: vi.fn(async () => "https://r2.example/v.mp4?X-Amz-Signature=gizli"),
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendRawEmail: vi.fn(async () => ({ sent: true })),
  sendAgencyNoticeEmail: vi.fn(async () => ({ sent: true })),
}));
vi.mock("@/lib/push", () => ({
  notifyClientUsers: vi.fn(async () => ({ sent: 0, removed: 0, failed: 0 })),
}));
vi.mock("@/lib/media-retention", () => ({
  retentionDue: vi.fn(() => false),
  runMediaRetention: vi.fn(),
}));

import { PUT as putSettings } from "@/app/api/portal/settings/route";
import { POST as tick } from "@/app/api/queue/tick/route";
import { db } from "@/lib/db";
import { createReelContainer } from "@/lib/instagram";
import { resetRateLimiter } from "@/lib/rate-limit";
import { createAgency, createInstagramClient, resetDb } from "@tests/helpers/db";
import { createClientUser, portalCookie, portalRequest } from "@tests/helpers/portal";
import { qstashMock, resetQstashMock, type PublishCall } from "@tests/helpers/qstash";
import { createQueuePost } from "@tests/helpers/queue";

const CRON_SECRET = "f".repeat(40);

/** QStash'in mesajı teslim etmesi: aynı gövde, tick'in kapısından geçen kimlik. */
const deliver = (message: PublishCall) =>
  tick(
    new Request("http://localhost/api/queue/tick", {
      method: "POST",
      headers: { authorization: `Bearer ${CRON_SECRET}` },
      body: JSON.stringify(message.body),
    })
  );

let cookie: string;
let clientId: string;

beforeEach(async () => {
  await resetDb();
  resetRateLimiter();
  resetQstashMock();
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  vi.stubEnv("QSTASH_TOKEN", "test-token");
  vi.stubEnv("APP_URL", "https://cas.test");
  const agency = await createAgency();
  const client = await createInstagramClient(agency.id);
  clientId = client.id;
  cookie = portalCookie(await createClientUser(client.id));
  await createQueuePost(agency.id, client.id);
  await createQueuePost(agency.id, client.id);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const save = (slots: string[]) =>
  putSettings(
    portalRequest("/api/portal/settings", {
      method: "PUT",
      cookie,
      body: { slots, timezone: "Europe/Istanbul", paused: false, notifyEmail: null },
    })
  );

describe("V11 akışı: kayıt → uyandırma → slot saatinde yayın", () => {
  it("saatler kaydedilir, ilk uyandırma o saatte yayınlar, tekrar teslim ikinci yayın yapmaz, saat değişikliği eskisini iptal eder", async () => {
    // 1. Kayıt: 6 günlük ufkun her 09:00 ve 20:00'ı için bir mesaj.
    expect((await save(["09:00", "20:00"])).status).toBe(200);
    const wakes = await db.queueWake.findMany({ orderBy: { at: "asc" } });
    expect(wakes.length).toBeGreaterThanOrEqual(11);
    expect(qstashMock.published.map((p) => p.notBefore! * 1000).sort((a, b) => a - b)).toEqual(
      wakes.map((w) => w.at.getTime())
    );

    // 2. QStash ilk mesajı `notBefore` anında teslim eder — saat oraya sarılır.
    // Yalnızca Date sahte; Prisma'nın zamanlayıcıları gerçek kalır.
    const first = [...qstashMock.published].sort((a, b) => a.notBefore! - b.notBefore!)[0];
    const slotAt = new Date(first.notBefore! * 1000);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(slotAt.getTime() + 15_000));

    const res = await (await deliver(first)).json();

    // 3. Yayın yapıldı, slot kaydı o anla yazıldı.
    expect(res).toMatchObject({ ok: true, published: 1 });
    const run = await db.slotRun.findFirstOrThrow({ where: { clientId } });
    expect(run).toMatchObject({ outcome: "published", slotAt });

    // 4. QStash aynı mesajı yeniden denerse (retry) ikinci yayın olmaz.
    const again = await (await deliver(first)).json();
    expect(again).toMatchObject({ published: 0 });
    expect(createReelContainer).toHaveBeenCalledTimes(1);
    expect(await db.post.count({ where: { publishStatus: "published" } })).toBe(1);

    // 5. Gerçek zamana dönülür, kullanıcı 09:00'ı 10:00 yapar: 09:00'ların
    // mesajları iptal edilir, 10:00'lar kurulur, 20:00'lara dokunulmaz.
    vi.useRealTimers();
    const old0900 = wakes.filter((w) => w.at.getUTCHours() === 6).map((w) => w.messageId);
    const before = qstashMock.published.length;

    expect((await save(["10:00", "20:00"])).status).toBe(200);

    expect(qstashMock.cancelled.sort()).toEqual([...old0900].sort());
    const after = await db.queueWake.findMany({ where: { at: { gt: new Date() } } });
    const hours = new Set(after.map((w) => w.at.getUTCHours()));
    expect(hours).toEqual(new Set([7, 17])); // İstanbul 10:00 ve 20:00 (UTC+3)
    // Yalnızca yeni saatler için mesaj atıldı.
    const fresh = qstashMock.published.slice(before);
    expect(fresh.every((p) => new Date(p.notBefore! * 1000).getUTCHours() === 7)).toBe(true);
  });
});
