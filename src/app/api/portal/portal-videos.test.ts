import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/storage-r2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage-r2")>();
  return {
    ...actual,
    r2Configured: vi.fn(() => true),
    signPutUrl: vi.fn(async (key: string) => `https://acc.r2.cloudflarestorage.com/put/${key}`),
    signGetUrl: vi.fn(async (key: string) => `https://acc.r2.cloudflarestorage.com/get/${key}`),
    signDisplayUrl: vi.fn(async (key: string) => `https://acc.r2.cloudflarestorage.com/get/${key}`),
    headObject: vi.fn(async () => ({ size: 1000, contentType: "video/mp4" })),
    deleteObject: vi.fn(async () => true),
  };
});
vi.mock("@/lib/qstash", () => ({
  enqueueCaption: vi.fn(async () => ({ queued: true, messageId: "m-1" })),
}));
vi.mock("@/lib/alerts", () => ({ sendAlert: vi.fn(async () => undefined) }));
// Onay yayın tetiklememeli: modül mock'lanıyor ki olası bir çağrı yakalansın.
vi.mock("@/lib/publish-post", () => ({
  publishApprovedPost: vi.fn(),
  resumePublish: vi.fn(),
}));

import { db } from "@/lib/db";
import { resetRateLimiter } from "@/lib/rate-limit";
import { deleteObject, headObject, r2Configured } from "@/lib/storage-r2";
import { enqueueCaption } from "@/lib/qstash";
import { sendAlert } from "@/lib/alerts";
import { publishApprovedPost } from "@/lib/publish-post";
import { PORTAL_RATE_LIMIT_MAX } from "@/lib/portal-route";
import { POSITION_STEP } from "@/lib/queue";
import { createAgency, createClient, resetDb } from "@tests/helpers/db";
import {
  createClientUser,
  createPortalPost,
  idParams,
  portalCookie,
  portalRequest,
} from "@tests/helpers/portal";

import { POST as upload } from "./upload/route";
import { GET as listVideos } from "./videos/route";
import { DELETE as deleteVideo, GET as getVideo, PATCH as patchVideo } from "./videos/[id]/route";
import { POST as completeVideo } from "./videos/[id]/complete/route";
import { POST as moveVideo } from "./videos/[id]/move/route";
import { POST as decideVideo } from "./videos/[id]/decision/route";
import { POST as removeVideo } from "./videos/[id]/remove/route";
import { POST as retryVideo } from "./videos/[id]/retry/route";
import { POST as toEndVideo } from "./videos/[id]/to-end/route";
import { POST as restoreVideo } from "./videos/[id]/restore/route";
import { POST as regenerateVideo } from "./videos/[id]/regenerate/route";

let agencyId: string;
let clientId: string;
let cookie: string;

beforeEach(async () => {
  await resetDb();
  resetRateLimiter();
  vi.mocked(enqueueCaption).mockClear();
  vi.mocked(sendAlert).mockClear();
  vi.mocked(publishApprovedPost).mockClear();
  vi.mocked(headObject).mockReset();
  vi.mocked(headObject).mockResolvedValue({ size: 1000, contentType: "video/mp4" });
  vi.mocked(r2Configured).mockReturnValue(true);
  vi.mocked(deleteObject).mockReset();
  vi.mocked(deleteObject).mockResolvedValue(true);
  delete process.env.PORTAL_DAILY_UPLOAD_LIMIT;
  const agency = await createAgency();
  const client = await createClient(agency.id);
  agencyId = agency.id;
  clientId = client.id;
  cookie = portalCookie(await createClientUser(client.id));
});

const post = (path: string, body?: unknown, extra: { origin?: string; cookie?: string } = {}) =>
  portalRequest(path, { method: "POST", cookie: extra.cookie ?? cookie, body, origin: extra.origin });

