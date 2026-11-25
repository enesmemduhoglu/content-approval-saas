import { beforeEach, describe, expect, it, vi } from "vitest";

// V12 — portal reklam route'ları. `portal-videos.test.ts` ile aynı sınır: R2
// sahte, oturum gerçek imzalı çerez, veri katmanı gerçek Postgres.
vi.mock("@/lib/storage-r2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage-r2")>();
  return {
    ...actual,
    r2Configured: vi.fn(() => true),
    signPutUrl: vi.fn(async (key: string) => `https://acc.r2.cloudflarestorage.com/put/${key}`),
    headObject: vi.fn(),
    getObjectBytes: vi.fn(),
    deleteObject: vi.fn(async () => true),
    prefixUsage: vi.fn(async () => ({ totalBytes: 0, videoBytes: 0, videoCount: 0, frameBytes: 0 })),
  };
});
// Uyandırma senkronu sahte: hangi uçların onu tetiklediği sınanıyor, QStash'in kendisi değil.
vi.mock("@/lib/queue-wake", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queue-wake")>()),
  syncQueueWakes: vi.fn(async () => ({ armed: 0, cancelled: 0, failed: 0, pruned: 0 })),
}));
vi.mock("@/lib/publish-post", () => ({ publishApprovedPost: vi.fn(), resumePublish: vi.fn() }));

import { db } from "@/lib/db";
import { resetRateLimiter } from "@/lib/rate-limit";
import {
  deleteObject,
  getObjectBytes,
  headObject,
  prefixUsage,
  r2Configured,
  signPutUrl,
} from "@/lib/storage-r2";
import { syncQueueWakes } from "@/lib/queue-wake";
import { publishApprovedPost } from "@/lib/publish-post";
import { STORAGE_QUOTA_BYTES } from "@/lib/storage-usage";
import { MAX_AD_BYTES, MAX_FILES_PER_UPLOAD } from "@/lib/portal-validation";
import { PORTAL_RATE_LIMIT_MAX } from "@/lib/portal-route";
import { createAgency, createClient, resetDb } from "@tests/helpers/db";
import { createClientUser, idParams, portalCookie, portalRequest } from "@tests/helpers/portal";
import { createAdPost, createPublishSettings, createPublishedVideo, createQueuePost } from "@tests/helpers/queue";

import { POST as uploadAds } from "./ads/upload/route";
import { POST as completeAd } from "./ads/[id]/complete/route";
import { DELETE as deleteAd, PATCH as patchAd } from "./ads/[id]/route";
import { POST as retryAd } from "./ads/[id]/retry/route";
import { PUT as putAdSettings } from "./ads/settings/route";
import { DELETE as deleteVideo } from "./videos/[id]/route";
import { GET as listVideos } from "./videos/route";

/** En küçük geçerli JPEG başlığı: SOI + SOF0 (bkz. jpeg-size.unit.test.ts). */
function jpegBytes(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
    ...new Array(9).fill(0),
  ]);
}

let agencyId: string;
let clientId: string;
let cookie: string;
let otherCookie: string;
let otherClientId: string;

beforeEach(async () => {
  await resetDb();
  resetRateLimiter();
  vi.clearAllMocks();
  vi.mocked(r2Configured).mockReturnValue(true);
  vi.mocked(headObject).mockResolvedValue({ size: 500_000, contentType: "image/jpeg" });
  vi.mocked(getObjectBytes).mockResolvedValue(jpegBytes(2160, 2700));
  vi.mocked(deleteObject).mockResolvedValue(true);
  vi.mocked(prefixUsage).mockResolvedValue({ totalBytes: 0, videoBytes: 0, videoCount: 0, frameBytes: 0 });
  const agency = await createAgency();
  const client = await createClient(agency.id);
  const other = await createClient(agency.id);
  agencyId = agency.id;
  clientId = client.id;
  otherClientId = other.id;
  cookie = portalCookie(await createClientUser(client.id));
  otherCookie = portalCookie(await createClientUser(other.id));
});

const req = (path: string, method: string, body?: unknown, extra: { origin?: string; cookie?: string } = {}) =>
  portalRequest(path, { method, cookie: extra.cookie ?? cookie, body, origin: extra.origin });

