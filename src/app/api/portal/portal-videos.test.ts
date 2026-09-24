import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/storage-r2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage-r2")>();
  return {
    ...actual,
    r2Configured: vi.fn(() => true),
    signPutUrl: vi.fn(async (key: string) => `https://acc.r2.cloudflarestorage.com/put/${key}`),
    signGetUrl: vi.fn(async (key: string) => `https://acc.r2.cloudflarestorage.com/get/${key}`),
    headObject: vi.fn(async () => ({ size: 1000, contentType: "video/mp4" })),
    deleteObject: vi.fn(async () => true),
  };
});
vi.mock("@/lib/qstash", () => ({
  enqueueCaption: vi.fn(async () => ({ queued: true, messageId: "m-1" })),
}));
// Onay yayın tetiklememeli: modül mock'lanıyor ki olası bir çağrı yakalansın.
vi.mock("@/lib/publish-post", () => ({
  publishApprovedPost: vi.fn(),
  resumePublish: vi.fn(),
}));

import { db } from "@/lib/db";
import { resetRateLimiter } from "@/lib/rate-limit";
import { headObject, r2Configured } from "@/lib/storage-r2";
import { enqueueCaption } from "@/lib/qstash";
import { publishApprovedPost } from "@/lib/publish-post";
import { PORTAL_RATE_LIMIT_MAX } from "@/lib/portal-route";
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
import { GET as getVideo, PATCH as patchVideo } from "./videos/[id]/route";
import { POST as completeVideo } from "./videos/[id]/complete/route";
import { POST as moveVideo } from "./videos/[id]/move/route";
import { POST as decideVideo } from "./videos/[id]/decision/route";
import { POST as removeVideo } from "./videos/[id]/remove/route";
import { POST as retryVideo } from "./videos/[id]/retry/route";
import { POST as toEndVideo } from "./videos/[id]/to-end/route";
import { POST as regenerateVideo } from "./videos/[id]/regenerate/route";

let agencyId: string;
let clientId: string;
let cookie: string;

beforeEach(async () => {
  await resetDb();
  resetRateLimiter();
  vi.mocked(enqueueCaption).mockClear();
  vi.mocked(publishApprovedPost).mockClear();
  vi.mocked(headObject).mockReset();
  vi.mocked(headObject).mockResolvedValue({ size: 1000, contentType: "video/mp4" });
  vi.mocked(r2Configured).mockReturnValue(true);
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
    expect(row.queuePosition).toBe(8);
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
    expect(positions).toEqual([1, 2, 3]);
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

  it("tekrar dene: failed → idle, yayın çağrılmaz; idle'da 409", async () => {
    const v = await createPortalPost(agencyId, clientId, { status: "approved", publishStatus: "failed" });
    expect((await retryVideo(post(`/api/portal/videos/${v.id}/retry`), idParams(v.id))).status).toBe(200);
    expect((await db.post.findUniqueOrThrow({ where: { id: v.id } })).publishStatus).toBe("idle");
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
