import { beforeEach, describe, expect, it, vi } from "vitest";

// V12 — reklam saati (K36). `route.test.ts` ile aynı sınır: Instagram, R2
// imzası, e-posta ve push dışarı çıkmaz; kararı veren katmanlar (ads.ts,
// queue-db.ts, publish-post.ts) GERÇEK.
vi.mock("@/lib/instagram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/instagram")>();
  return {
    ...actual,
    publishToInstagram: vi.fn(),
    checkMediaLiveness: vi.fn(),
    createReelContainer: vi.fn(),
    finalizeContainer: vi.fn(),
  };
});
vi.mock("@/lib/storage-r2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage-r2")>();
  return { ...actual, signGetUrl: vi.fn() };
});
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendRawEmail: vi.fn(), sendAgencyNoticeEmail: vi.fn() };
});
vi.mock("@/lib/push", () => ({
  notifyClientUsers: vi.fn(async () => ({ sent: 1, removed: 0, failed: 0 })),
}));
vi.mock("@/lib/media-retention", () => ({
  retentionDue: vi.fn(() => false),
  runMediaRetention: vi.fn(async () => ({ archived: 0, purged: 0, failed: 0 })),
}));
vi.mock("@upstash/qstash", async () => (await import("@tests/helpers/qstash")).qstashModule());
vi.mock("@/lib/db-health", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db-health")>()),
  reportCrash: vi.fn(async () => undefined),
}));

import { POST } from "./route";
import { db } from "@/lib/db";
import { notifyClientUsers } from "@/lib/push";
import { sendAgencyNoticeEmail, sendRawEmail } from "@/lib/email";
import {
  IGError,
  createReelContainer,
  finalizeContainer,
  publishToInstagram,
} from "@/lib/instagram";
import { signGetUrl } from "@/lib/storage-r2";
import { AD_POOL_EMPTY_SUBJECT } from "@/lib/email-queue";
import { resetQstashMock } from "@tests/helpers/qstash";
import { createAgency, createClient, createInstagramClient, resetDb } from "@tests/helpers/db";
import {
  createAdPost,
  createPublishSettings,
  createPublishedVideo,
  createQueuePost,
  enableAds,
  slotMinutesAgo,
} from "@tests/helpers/queue";

const mockPublish = vi.mocked(publishToInstagram);
const mockSign = vi.mocked(signGetUrl);
const mockRaw = vi.mocked(sendRawEmail);
const mockPush = vi.mocked(notifyClientUsers);

const CRON_SECRET = "q".repeat(40);
const SIGNED = "https://r2.example/clients/x/ads/a.jpg?X-Amz-Signature=gizli";

const tick = () =>
  POST(
    new Request("http://localhost/api/queue/tick", {
      method: "POST",
      headers: { authorization: `Bearer ${CRON_SECRET}` },
      body: JSON.stringify({ kind: "slot" }),
    })
  );

const subjects = () => mockRaw.mock.calls.map((call) => call[0].subject);
const adRuns = (clientId: string) =>
  db.slotRun.findMany({ where: { clientId, kind: "ad" }, orderBy: { slotAt: "asc" } });

let mediaCounter = 0;

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  vi.stubEnv("APP_URL", "https://app.example");
  vi.stubEnv("QSTASH_TOKEN", "test-token");
  resetQstashMock();
  mockRaw.mockResolvedValue({ sent: true });
  vi.mocked(sendAgencyNoticeEmail).mockResolvedValue({ sent: true });
  mockSign.mockResolvedValue(SIGNED);
  mockPublish.mockImplementation(async () => ({
    mediaId: `m-${++mediaCounter}`,
    permalink: `https://instagram.com/p/${mediaCounter}/`,
  }));
  vi.mocked(createReelContainer).mockResolvedValue("reel-1");
  vi.mocked(finalizeContainer).mockResolvedValue({
    state: "published",
    mediaId: "reel-media",
    permalink: "https://instagram.com/reel/1/",
  });
});

/**
 * Instagram bağlı müşteri; video slotu 6 saat sonra (vadesiz), reklam saati 5
 * dk önce. Sayaç 1 gün önce başladı, hedef `nextAfter`; `published` video o
 * aralıkta yayınlandı.
 */
async function seed(
  options: {
    published?: number;
    nextAfter?: number | null;
    countFrom?: Date | null;
    paused?: boolean;
    instagram?: boolean;
    adMinutesAgo?: number;
    videoSlotSameAsAd?: boolean;
  } = {}
) {
  const agency = await createAgency();
  const client =
    options.instagram === false
      ? await createClient(agency.id)
      : await createInstagramClient(agency.id);
  const ad = slotMinutesAgo(options.adMinutesAgo ?? 5);
  await createPublishSettings(client.id, {
    slots: [options.videoSlotSameAsAd ? ad.slot : slotMinutesAgo(-360).slot],
    paused: options.paused ?? false,
  });
  await enableAds(client.id, {
    adSlot: ad.slot,
    nextAfter: options.nextAfter === undefined ? 2 : options.nextAfter,
    countFrom: options.countFrom,
  });
  for (let i = 0; i < (options.published ?? 2); i += 1) {
    await createPublishedVideo(agency.id, client.id, new Date(Date.now() - (i + 1) * 3600_000));
  }
  return { agency, client, adSlotAt: ad.slotAt };
}