const jpegFile = (over: Record<string, unknown> = {}) => ({
  contentType: "image/jpeg",
  size: 500_000,
  name: "01.jpg",
  ...over,
});

async function draftAd() {
  const res = await uploadAds(req("/api/portal/ads/upload", "POST", { files: [jpegFile()] }));
  expect(res.status).toBe(201);
  const { items } = (await res.json()) as { items: { adId: string; putUrl: string }[] };
  return items[0];
}

// ─── Yükleme ──────────────────────────────────────────────────────────────

describe("POST /api/portal/ads/upload", () => {
  it("dosya başına taslak reklam + imzalı PUT; kuyruğa girmez", async () => {
    const res = await uploadAds(
      req("/api/portal/ads/upload", "POST", { files: [jpegFile({ name: "01.jpg" }), jpegFile({ name: "02.jpg" })] })
    );
    expect(res.status).toBe(201);
    const { items } = await res.json();
    expect(items).toHaveLength(2);
    const rows = await db.post.findMany({ where: { clientId }, orderBy: { sourceName: "asc" } });
    expect(rows).toMatchObject([
      { isAd: true, status: "draft", queuePosition: null, captionStatus: null, sourceName: "01.jpg" },
      { isAd: true, status: "draft", sourceName: "02.jpg" },
    ]);
    expect(rows[0].imageKey).toBe(`clients/${clientId}/ads/${rows[0].id}.jpg`);
    expect(signPutUrl).toHaveBeenCalledWith(rows[0].imageKey, "image/jpeg");
  });

  it("oturumsuz 401, yabancı Origin 403 — taslak doğmaz", async () => {
    expect((await uploadAds(req("/api/portal/ads/upload", "POST", { files: [jpegFile()] }, { cookie: "" }))).status).toBe(401);
    const res = await uploadAds(
      req("/api/portal/ads/upload", "POST", { files: [jpegFile()] }, { origin: "https://kotu.example" })
    );
    expect(res.status).toBe(403);
    expect(await db.post.count()).toBe(0);
  });

  it("hız sınırı 429", async () => {
    for (let i = 0; i < PORTAL_RATE_LIMIT_MAX; i += 1) {
      await uploadAds(req("/api/portal/ads/upload", "POST", { files: [] }));
    }
    expect((await uploadAds(req("/api/portal/ads/upload", "POST", { files: [jpegFile()] }))).status).toBe(429);
  });

  it.each([
    ["JPEG olmayan", { contentType: "image/png" }, "JPEG"],
    ["8 MB üstü", { size: MAX_AD_BYTES + 1 }, "8 MB"],
    ["boyutsuz", { size: 0 }, "8 MB"],
  ])("%s dosya 400 (field: files)", async (_label, over, text) => {
    const res = await uploadAds(req("/api/portal/ads/upload", "POST", { files: [jpegFile(over)] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.field).toBe("files");
    expect(body.error).toContain(text);
  });

  it(`tek seferde ${MAX_FILES_PER_UPLOAD}'den fazla görsel 400`, async () => {
    const files = Array.from({ length: MAX_FILES_PER_UPLOAD + 1 }, () => jpegFile());
    expect((await uploadAds(req("/api/portal/ads/upload", "POST", { files }))).status).toBe(400);
  });

  it("depolama tavanı (K35) dolarsa 403, taslak yok", async () => {
    vi.mocked(prefixUsage).mockResolvedValue({
      totalBytes: STORAGE_QUOTA_BYTES,
      videoBytes: 0,
      videoCount: 0,
      frameBytes: 0,
    });
    expect((await uploadAds(req("/api/portal/ads/upload", "POST", { files: [jpegFile()] }))).status).toBe(403);
    expect(await db.post.count()).toBe(0);
  });

  it("imzalama patlarsa taslaklar geri alınır (502)", async () => {
    vi.mocked(signPutUrl).mockRejectedValueOnce(new Error("R2 down"));
    expect((await uploadAds(req("/api/portal/ads/upload", "POST", { files: [jpegFile()] }))).status).toBe(502);
    expect(await db.post.count()).toBe(0);
  });

  it("R2 yapılandırılmamışsa 503", async () => {
    vi.mocked(r2Configured).mockReturnValue(false);
    expect((await uploadAds(req("/api/portal/ads/upload", "POST", { files: [jpegFile()] }))).status).toBe(503);
  });
});

describe("POST /api/portal/ads/[id]/complete", () => {
  it("geçerli JPEG havuza girer (pending) ve uyandırmalar eşitlenir", async () => {
    const { adId } = await draftAd();
    const res = await completeAd(req(`/api/portal/ads/${adId}/complete`, "POST"), idParams(adId));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, width: 2160, height: 2700 });
    expect(await db.post.findUniqueOrThrow({ where: { id: adId } })).toMatchObject({
      status: "pending",
      queuePosition: null,
    });
    expect(syncQueueWakes).toHaveBeenCalled();
    expect(publishApprovedPost).not.toHaveBeenCalled();
  });

  it("ikinci kez tamamlama 409", async () => {
    const { adId } = await draftAd();
    await completeAd(req(`/api/portal/ads/${adId}/complete`, "POST"), idParams(adId));
    expect((await completeAd(req(`/api/portal/ads/${adId}/complete`, "POST"), idParams(adId))).status).toBe(409);
  });

  it.each([
    ["oranı Instagram dışı (kare değil, 1:2 dikey)", () => vi.mocked(getObjectBytes).mockResolvedValue(jpegBytes(1000, 2000)), "oranı"],
    ["JPEG başlığı yok", () => vi.mocked(getObjectBytes).mockResolvedValue(new Uint8Array([1, 2, 3, 4])), "JPEG"],
    ["8 MB üstü", () => vi.mocked(headObject).mockResolvedValue({ size: MAX_AD_BYTES + 1, contentType: "image/jpeg" }), "8 MB"],
    ["tip PNG", () => vi.mocked(headObject).mockResolvedValue({ size: 1000, contentType: "image/png" }), "JPEG"],
  ])("%s → 400, nesne silinir, taslak kalır", async (_label, arrange, text) => {
    const { adId } = await draftAd();
    arrange();
    const res = await completeAd(req(`/api/portal/ads/${adId}/complete`, "POST"), idParams(adId));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(text);
    expect(deleteObject).toHaveBeenCalledWith(`clients/${clientId}/ads/${adId}.jpg`);
    expect((await db.post.findUniqueOrThrow({ where: { id: adId } })).status).toBe("draft");
  });

  it("dosya R2'de yoksa 400, taslak kalır", async () => {
    const { adId } = await draftAd();
    vi.mocked(headObject).mockResolvedValue(null);
    expect((await completeAd(req(`/api/portal/ads/${adId}/complete`, "POST"), idParams(adId))).status).toBe(400);
  });

  it("IDOR: B müşterisi A'nın taslağını tamamlayamaz (404)", async () => {
    const { adId } = await draftAd();
    const res = await completeAd(req(`/api/portal/ads/${adId}/complete`, "POST", undefined, { cookie: otherCookie }), idParams(adId));
    expect(res.status).toBe(404);
    expect((await db.post.findUniqueOrThrow({ where: { id: adId } })).status).toBe("draft");
  });

  it("video taslağı reklam ucundan tamamlanamaz (404)", async () => {
    const video = await createQueuePost(agencyId, clientId, { status: "draft", queuePosition: null });
    expect((await completeAd(req(`/api/portal/ads/${video.id}/complete`, "POST"), idParams(video.id))).status).toBe(404);
  });
});