async function queueOrder(): Promise<string[]> {
  const rows = await db.post.findMany({
    where: { clientId, queuePosition: { not: null } },
    orderBy: [{ queuePosition: "asc" }, { createdAt: "asc" }],
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

// ─── Ortak kapılar ────────────────────────────────────────────────────────

describe("kapılar (oturum → checkOrigin → hız sınırı)", () => {
  it("oturum yoksa 401", async () => {
    const res = await upload(post("/api/portal/upload", { files: [] }, { cookie: "" }));
    expect(res.status).toBe(401);
  });

  it("imzası bozuk çerez 401", async () => {
    const tampered = cookie.slice(0, -3) + "AAA";
    const res = await listVideos(portalRequest("/api/portal/videos", { cookie: tampered }));
    expect(res.status).toBe(401);
  });

  it("yabancı Origin 403 — ve hiçbir şey yazılmaz", async () => {
    const video = await createPortalPost(agencyId, clientId);
    const res = await decideVideo(
      post(`/api/portal/videos/${video.id}/decision`, { action: "approve" }, { origin: "https://kotu.example" }),
      idParams(video.id)
    );
    expect(res.status).toBe(403);
    expect((await db.post.findUniqueOrThrow({ where: { id: video.id } })).status).toBe("pending");
  });

  it(`hız sınırı: aynı müşteriden ${PORTAL_RATE_LIMIT_MAX + 1}. istek 429`, async () => {
    const a = await createPortalPost(agencyId, clientId);
    const b = await createPortalPost(agencyId, clientId);
    for (let i = 0; i < PORTAL_RATE_LIMIT_MAX; i++) {
      const res = await moveVideo(
        post(`/api/portal/videos/${a.id}/move`, i % 2 ? { beforeId: b.id } : { afterId: b.id }),
        idParams(a.id)
      );
      expect(res.status).toBe(200);
    }
    const blocked = await moveVideo(
      post(`/api/portal/videos/${a.id}/move`, { afterId: b.id }),
      idParams(a.id)
    );
    expect(blocked.status).toBe(429);
  });
});

// ─── Yükleme ──────────────────────────────────────────────────────────────

describe("POST /api/portal/upload", () => {
  it("dosya başına taslak + imzalı PUT (video + 6 kare) döner", async () => {
    const res = await upload(
      post("/api/portal/upload", {
        files: [
          { contentType: "video/mp4", size: 5_000_000 },
          { contentType: "video/quicktime", size: 7_000_000 },
        ],
      })
    );
    expect(res.status).toBe(201);
    const { items } = await res.json();
    expect(items).toHaveLength(2);
    expect(items[0].framePutUrls).toHaveLength(6);

    const drafts = await db.post.findMany({ where: { clientId }, orderBy: { createdAt: "asc" } });
    expect(drafts).toHaveLength(2);
    for (const draft of drafts) {
      expect(draft.source).toBe("portal");
      expect(draft.status).toBe("draft");
      expect(draft.caption).toBe("");
      expect(draft.captionStatus).toBe("pending");
      expect(draft.queuePosition).toBeNull();
      expect(draft.videoKey).toMatch(new RegExp(`^clients/${clientId}/videos/${draft.id}\\.(mp4|mov)$`));
    }
    expect(items.map((i: { postId: string }) => i.postId).sort()).toEqual(drafts.map((d) => d.id).sort());
    expect(items[0].videoPutUrl).toContain(`clients/${clientId}/videos/`);
  });

  it("izin verilmeyen tip 400 (field: files), taslak yazılmaz", async () => {
    const res = await upload(post("/api/portal/upload", { files: [{ contentType: "video/webm", size: 10 }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("files");
    expect(await db.post.count()).toBe(0);
  });

  it("300 MB üstü 400", async () => {
    const res = await upload(
      post("/api/portal/upload", { files: [{ contentType: "video/mp4", size: 301 * 1024 * 1024 }] })
    );
    expect(res.status).toBe(400);
  });

  it("günlük yükleme tavanı aşılırsa 403, taslak yazılmaz", async () => {
    process.env.PORTAL_DAILY_UPLOAD_LIMIT = "2";
    await createPortalPost(agencyId, clientId);
    const res = await upload(
      post("/api/portal/upload", {
        files: [
          { contentType: "video/mp4", size: 10 },
          { contentType: "video/mp4", size: 10 },
        ],
      })
    );
    expect(res.status).toBe(403);
    expect(await db.post.count()).toBe(1);
  });

  it("R2 yapılandırılmamışsa 503 — sessizce taslak üretmez", async () => {
    vi.mocked(r2Configured).mockReturnValue(false);
    const res = await upload(post("/api/portal/upload", { files: [{ contentType: "video/mp4", size: 10 }] }));
    expect(res.status).toBe(503);
    expect(await db.post.count()).toBe(0);
  });
});

describe("POST /api/portal/videos/[id]/complete", () => {
  async function draft() {
    return createPortalPost(agencyId, clientId, {
      status: "draft",
      queuePosition: null,
      captionStatus: "pending",
      frameKeys: [],
    });
  }

  it("varlığı doğrular, kareleri yazar, kuyruğun SONUNA ekler ve caption'ı kuyruğa atar", async () => {
    await createPortalPost(agencyId, clientId, { queuePosition: 7.5 });
    const d = await draft();
    // Video + 4 kare var, 2 kare yok.
    vi.mocked(headObject).mockImplementation(async (key: string) => {
      if (key.includes("/videos/")) return { size: 5000, contentType: "video/mp4" };
      if (/\/(0|1|2|3)\.jpg$/.test(key)) return { size: 2000, contentType: "image/jpeg" };
      return null;
    });

    const res = await completeVideo(post(`/api/portal/videos/${d.id}/complete`), idParams(d.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ frameCount: 4, captionQueued: true });

    const row = await db.post.findUniqueOrThrow({ where: { id: d.id } });
    expect(row.status).toBe("pending");
    expect(row.queuePosition).toBe(7.5 + POSITION_STEP);
    expect(row.frameKeys).toEqual([0, 1, 2, 3].map((i) => `clients/${clientId}/frames/${d.id}/${i}.jpg`));
    expect(enqueueCaption).toHaveBeenCalledWith(d.id);
  });

  it("dosya R2'de yoksa 400, taslak kalır", async () => {
    const d = await draft();
    vi.mocked(headObject).mockResolvedValue(null);
    const res = await completeVideo(post(`/api/portal/videos/${d.id}/complete`), idParams(d.id));
    expect(res.status).toBe(400);
    expect((await db.post.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("draft");
    expect(enqueueCaption).not.toHaveBeenCalled();
  });

  it("R2'deki dosya sınırı aşıyorsa 400 (imzalı PUT boyutu sınırlamıyor)", async () => {
    const d = await draft();
    vi.mocked(headObject).mockResolvedValue({ size: 400 * 1024 * 1024, contentType: "video/mp4" });
    const res = await completeVideo(post(`/api/portal/videos/${d.id}/complete`), idParams(d.id));
    expect(res.status).toBe(400);
    expect((await db.post.findUniqueOrThrow({ where: { id: d.id } })).queuePosition).toBeNull();
  });

  it("ikinci kez tamamlanamaz (409), caption işi bir kez atılır", async () => {
    const d = await draft();
    expect((await completeVideo(post(`/api/portal/videos/${d.id}/complete`), idParams(d.id))).status).toBe(200);
    expect((await completeVideo(post(`/api/portal/videos/${d.id}/complete`), idParams(d.id))).status).toBe(409);
    expect(enqueueCaption).toHaveBeenCalledTimes(1);
  });

  // ─── Kare raporu (canlıda karesiz videoların nedeni görünmüyordu) ───────

  it("kare varsa rapor kabul edilir, uyarı gitmez", async () => {
    const d = await draft();
    const res = await completeVideo(
      post(`/api/portal/videos/${d.id}/complete`, { frames: { extracted: 6, uploadFailed: 0 } }),
      idParams(d.id)
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ frameCount: 6 });
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("hiç kare yoksa video yine kuyruğa girer, nedenle birlikte uyarı gider", async () => {
    const d = await draft();
    vi.mocked(headObject).mockImplementation(async (key: string) =>
      key.includes("/videos/") ? { size: 5000, contentType: "video/mp4" } : null
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await completeVideo(
      post(`/api/portal/videos/${d.id}/complete`, {
        frames: { extracted: 0, uploadFailed: 0, error: "seek-timeout" },
      }),
      idParams(d.id)
    );
    expect(res.status).toBe(200);
    expect((await db.post.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("pending");
    expect(sendAlert).toHaveBeenCalledWith(
      "portal:frames:cikarilamadi:seek-timeout",
      expect.any(String),
      expect.objectContaining({ postId: d.id, cikarilan: 0, hata: "seek-timeout" })
    );
    expect(errors.mock.calls.flat().join(" ")).toContain("kare yok");
    errors.mockRestore();
  });

  it("kareler çıkarıldı ama yüklenemediyse neden 'yukleme-dustu'; eski istemci (rapor yok) da raporlanır", async () => {
    vi.mocked(headObject).mockImplementation(async (key: string) =>
      key.includes("/videos/") ? { size: 5000, contentType: "video/mp4" } : null
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const a = await draft();
    await completeVideo(
      post(`/api/portal/videos/${a.id}/complete`, { frames: { extracted: 6, uploadFailed: 6 } }),
      idParams(a.id)
    );
    const b = await draft();
    await completeVideo(post(`/api/portal/videos/${b.id}/complete`), idParams(b.id));
    expect(vi.mocked(sendAlert).mock.calls.map(([key]) => key)).toEqual([
      "portal:frames:yukleme-dustu",
      "portal:frames:rapor-yok",
    ]);
    errors.mockRestore();
  });

  it.each([
    ["dizi", []],
    ["sayı değil", { extracted: "6", uploadFailed: 0 }],
    ["sınır dışı", { extracted: 7, uploadFailed: 0 }],
    ["yüklenemeyen > çıkarılan", { extracted: 2, uploadFailed: 3 }],
    ["hata kodunda keyfi metin", { extracted: 0, uploadFailed: 0, error: "<b>hack</b>" }],
    ["bilinmeyen alan", { extracted: 0, uploadFailed: 0, note: "x" }],
  ])("geçersiz kare raporu (%s) 400 — taslak kalır", async (_, frames) => {
    const d = await draft();
    const res = await completeVideo(post(`/api/portal/videos/${d.id}/complete`, { frames }), idParams(d.id));
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("frames");
    expect((await db.post.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("draft");
  });
});

// ─── Liste / detay ────────────────────────────────────────────────────────

describe("GET liste ve detay", () => {
  it("kuyruk sırasıyla, kuyruk dışı ve geçmiş ayrı; taslak hiçbirinde yok", async () => {
    const second = await createPortalPost(agencyId, clientId, { queuePosition: 2 });
    const first = await createPortalPost(agencyId, clientId, { queuePosition: 1 });
    const removed = await createPortalPost(agencyId, clientId, { queuePosition: null });
    const published = await createPortalPost(agencyId, clientId, {
      status: "approved",
      publishStatus: "published",
      igPermalink: "https://instagram.com/reel/X/",
    });
    await createPortalPost(agencyId, clientId, { status: "draft", queuePosition: null });

    const data = await (await listVideos(portalRequest("/api/portal/videos", { cookie }))).json();
    expect(data.queue.map((v: { id: string }) => v.id)).toEqual([first.id, second.id]);
    expect(data.outside.map((v: { id: string }) => v.id)).toEqual([removed.id]);
    expect(data.history.map((v: { id: string }) => v.id)).toEqual([published.id]);
    expect(data.queue[0].coverUrl).toContain(`clients/${clientId}/frames/`);
  });

  it("kuyruk kartı tahmini yayın anını taşır — onay açıkken onaysız video takvimde yok", async () => {
    await db.publishSettings.create({
      data: { clientId, slots: ["19:00"], timezone: "Europe/Istanbul", requireApproval: true },
    });
    const approved = await createPortalPost(agencyId, clientId, { queuePosition: 1, status: "approved" });
    const waiting = await createPortalPost(agencyId, clientId, { queuePosition: 2 });
    const data = await (await listVideos(portalRequest("/api/portal/videos", { cookie }))).json();
    const byId = Object.fromEntries(
      data.queue.map((v: { id: string; estimatedSlotAt: string | null }) => [v.id, v.estimatedSlotAt])
    );
    expect(byId[approved.id]).not.toBeNull();
    expect(byId[waiting.id]).toBeNull();
  });

  it("ayar satırı yoksa tahmin yok (tick o müşteriyi taramaz)", async () => {
    await createPortalPost(agencyId, clientId, { status: "approved" });
    const data = await (await listVideos(portalRequest("/api/portal/videos", { cookie }))).json();
    expect(data.queue[0].estimatedSlotAt).toBeNull();
  });

  it("detay imzalı video URL'i döner", async () => {
    const v = await createPortalPost(agencyId, clientId);
    const res = await getVideo(portalRequest(`/api/portal/videos/${v.id}`, { cookie }), idParams(v.id));
    const { video } = await res.json();
    expect(video.videoUrl).toContain(`clients/${clientId}/videos/${v.id}.mp4`);
    expect(video.frameUrls).toHaveLength(1);
  });
});

// ─── Caption ──────────────────────────────────────────────────────────────

describe("PATCH caption", () => {
  it("hazır caption düzenlenir", async () => {
    const v = await createPortalPost(agencyId, clientId);
    const res = await patchVideo(
      portalRequest(`/api/portal/videos/${v.id}`, { method: "PATCH", cookie, body: { caption: "Yeni metin" } }),
      idParams(v.id)
    );
    expect(res.status).toBe(200);
    expect((await db.post.findUniqueOrThrow({ where: { id: v.id } })).caption).toBe("Yeni metin");
  });

  it("üretim sürerken 409 — bitince düzenleme ezilmesin", async () => {
    const v = await createPortalPost(agencyId, clientId, { captionStatus: "generating" });
    const res = await patchVideo(
      portalRequest(`/api/portal/videos/${v.id}`, { method: "PATCH", cookie, body: { caption: "x" } }),
      idParams(v.id)
    );
    expect(res.status).toBe(409);
  });

  it("üretim başarısızsa elle yazılan metin caption'ı hazır sayar", async () => {
    const v = await createPortalPost(agencyId, clientId, { captionStatus: "failed", caption: "" });
    await patchVideo(
      portalRequest(`/api/portal/videos/${v.id}`, { method: "PATCH", cookie, body: { caption: "Elle" } }),
      idParams(v.id)
    );
    expect((await db.post.findUniqueOrThrow({ where: { id: v.id } })).captionStatus).toBe("ready");
  });

  it("boş caption 400 (field: caption)", async () => {
    const v = await createPortalPost(agencyId, clientId);
    const res = await patchVideo(
      portalRequest(`/api/portal/videos/${v.id}`, { method: "PATCH", cookie, body: { caption: "  " } }),
      idParams(v.id)
    );
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("caption");
  });
});

// ─── Taşıma ───────────────────────────────────────────────────────────────

describe("POST move — sıralama", () => {
  it("beforeId: videoyu hedefin önüne koyar (tek satır güncellenir)", async () => {
    const a = await createPortalPost(agencyId, clientId, { queuePosition: 1 });
    const b = await createPortalPost(agencyId, clientId, { queuePosition: 2 });
    const c = await createPortalPost(agencyId, clientId, { queuePosition: 3 });
    const res = await moveVideo(post(`/api/portal/videos/${c.id}/move`, { beforeId: a.id }), idParams(c.id));
    expect(res.status).toBe(200);
    expect(await queueOrder()).toEqual([c.id, a.id, b.id]);
    // Komşular yerinde: yalnızca taşınan satır değişti.
    expect((await db.post.findUniqueOrThrow({ where: { id: a.id } })).queuePosition).toBe(1);
  });

  it("afterId: videoyu hedefin arkasına koyar (ortalama)", async () => {
    const a = await createPortalPost(agencyId, clientId, { queuePosition: 1 });
    const b = await createPortalPost(agencyId, clientId, { queuePosition: 2 });
    const c = await createPortalPost(agencyId, clientId, { queuePosition: 3 });
    await moveVideo(post(`/api/portal/videos/${a.id}/move`, { afterId: b.id }), idParams(a.id));
    expect(await queueOrder()).toEqual([b.id, a.id, c.id]);
    expect((await db.post.findUniqueOrThrow({ where: { id: a.id } })).queuePosition).toBe(2.5);
  });

  it("float çözünürlüğü tükenince kuyruk yeniden numaralanır, sıra doğru kalır", async () => {
    const a = await createPortalPost(agencyId, clientId, { queuePosition: 1 });
    const b = await createPortalPost(agencyId, clientId, { queuePosition: 1 + Number.EPSILON });
    const c = await createPortalPost(agencyId, clientId, { queuePosition: 5 });
    await moveVideo(post(`/api/portal/videos/${c.id}/move`, { afterId: a.id }), idParams(c.id));
    expect(await queueOrder()).toEqual([a.id, c.id, b.id]);
    const positions = (
      await db.post.findMany({ where: { clientId }, orderBy: { queuePosition: "asc" } })
    ).map((p) => p.queuePosition);
    expect(positions).toEqual([1, 2, 3].map((i) => i * POSITION_STEP));
  });

  it("bayat komşu çifti (artık yan yana değil) 409", async () => {
    const a = await createPortalPost(agencyId, clientId, { queuePosition: 1 });
    const b = await createPortalPost(agencyId, clientId, { queuePosition: 2 });
    const c = await createPortalPost(agencyId, clientId, { queuePosition: 3 });
    const d = await createPortalPost(agencyId, clientId, { queuePosition: 4 });
    const res = await moveVideo(
      post(`/api/portal/videos/${d.id}/move`, { afterId: a.id, beforeId: c.id }),
      idParams(d.id)
    );
    expect(res.status).toBe(409);
    expect(await queueOrder()).toEqual([a.id, b.id, c.id, d.id]);
  });

  it("yayınlanmakta olan video taşınamaz", async () => {
    const a = await createPortalPost(agencyId, clientId, { queuePosition: 1, publishStatus: "publishing" });
    const b = await createPortalPost(agencyId, clientId, { queuePosition: 2 });
    const res = await moveVideo(post(`/api/portal/videos/${a.id}/move`, { afterId: b.id }), idParams(a.id));
    expect(res.status).toBe(404);
  });

  it("komşu verilmezse 400", async () => {
    const a = await createPortalPost(agencyId, clientId);
    const res = await moveVideo(post(`/api/portal/videos/${a.id}/move`, {}), idParams(a.id));
    expect(res.status).toBe(400);
  });
});

// ─── Onay / red ───────────────────────────────────────────────────────────

describe("POST decision — onay yayın tetiklemez", () => {
  it("onay: status approved, audit IP'yle yazılır, yayın ÇAĞRILMAZ, video kuyrukta kalır", async () => {
    const agencyWithIg = await createClient(agencyId, {
      instagramUserId: "17841400000000000",
      instagramAccessToken: "IGAA-test-token",
    });
    const igCookie = portalCookie(await createClientUser(agencyWithIg.id));
    const v = await createPortalPost(agencyId, agencyWithIg.id, { queuePosition: 3 });

    const res = await decideVideo(
      portalRequest(`/api/portal/videos/${v.id}/decision`, {
        method: "POST",
        cookie: igCookie,
        body: { action: "approve" },
        ip: "7.7.7.7",
      }),
      idParams(v.id)
    );
    expect(res.status).toBe(200);
    const row = await db.post.findUniqueOrThrow({ where: { id: v.id } });
    expect(row.status).toBe("approved");
    expect(row.publishStatus).toBe("idle");
    expect(row.queuePosition).toBe(3);
    expect(publishApprovedPost).not.toHaveBeenCalled();
    const audit = await db.approvalAudit.findFirstOrThrow({ where: { postId: v.id } });
    expect(audit).toMatchObject({ action: "approved", ip: "7.7.7.7" });
  });

  it("ikinci karar 409 (koşullu UPDATE), audit tek satır", async () => {
    const v = await createPortalPost(agencyId, clientId);
    await decideVideo(post(`/api/portal/videos/${v.id}/decision`, { action: "approve" }), idParams(v.id));
    const again = await decideVideo(post(`/api/portal/videos/${v.id}/decision`, { action: "reject" }), idParams(v.id));
    expect(again.status).toBe(409);
    expect(await db.approvalAudit.count({ where: { postId: v.id } })).toBe(1);
  });

  it("caption hazır değilken onay 409", async () => {
    const v = await createPortalPost(agencyId, clientId, { captionStatus: "generating" });
    const res = await decideVideo(post(`/api/portal/videos/${v.id}/decision`, { action: "approve" }), idParams(v.id));
    expect(res.status).toBe(409);
    expect((await db.post.findUniqueOrThrow({ where: { id: v.id } })).status).toBe("pending");
  });

  it("red: gerekçe yazılır, video kuyruktan çıkar", async () => {
    const v = await createPortalPost(agencyId, clientId);
    await decideVideo(
      post(`/api/portal/videos/${v.id}/decision`, { action: "reject", reason: "Ses kötü" }),
      idParams(v.id)
    );
    const row = await db.post.findUniqueOrThrow({ where: { id: v.id } });
    expect(row).toMatchObject({ status: "rejected", rejectionReason: "Ses kötü", queuePosition: null });
  });

  it("geçersiz action 400", async () => {
    const v = await createPortalPost(agencyId, clientId);
    const res = await decideVideo(post(`/api/portal/videos/${v.id}/decision`, { action: "publish" }), idParams(v.id));
    expect(res.status).toBe(400);
  });

  it("red yanıtı videonun eski sırasını döner (portaldaki 'Geri al' için)", async () => {
    const v = await createPortalPost(agencyId, clientId, { queuePosition: 7 });
    const res = await decideVideo(post(`/api/portal/videos/${v.id}/decision`, { action: "reject" }), idParams(v.id));
    expect(await res.json()).toEqual({ status: "rejected", previousPosition: 7 });
  });
});

// ─── Reddi geri al ────────────────────────────────────────────────────────

describe("POST restore — reddedilen videoyu kuyruğa geri alır", () => {
  const restore = (id: string, body: unknown, extra: { origin?: string } = {}) =>
    restoreVideo(post(`/api/portal/videos/${id}/restore`, body, extra), idParams(id));

  async function rejectedAt(position: number) {
    const v = await createPortalPost(agencyId, clientId, { queuePosition: position });
    await decideVideo(post(`/api/portal/videos/${v.id}/decision`, { action: "reject", reason: "Ses kötü" }), idParams(v.id));
    return v;
  }

  it("'Geri al' (position ile): onay bekler hâlde ESKİ yerine döner, red nedeni temizlenir", async () => {
    const a = await createPortalPost(agencyId, clientId, { queuePosition: 1 });
    const b = await rejectedAt(2);
    const c = await createPortalPost(agencyId, clientId, { queuePosition: 3 });

    const res = await restore(b.id, { approve: false, position: 2 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "pending" });
    expect(await queueOrder()).toEqual([a.id, b.id, c.id]);
    const row = await db.post.findUniqueOrThrow({ where: { id: b.id } });
    expect(row).toMatchObject({ status: "pending", rejectionReason: null });
    const actions = (await db.approvalAudit.findMany({ where: { postId: b.id } })).map((r) => r.action);
    expect(actions.sort()).toEqual(["rejected", "restored"]);
  });

  it("position yoksa sona eklenir; approve: true onaylı döner ve defterde 'approved' da var", async () => {
    const v = await rejectedAt(1);
    const other = await createPortalPost(agencyId, clientId, { queuePosition: 2 });

    expect((await restore(v.id, { approve: true })).status).toBe(200);
    expect(await queueOrder()).toEqual([other.id, v.id]);
    expect((await db.post.findUniqueOrThrow({ where: { id: v.id } })).status).toBe("approved");
    const actions = (await db.approvalAudit.findMany({ where: { postId: v.id } })).map((r) => r.action);
    expect(actions.sort()).toEqual(["approved", "rejected", "restored"]);
  });

  it("caption hazır değilken onaylı dönüş 409, video reddedilmiş kalır", async () => {
    const v = await createPortalPost(agencyId, clientId, { queuePosition: null, status: "rejected", captionStatus: "failed" });
    const res = await restore(v.id, { approve: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Caption hazır olmadan video onaylanamaz");
    expect((await db.post.findUniqueOrThrow({ where: { id: v.id } })).status).toBe("rejected");
    // Onay bekleyen olarak alınabilir.
    expect((await restore(v.id, { approve: false })).status).toBe(200);
  });

  it("reddedilmemiş video 409 (kuyruktaki de, çıkarılmış olan da — onun yolu 'sona at')", async () => {
    const queued = await createPortalPost(agencyId, clientId, { queuePosition: 1 });
    const removed = await createPortalPost(agencyId, clientId, { queuePosition: null });
    expect((await restore(queued.id, { approve: false })).status).toBe(409);
    expect((await restore(removed.id, { approve: false })).status).toBe(409);
    expect(await db.approvalAudit.count()).toBe(0);
  });

  it("ikinci geri alma 409 (koşullu UPDATE), defterde tek 'restored'", async () => {
    const v = await rejectedAt(1);
    expect((await restore(v.id, { approve: false })).status).toBe(200);
    expect((await restore(v.id, { approve: false })).status).toBe(409);
    expect(await db.approvalAudit.count({ where: { postId: v.id, action: "restored" } })).toBe(1);
  });

  it("gövde doğrulaması: approve boolean, position sonlu sayı", async () => {
    const v = await rejectedAt(1);
    expect((await restore(v.id, {})).status).toBe(400);
    expect((await restore(v.id, { approve: "evet" })).status).toBe(400);
    expect((await restore(v.id, { approve: false, position: "2" })).status).toBe(400);
    expect((await db.post.findUniqueOrThrow({ where: { id: v.id } })).status).toBe("rejected");
  });

  it("başka origin'den 403 (CSRF), video yerinde", async () => {
    const v = await rejectedAt(1);
    expect((await restore(v.id, { approve: false }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await db.post.findUniqueOrThrow({ where: { id: v.id } })).status).toBe("rejected");
  });
});

// ─── Kuyruk işlemleri ─────────────────────────────────────────────────────

describe("kuyruktan çıkar / tekrar dene / sona at", () => {
  it("kuyruktan çıkar: queuePosition null, video silinmez", async () => {
    const v = await createPortalPost(agencyId, clientId);
    expect((await removeVideo(post(`/api/portal/videos/${v.id}/remove`), idParams(v.id))).status).toBe(200);
    expect((await db.post.findUniqueOrThrow({ where: { id: v.id } })).queuePosition).toBeNull();
  });

  it("yayınlanırken kuyruktan çıkarılamaz (409)", async () => {
    const v = await createPortalPost(agencyId, clientId, { publishStatus: "publishing" });
    expect((await removeVideo(post(`/api/portal/videos/${v.id}/remove`), idParams(v.id))).status).toBe(409);
  });

  it("tekrar dene: failed → idle + slotAt temizlenir, yayın çağrılmaz; idle'da 409", async () => {
    const v = await createPortalPost(agencyId, clientId, { status: "approved", publishStatus: "failed" });
    await db.post.update({ where: { id: v.id }, data: { slotAt: new Date(), publishError: "IG hatası" } });
    expect((await retryVideo(post(`/api/portal/videos/${v.id}/retry`), idParams(v.id))).status).toBe(200);
    const row = await db.post.findUniqueOrThrow({ where: { id: v.id } });
    expect(row).toMatchObject({ publishStatus: "idle", slotAt: null, publishError: null });
    expect(publishApprovedPost).not.toHaveBeenCalled();
    expect((await retryVideo(post(`/api/portal/videos/${v.id}/retry`), idParams(v.id))).status).toBe(409);
  });

  it("sona at: hatalı video kuyruğun sonuna gider ve idle olur", async () => {
    const failed = await createPortalPost(agencyId, clientId, { queuePosition: 1, publishStatus: "failed" });
    const other = await createPortalPost(agencyId, clientId, { queuePosition: 2 });
    expect((await toEndVideo(post(`/api/portal/videos/${failed.id}/to-end`), idParams(failed.id))).status).toBe(200);
    expect(await queueOrder()).toEqual([other.id, failed.id]);
    expect((await db.post.findUniqueOrThrow({ where: { id: failed.id } })).publishStatus).toBe("idle");
  });

  it("sona at: idle videonun slotAt'ine DOKUNMAZ (tick onu sahiplenmiş olabilir)", async () => {
    const claimed = await createPortalPost(agencyId, clientId, { queuePosition: 1 });
    await createPortalPost(agencyId, clientId, { queuePosition: 2 });
    const slotAt = new Date("2026-09-25T16:00:00Z");
    await db.post.update({ where: { id: claimed.id }, data: { slotAt } });
    await toEndVideo(post(`/api/portal/videos/${claimed.id}/to-end`), idParams(claimed.id));
    expect((await db.post.findUniqueOrThrow({ where: { id: claimed.id } })).slotAt).toEqual(slotAt);
  });

  it("sona at: kuyruktan çıkarılmış videoyu geri alır; reddedileni almaz", async () => {
    const removed = await createPortalPost(agencyId, clientId, { queuePosition: null });
    const rejected = await createPortalPost(agencyId, clientId, { queuePosition: null, status: "rejected" });
    expect((await toEndVideo(post(`/api/portal/videos/${removed.id}/to-end`), idParams(removed.id))).status).toBe(200);
    expect(await queueOrder()).toEqual([removed.id]);
    expect((await toEndVideo(post(`/api/portal/videos/${rejected.id}/to-end`), idParams(rejected.id))).status).toBe(409);
  });
});

describe("POST regenerate", () => {
  it("caption'ı pending'e çeker, notla kuyruğa atar; onaylıysa onay geri alınır", async () => {
    const v = await createPortalPost(agencyId, clientId, { status: "approved" });
    const res = await regenerateVideo(
      post(`/api/portal/videos/${v.id}/regenerate`, { note: "daha kısa olsun" }),
      idParams(v.id)
    );
    expect(res.status).toBe(200);
    const row = await db.post.findUniqueOrThrow({ where: { id: v.id } });
    expect(row).toMatchObject({ captionStatus: "pending", status: "pending" });
    expect(enqueueCaption).toHaveBeenCalledWith(v.id, { note: "daha kısa olsun" });
  });

  it("üretim sürerken ikinci iş atılmaz (409)", async () => {
    const v = await createPortalPost(agencyId, clientId, { captionStatus: "generating" });
    const res = await regenerateVideo(post(`/api/portal/videos/${v.id}/regenerate`, {}), idParams(v.id));
    expect(res.status).toBe(409);
    expect(enqueueCaption).not.toHaveBeenCalled();
  });

  it("taze pending reddedilir, takılmış pending (10 dk+) kurtarılabilir", async () => {
    const v = await createPortalPost(agencyId, clientId, { captionStatus: "pending" });
    expect((await regenerateVideo(post(`/api/portal/videos/${v.id}/regenerate`, {}), idParams(v.id))).status).toBe(409);
    await db.$executeRaw`UPDATE "Post" SET "updatedAt" = now() - interval '11 minutes' WHERE id = ${v.id}`;
    expect((await regenerateVideo(post(`/api/portal/videos/${v.id}/regenerate`, {}), idParams(v.id))).status).toBe(200);
    expect(enqueueCaption).toHaveBeenCalledWith(v.id, {});
  });

  it("500 karakterden uzun not 400", async () => {
    const v = await createPortalPost(agencyId, clientId);
    const res = await regenerateVideo(
      post(`/api/portal/videos/${v.id}/regenerate`, { note: "x".repeat(501) }),
      idParams(v.id)
    );
    expect(res.status).toBe(400);
  });
});

// ─── Kalıcı silme ─────────────────────────────────────────────────────────

describe("DELETE /api/portal/videos/[id] — kuyruk dışı videoyu kalıcı siler", () => {
  const del = (id: string, extra: { origin?: string; cookie?: string } = {}) =>
    deleteVideo(
      portalRequest(`/api/portal/videos/${id}`, {
        method: "DELETE",
        cookie: extra.cookie ?? cookie,
        origin: extra.origin,
      }),
      idParams(id)
    );

  /** Şemada cascade yok: silme yolunun temizlemesi gereken bütün çocuk satırlar. */
  async function withChildren(id: string) {
    await db.approvalAudit.create({ data: { postId: id, action: "rejected", ip: "1.1.1.1" } });
    await db.postRevision.create({
      data: { postId: id, round: 1, actor: "client", event: "revision_requested", caption: "eski" },
    });
    await db.postImage.create({ data: { postId: id, url: "https://ornek/1.jpg" } });
    await db.approvalLink.create({
      data: { postId: id, token: `tok-${id}`, expiresAt: new Date(Date.now() + 86_400_000) },
    });
    return db.slotRun.create({
      data: { clientId, slotAt: new Date("2026-09-20T16:00:00Z"), postId: id, outcome: "failed" },
    });
  }

  async function childCount(id: string) {
    return {
      audits: await db.approvalAudit.count({ where: { postId: id } }),
      revisions: await db.postRevision.count({ where: { postId: id } }),
      images: await db.postImage.count({ where: { postId: id } }),
      links: await db.approvalLink.count({ where: { postId: id } }),
    };
  }

  it("kuyruktan çıkarılan video silinir: çocuk satırlar gider, SlotRun kalır ama bağı kopar, R2 temizlenir", async () => {
    const v = await createPortalPost(agencyId, clientId, {
      queuePosition: null,
      frameKeys: [0, 1].map((i) => `clients/${clientId}/frames/pX/${i}.jpg`),
    });
    const run = await withChildren(v.id);

    const res = await del(v.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await db.post.findUnique({ where: { id: v.id } })).toBeNull();
    expect(await childCount(v.id)).toEqual({ audits: 0, revisions: 0, images: 0, links: 0 });
    // Slot kaydı "bu slot işlendi" demek; silinseydi tick geçmiş slotu yeniden koşardı.
    const after = await db.slotRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after).toMatchObject({ postId: null, outcome: "failed" });

    const keys = vi.mocked(deleteObject).mock.calls.map(([key]) => key).sort();
    expect(keys).toEqual([v.videoKey!, ...v.frameKeys].sort());
  });

  it("reddedilen video silinir", async () => {
    const v = await createPortalPost(agencyId, clientId, { queuePosition: null, status: "rejected" });
    await withChildren(v.id);
    expect((await del(v.id)).status).toBe(200);
    expect(await db.post.findUnique({ where: { id: v.id } })).toBeNull();
    expect(deleteObject).toHaveBeenCalledWith(v.videoKey);
  });

  it("kuyruktaki video 409 — satır, çocukları ve R2 nesnesi yerinde (transaction geri sarılır)", async () => {
    const v = await createPortalPost(agencyId, clientId, { queuePosition: 3 });
    const run = await withChildren(v.id);
    const res = await del(v.id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Yalnızca kuyruk dışındaki videolar silinebilir");
    expect((await db.post.findUniqueOrThrow({ where: { id: v.id } })).queuePosition).toBe(3);
    expect(await childCount(v.id)).toEqual({ audits: 1, revisions: 1, images: 1, links: 1 });
    expect((await db.slotRun.findUniqueOrThrow({ where: { id: run.id } })).postId).toBe(v.id);
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("yayınlanan, yayınlanmakta olan ve yüklemesi bitmemiş video silinmez (409)", async () => {
    const published = await createPortalPost(agencyId, clientId, {
      queuePosition: null,
      status: "approved",
      publishStatus: "published",
    });
    const publishing = await createPortalPost(agencyId, clientId, {
      queuePosition: null,
      status: "approved",
      publishStatus: "publishing",
    });
    const draft = await createPortalPost(agencyId, clientId, { queuePosition: null, status: "draft" });
    for (const v of [published, publishing, draft]) {
      expect((await del(v.id)).status).toBe(409);
      expect(await db.post.findUnique({ where: { id: v.id } })).not.toBeNull();
    }
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("ikinci silme 404 (video artık yok)", async () => {
    const v = await createPortalPost(agencyId, clientId, { queuePosition: null });
    expect((await del(v.id)).status).toBe(200);
    expect((await del(v.id)).status).toBe(404);
    expect(deleteObject).toHaveBeenCalledTimes(2); // ilk silmedeki video + 1 kare
  });

  it("oturum yoksa 401, yabancı Origin 403 — ikisinde de hiçbir şey silinmez", async () => {
    const v = await createPortalPost(agencyId, clientId, { queuePosition: null });
    expect((await del(v.id, { cookie: "" })).status).toBe(401);
    expect((await del(v.id, { origin: "https://kotu.example" })).status).toBe(403);
    expect(await db.post.findUnique({ where: { id: v.id } })).not.toBeNull();
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("R2 hatası yanıtı değiştirmez: kayıt silinir, 200 döner", async () => {
    const v = await createPortalPost(agencyId, clientId, { queuePosition: null });
    vi.mocked(deleteObject).mockResolvedValue(false);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await del(v.id)).status).toBe(200);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("nesne silinemedi"));
    } finally {
      spy.mockRestore();
    }
    expect(await db.post.findUnique({ where: { id: v.id } })).toBeNull();
  });

  it("R2 yapılandırılmamışsa nesne silme atlanır, kayıt yine silinir", async () => {
    vi.mocked(r2Configured).mockReturnValue(false);
    const v = await createPortalPost(agencyId, clientId, { queuePosition: null });
    expect((await del(v.id)).status).toBe(200);
    expect(deleteObject).not.toHaveBeenCalled();
    expect(await db.post.findUnique({ where: { id: v.id } })).toBeNull();
  });

  it("müşteri önekinde olmayan anahtar R2'den silinmez", async () => {
    const v = await createPortalPost(agencyId, clientId, {
      queuePosition: null,
      videoKey: "clients/baskaMusteri/videos/x.mp4",
      frameKeys: [`clients/${clientId}/frames/x/0.jpg`],
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await del(v.id)).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
    expect(vi.mocked(deleteObject).mock.calls.map(([key]) => key)).toEqual([
      `clients/${clientId}/frames/x/0.jpg`,
    ]);
  });
});