describe("reklam saati — vadesi geldiyse", () => {
  it("havuzdaki ilk reklam varsayılan metinle yayınlanır, satır ve sayaç yazılır", async () => {
    const { agency, client, adSlotAt } = await seed();
    const second = await createAdPost(agency.id, client.id, { sourceName: "10.jpg" });
    const first = await createAdPost(agency.id, client.id, { sourceName: "2.jpg", createdAt: second.createdAt });

    const res = await tick();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ adPublished: 1, adFailed: 0 });

    // Görsel R2'den imzalanıp tek görsel olarak gitti.
    expect(mockSign).toHaveBeenCalledWith(first.imageKey, expect.any(Number));
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish.mock.calls[0][0]).toMatchObject({
      imageUrls: [SIGNED],
      caption: "Özel ders için DM'den yaz! #ingilizce",
    });

    const published = await db.post.findUniqueOrThrow({ where: { id: first.id } });
    expect(published).toMatchObject({
      status: "approved",
      publishStatus: "published",
      caption: "Özel ders için DM'den yaz! #ingilizce",
      slotAt: adSlotAt,
    });
    expect(await db.approvalAudit.findMany({ where: { postId: first.id } })).toMatchObject([
      { action: "auto_approved", ip: "system" },
    ]);
    expect(await db.post.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({
      publishStatus: "idle",
    });

    expect(await adRuns(client.id)).toMatchObject([
      { slotAt: adSlotAt, postId: first.id, outcome: "published", kind: "ad" },
    ]);
    const settings = await db.publishSettings.findUniqueOrThrow({ where: { clientId: client.id } });
    expect(settings.adCountFrom!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(settings.adNextAfter).toBeGreaterThanOrEqual(5);
    expect(settings.adNextAfter).toBeLessThanOrEqual(10);

    expect(subjects()).toContain("Reklam görselin Instagram'da yayınlandı");
    // Havuzda reklam kaldı: "boşaldı" bildirimi yok.
    expect(subjects()).not.toContain(AD_POOL_EMPTY_SUBJECT);
  });

  it("reklama özel metin varsayılanın yerine geçer", async () => {
    const { agency, client } = await seed();
    const ad = await createAdPost(agency.id, client.id, { caption: "Bu reklamın kendi metni" });
    await tick();
    expect(mockPublish.mock.calls[0][0].caption).toBe("Bu reklamın kendi metni");
    expect((await db.post.findUniqueOrThrow({ where: { id: ad.id } })).caption).toBe(
      "Bu reklamın kendi metni"
    );
  });

  it("son reklam yayınlanınca TEK 'havuz boşaldı' bildirimi gider", async () => {
    const { agency, client } = await seed();
    await createAdPost(agency.id, client.id);
    await tick();
    expect(subjects().filter((s) => s === AD_POOL_EMPTY_SUBJECT)).toHaveLength(1);
    expect(mockPush.mock.calls.map((call) => call[1].title)).toContain("Reklam havuzun boşaldı");

    // Aynı saatin ikinci uyandırması: satır alınmış, havuz boş — yeni bildirim yok.
    mockRaw.mockClear();
    await tick();
    expect(subjects()).not.toContain(AD_POOL_EMPTY_SUBJECT);
  });

  it("aynı ana düşen video slotu ve reklam saati birbirini yemez (`kind`)", async () => {
    const { agency, client, adSlotAt } = await seed({ videoSlotSameAsAd: true });
    const video = await createQueuePost(agency.id, client.id);
    const ad = await createAdPost(agency.id, client.id);

    const body = await (await tick()).json();
    expect(body).toMatchObject({ published: 1, adPublished: 1 });
    expect((await db.post.findUniqueOrThrow({ where: { id: video.id } })).publishStatus).toBe("published");
    expect((await db.post.findUniqueOrThrow({ where: { id: ad.id } })).publishStatus).toBe("published");
    const runs = await db.slotRun.findMany({ where: { clientId: client.id, slotAt: adSlotAt } });
    expect(runs.map((r) => [r.kind, r.outcome]).sort()).toEqual([
      ["ad", "published"],
      ["video", "published"],
    ]);
  });

  it("iki eşzamanlı tick tek reklam yayınlar", async () => {
    const { agency, client } = await seed();
    await createAdPost(agency.id, client.id);
    await createAdPost(agency.id, client.id);

    await Promise.all([tick(), tick()]);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(await adRuns(client.id)).toHaveLength(1);
    expect(await db.post.count({ where: { isAd: true, publishStatus: "published" } })).toBe(1);
  });
});