// ─── Düzenleme, silme, tekrar dene ───────────────────────────────────────

describe("PATCH /api/portal/ads/[id]", () => {
  it("reklama özel metin yazılır; boş metin = varsayılan", async () => {
    const ad = await createAdPost(agencyId, clientId);
    expect((await patchAd(req(`/api/portal/ads/${ad.id}`, "PATCH", { caption: "  Özel metin  " }), idParams(ad.id))).status).toBe(200);
    expect((await db.post.findUniqueOrThrow({ where: { id: ad.id } })).caption).toBe("Özel metin");
    expect((await patchAd(req(`/api/portal/ads/${ad.id}`, "PATCH", { caption: "" }), idParams(ad.id))).status).toBe(200);
    expect((await db.post.findUniqueOrThrow({ where: { id: ad.id } })).caption).toBe("");
  });

  it("30'dan fazla hashtag 400", async () => {
    const ad = await createAdPost(agencyId, clientId);
    const caption = Array.from({ length: 31 }, (_, i) => `#e${i}`).join(" ");
    const res = await patchAd(req(`/api/portal/ads/${ad.id}`, "PATCH", { caption }), idParams(ad.id));
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("caption");
  });

  it("yayınlanmış reklam 409; başka müşterinin reklamı 404", async () => {
    const published = await createAdPost(agencyId, clientId, { status: "approved", publishStatus: "published" });
    expect((await patchAd(req(`/api/portal/ads/${published.id}`, "PATCH", { caption: "x" }), idParams(published.id))).status).toBe(409);
    const foreign = await createAdPost(agencyId, otherClientId);
    expect((await patchAd(req(`/api/portal/ads/${foreign.id}`, "PATCH", { caption: "x" }), idParams(foreign.id))).status).toBe(404);
    expect((await db.post.findUniqueOrThrow({ where: { id: foreign.id } })).caption).toBe("");
  });
});

describe("DELETE /api/portal/ads/[id]", () => {
  it("yayınlanmamış reklam satırı ve görseliyle silinir", async () => {
    const ad = await createAdPost(agencyId, clientId);
    expect((await deleteAd(req(`/api/portal/ads/${ad.id}`, "DELETE"), idParams(ad.id))).status).toBe(200);
    expect(await db.post.findUnique({ where: { id: ad.id } })).toBeNull();
    expect(deleteObject).toHaveBeenCalledWith(ad.imageKey);
  });

  it("yayınlanmış reklam silinemez (409), dosyası yerinde", async () => {
    const ad = await createAdPost(agencyId, clientId, { status: "approved", publishStatus: "published" });
    expect((await deleteAd(req(`/api/portal/ads/${ad.id}`, "DELETE"), idParams(ad.id))).status).toBe(409);
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("IDOR: B, A'nın reklamını silemez (404)", async () => {
    const ad = await createAdPost(agencyId, clientId);
    expect((await deleteAd(req(`/api/portal/ads/${ad.id}`, "DELETE", undefined, { cookie: otherCookie }), idParams(ad.id))).status).toBe(404);
    expect(await db.post.findUnique({ where: { id: ad.id } })).not.toBeNull();
  });

  it("video silme ucu reklamı silmez (kuyruk dışı video sayılmaz)", async () => {
    const ad = await createAdPost(agencyId, clientId);
    expect((await deleteVideo(req(`/api/portal/videos/${ad.id}`, "DELETE"), idParams(ad.id))).status).toBe(404);
    expect(await db.post.findUnique({ where: { id: ad.id } })).not.toBeNull();
  });
});

describe("POST /api/portal/ads/[id]/retry", () => {
  it("failed → idle ve sahiplenme bırakılır", async () => {
    const ad = await createAdPost(agencyId, clientId, { status: "approved", publishStatus: "failed" });
    await db.post.update({ where: { id: ad.id }, data: { slotAt: new Date(), publishError: "x" } });
    expect((await retryAd(req(`/api/portal/ads/${ad.id}/retry`, "POST"), idParams(ad.id))).status).toBe(200);
    expect(await db.post.findUniqueOrThrow({ where: { id: ad.id } })).toMatchObject({
      publishStatus: "idle",
      slotAt: null,
      publishError: null,
    });
  });

  it("hata almamış reklam 409, başkasının reklamı 404", async () => {
    const ad = await createAdPost(agencyId, clientId);
    expect((await retryAd(req(`/api/portal/ads/${ad.id}/retry`, "POST"), idParams(ad.id))).status).toBe(409);
    const foreign = await createAdPost(agencyId, otherClientId, { publishStatus: "failed" });
    expect((await retryAd(req(`/api/portal/ads/${foreign.id}/retry`, "POST"), idParams(foreign.id))).status).toBe(404);
  });
});

// ─── Video yüzeyi reklamı görmez ─────────────────────────────────────────

describe("video yüzeyiyle ayrım", () => {
  it("reklam video listelerinde (kuyruk, kuyruk dışı) görünmez", async () => {
    await createAdPost(agencyId, clientId);
    const res = await listVideos(portalRequest("/api/portal/videos", { cookie }));
    const body = await res.json();
    const ids = JSON.stringify(body);
    expect(ids).not.toContain("ads/");
    for (const list of Object.values(body as Record<string, unknown>)) {
      if (Array.isArray(list)) expect(list).toHaveLength(0);
    }
  });
});

// ─── Ayarlar ──────────────────────────────────────────────────────────────

describe("PUT /api/portal/ads/settings", () => {
  const valid = {
    adsEnabled: true,
    adSlot: "21:00",
    adMinGap: 5,
    adMaxGap: 10,
    adCaption: "Özel ders için DM! #ingilizce",
  };

  it("yayın ayarı yoksa 409", async () => {
    expect((await putAdSettings(req("/api/portal/ads/settings", "PUT", valid))).status).toBe(409);
  });

  it("açılışta sayaç şimdi başlar, hedef aralıktan çekilir; uyandırmalar eşitlenir", async () => {
    await createPublishSettings(clientId, { slots: ["19:00"] });
    const res = await putAdSettings(req("/api/portal/ads/settings", "PUT", valid));
    expect(res.status).toBe(200);
    const row = await db.publishSettings.findUniqueOrThrow({ where: { clientId } });
    expect(row).toMatchObject({ adsEnabled: true, adSlot: "21:00", adCaption: valid.adCaption });
    expect(row.adCountFrom!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(row.adNextAfter).toBeGreaterThanOrEqual(5);
    expect(row.adNextAfter).toBeLessThanOrEqual(10);
    expect(syncQueueWakes).toHaveBeenCalled();
  });

  it("sabit mod (min = max) hedefi N yapar; açıkken sayaç korunur", async () => {
    await createPublishSettings(clientId, { slots: ["19:00"] });
    await putAdSettings(req("/api/portal/ads/settings", "PUT", valid));
    const before = await db.publishSettings.findUniqueOrThrow({ where: { clientId } });
    await createPublishedVideo(agencyId, clientId, new Date());

    await putAdSettings(req("/api/portal/ads/settings", "PUT", { ...valid, adMinGap: 3, adMaxGap: 3 }));
    const after = await db.publishSettings.findUniqueOrThrow({ where: { clientId } });
    expect(after.adNextAfter).toBe(3);
    expect(after.adCountFrom).toEqual(before.adCountFrom);
  });

  it.each([
    ["video saatiyle aynı reklam saati", { adSlot: "19:00" }, "adSlot"],
    ["geçersiz saat", { adSlot: "25:00" }, "adSlot"],
    ["alt sınır > üst sınır", { adMinGap: 8, adMaxGap: 4 }, "adMaxGap"],
    ["0 video", { adMinGap: 0 }, "adMinGap"],
    ["açıkken boş metin", { adCaption: "  " }, "adCaption"],
    ["açık/kapalı değil", { adsEnabled: "evet" }, "adsEnabled"],
  ])("%s → 400 (field: %s)", async (_label, over, field) => {
    await createPublishSettings(clientId, { slots: ["19:00"] });
    const res = await putAdSettings(req("/api/portal/ads/settings", "PUT", { ...valid, ...over }));
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe(field);
    expect((await db.publishSettings.findUniqueOrThrow({ where: { clientId } })).adsEnabled).toBe(false);
  });

  it("kapalıyken metin boş bırakılabilir", async () => {
    await createPublishSettings(clientId, { slots: ["19:00"] });
    const res = await putAdSettings(req("/api/portal/ads/settings", "PUT", { ...valid, adsEnabled: false, adCaption: "" }));
    expect(res.status).toBe(200);
  });

  it("yalnızca kendi ayarını yazar (B'nin satırı değişmez)", async () => {
    await createPublishSettings(clientId, { slots: ["19:00"] });
    await createPublishSettings(otherClientId, { slots: ["19:00"] });
    await putAdSettings(req("/api/portal/ads/settings", "PUT", valid));
    expect((await db.publishSettings.findUniqueOrThrow({ where: { clientId: otherClientId } })).adsEnabled).toBe(false);
  });

  it("yabancı Origin 403", async () => {
    await createPublishSettings(clientId, { slots: ["19:00"] });
    const res = await putAdSettings(req("/api/portal/ads/settings", "PUT", valid, { origin: "https://kotu.example" }));
    expect(res.status).toBe(403);
  });
});