describe("reklam saati — yayın yok, satır da yok", () => {
  it("hedefe ulaşılmadıysa (1/2 video) hiçbir şey olmaz", async () => {
    const { agency, client } = await seed({ published: 1 });
    await createAdPost(agency.id, client.id);
    expect(await (await tick()).json()).toMatchObject({ adPublished: 0 });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(await adRuns(client.id)).toEqual([]);
  });

  it("sayaç yalnızca videoları sayar — yayınlanmış reklam saymaz", async () => {
    const { agency, client } = await seed({ published: 1 });
    await createAdPost(agency.id, client.id, {
      status: "approved",
      publishStatus: "published",
      publishedAt: new Date(Date.now() - 60_000),
    });
    await createAdPost(agency.id, client.id);
    await tick();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("duraklatılmış kuyrukta reklam çıkmaz", async () => {
    const { agency, client } = await seed({ paused: true });
    await createAdPost(agency.id, client.id);
    await tick();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(await adRuns(client.id)).toEqual([]);
  });

  it("havuz boşsa (yalnızca hata almış reklam) satır yazılmaz", async () => {
    const { agency, client } = await seed();
    await createAdPost(agency.id, client.id, { publishStatus: "failed" });
    await tick();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(await adRuns(client.id)).toEqual([]);
  });

  it("pencere kaçtıysa (1 saatten geç) satır yazılmaz, reklam ertesi güne kalır", async () => {
    const { agency, client } = await seed({ adMinutesAgo: 90 });
    await createAdPost(agency.id, client.id);
    await tick();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(await adRuns(client.id)).toEqual([]);
  });

  it("Instagram bağlı değilse reklam harcanmaz", async () => {
    const { agency, client } = await seed({ instagram: false });
    const ad = await createAdPost(agency.id, client.id);
    await tick();
    expect(await adRuns(client.id)).toEqual([]);
    expect((await db.post.findUniqueOrThrow({ where: { id: ad.id } })).publishStatus).toBe("idle");
  });

  it("sayaç hiç kurulmamışsa bu tur onu kurar, reklam çıkmaz", async () => {
    const { agency, client } = await seed({ countFrom: null, nextAfter: null, published: 5 });
    await createAdPost(agency.id, client.id);
    await tick();
    expect(mockPublish).not.toHaveBeenCalled();
    const settings = await db.publishSettings.findUniqueOrThrow({ where: { clientId: client.id } });
    expect(settings.adCountFrom).not.toBeNull();
    expect(settings.adNextAfter).toBeGreaterThanOrEqual(5);
  });

  it("metin yoksa reklam yayınlanmaz ve sahiplenmesi bırakılır", async () => {
    const { agency, client } = await seed();
    await db.publishSettings.update({ where: { clientId: client.id }, data: { adCaption: null } });
    const ad = await createAdPost(agency.id, client.id);
    await tick();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(await adRuns(client.id)).toMatchObject([{ outcome: "failed" }]);
    expect(await db.post.findUniqueOrThrow({ where: { id: ad.id } })).toMatchObject({
      publishStatus: "idle",
      slotAt: null,
    });
  });
});

describe("reklam yayını başarısız", () => {
  it("reklam failed olur, satır failed kapanır, sayaç ilerlemez", async () => {
    const { agency, client } = await seed();
    const before = await db.publishSettings.findUniqueOrThrow({ where: { clientId: client.id } });
    const ad = await createAdPost(agency.id, client.id);
    mockPublish.mockRejectedValueOnce(new IGError("Görsel indirilemedi", { status: 400, code: 9004 }));

    expect(await (await tick()).json()).toMatchObject({ adPublished: 0, adFailed: 1 });
    expect((await db.post.findUniqueOrThrow({ where: { id: ad.id } })).publishStatus).toBe("failed");
    expect(await adRuns(client.id)).toMatchObject([{ outcome: "failed", postId: ad.id }]);
    const after = await db.publishSettings.findUniqueOrThrow({ where: { clientId: client.id } });
    expect(after.adCountFrom).toEqual(before.adCountFrom);
    expect(after.adNextAfter).toBe(before.adNextAfter);
    expect(subjects()).toContain("Reklam görseli yayınlanamadı");
  });

  it("başka müşterinin önekindeki görsel anahtarı imzalanmaz", async () => {
    const { agency, client } = await seed();
    const other = await createClient(agency.id);
    const ad = await createAdPost(agency.id, client.id, {
      imageKey: `clients/${other.id}/ads/yabanci.jpg`,
    });
    await tick();
    expect(mockSign).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect((await db.post.findUniqueOrThrow({ where: { id: ad.id } })).publishStatus).toBe("failed");
  });
});
