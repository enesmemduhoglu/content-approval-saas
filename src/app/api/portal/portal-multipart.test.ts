import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V7b — çok parçalı yükleme route'ları: başlatma (upload), parça imzası
 * (parts) ve birleştirme (complete). R2 mock'lu; gerçek bucket'a karşı deneme
 * `scripts/r2-parcali-dene.ts`'te.
 */

vi.mock("@/lib/storage-r2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage-r2")>();
  return {
    ...actual,
    r2Configured: vi.fn(() => true),
    signPutUrl: vi.fn(async (key: string) => `https://acc.r2.cloudflarestorage.com/put/${key}`),
    signGetUrl: vi.fn(async (key: string) => `https://acc.r2.cloudflarestorage.com/get/${key}`),
    headObject: vi.fn(async () => ({ size: 40 * 1024 * 1024, contentType: "video/mp4" })),
    deleteObject: vi.fn(async () => true),
    createMultipartUpload: vi.fn(async () => "r2-upload-id"),
    signUploadPartUrl: vi.fn(
      async (key: string, uploadId: string, n: number) =>
        `https://acc.r2.cloudflarestorage.com/part/${key}?uploadId=${uploadId}&partNumber=${n}`
    ),
    completeMultipartUpload: vi.fn(async () => undefined),
    abortMultipartUpload: vi.fn(async () => undefined),
  };
});
vi.mock("@/lib/qstash", () => ({
  enqueueCaption: vi.fn(async () => ({ queued: true, messageId: "m-1" })),
}));

import { db } from "@/lib/db";
import { resetRateLimiter } from "@/lib/rate-limit";
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  headObject,
  signPutUrl,
  signUploadPartUrl,
} from "@/lib/storage-r2";
import { enqueueCaption } from "@/lib/qstash";
import { MAX_PART_NUMBER, MULTIPART_PART_SIZE } from "@/lib/portal-validation";
import { createAgency, createClient, resetDb } from "@tests/helpers/db";
import {
  createClientUser,
  createPortalPost,
  idParams,
  portalCookie,
  portalRequest,
} from "@tests/helpers/portal";

import { POST as upload } from "./upload/route";
import { POST as signParts } from "./videos/[id]/parts/route";
import { POST as completeVideo } from "./videos/[id]/complete/route";

const MB = 1024 * 1024;
const etag = (n: number) => `"${n.toString(16).padStart(32, "0")}"`;

let agencyId: string;
let clientId: string;
let cookie: string;

beforeEach(async () => {
  await resetDb();
  resetRateLimiter();
  vi.clearAllMocks();
  vi.mocked(headObject).mockResolvedValue({ size: 40 * MB, contentType: "video/mp4" });
  vi.mocked(createMultipartUpload).mockResolvedValue("r2-upload-id");
  vi.mocked(completeMultipartUpload).mockResolvedValue(undefined);
  const agency = await createAgency();
  const client = await createClient(agency.id);
  agencyId = agency.id;
  clientId = client.id;
  cookie = portalCookie(await createClientUser(client.id));
});

const post = (path: string, body?: unknown, extra: { origin?: string; cookie?: string } = {}) =>
  portalRequest(path, { method: "POST", cookie: extra.cookie ?? cookie, body, origin: extra.origin });

/** Çok parçalı yüklemesi açık bir taslak. */
async function multipartDraft(uploadId: string | null = "db-upload-id") {
  const draft = await createPortalPost(agencyId, clientId, {
    status: "draft",
    queuePosition: null,
    captionStatus: "pending",
    frameKeys: [],
  });
  return db.post.update({ where: { id: draft.id }, data: { uploadId } });
}

// ─── Başlatma ─────────────────────────────────────────────────────────────

describe("POST /api/portal/upload — çok parçalı", () => {
  it("küçük dosya eski yoldan: tek imzalı PUT, R2'de çok parçalı yükleme açılmaz", async () => {
    const res = await upload(post("/api/portal/upload", { files: [{ contentType: "video/mp4", size: 15 * MB }] }));
    expect(res.status).toBe(201);
    const { items } = await res.json();
    expect(items[0]).toMatchObject({ multipart: false });
    expect(items[0].videoPutUrl).toContain(`clients/${clientId}/videos/`);
    expect(createMultipartUpload).not.toHaveBeenCalled();
    expect((await db.post.findFirstOrThrow({ where: { clientId } })).uploadId).toBeNull();
  });

  it("≥ 16 MB: yükleme açılır, kimlik YALNIZCA DB'ye yazılır; istemci postId + parça boyutu alır", async () => {
    const res = await upload(
      post("/api/portal/upload", {
        files: [
          { contentType: "video/mp4", size: 16 * MB },
          { contentType: "video/quicktime", size: 2 * MB },
        ],
      })
    );
    expect(res.status).toBe(201);
    const text = await res.text();
    // Yanıtın hiçbir yerinde R2 kimliği yok.
    expect(text).not.toContain("r2-upload-id");
    const { items } = JSON.parse(text);
    expect(items[0]).toEqual({
      postId: expect.any(String),
      multipart: true,
      partSize: MULTIPART_PART_SIZE,
      framePutUrls: expect.any(Array),
    });
    expect(items[0].framePutUrls).toHaveLength(6);
    expect(items[1].multipart).toBe(false);

    const big = await db.post.findUniqueOrThrow({ where: { id: items[0].postId } });
    expect(big.uploadId).toBe("r2-upload-id");
    expect(big.status).toBe("draft");
    expect(createMultipartUpload).toHaveBeenCalledWith(big.videoKey, "video/mp4");
    // Büyük videonun tek PUT URL'i imzalanmaz.
    expect(vi.mocked(signPutUrl).mock.calls.map(([key]) => key)).not.toContain(big.videoKey);
    const small = await db.post.findUniqueOrThrow({ where: { id: items[1].postId } });
    expect(small.uploadId).toBeNull();
  });

  it("R2 yüklemeyi açamazsa 502: açılanlar iptal edilir, bu istekteki taslaklar silinir", async () => {
    vi.mocked(createMultipartUpload)
      .mockResolvedValueOnce("ilk-id")
      .mockRejectedValueOnce(new Error("R2 down"));
    const res = await upload(
      post("/api/portal/upload", {
        files: [
          { contentType: "video/mp4", size: 20 * MB },
          { contentType: "video/mp4", size: 30 * MB },
        ],
      })
    );
    expect(res.status).toBe(502);
    expect(abortMultipartUpload).toHaveBeenCalledWith(expect.stringContaining(`clients/${clientId}/videos/`), "ilk-id");
    expect(await db.post.count()).toBe(0);
  });
});

// ─── Parça imzası ─────────────────────────────────────────────────────────

describe("POST /api/portal/videos/[id]/parts", () => {
  it("istenen parçalar için DB'deki kimlikle imzalı URL döner; gövdedeki uploadId yok sayılır", async () => {
    const d = await multipartDraft();
    const res = await signParts(
      post(`/api/portal/videos/${d.id}/parts`, { partNumbers: [3, 1, 2], uploadId: "saldirgan-id" }),
      idParams(d.id)
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.parts.map((p: { partNumber: number }) => p.partNumber)).toEqual([3, 1, 2]);
    expect(data.expiresIn).toBe(15 * 60);
    expect(data.framePutUrls).toBeUndefined();
    for (const call of vi.mocked(signUploadPartUrl).mock.calls) {
      expect(call[0]).toBe(d.videoKey);
      expect(call[1]).toBe("db-upload-id");
    }
    expect(JSON.stringify(data)).not.toContain("saldirgan-id");
  });

  it("includeFrames: taze kare URL'leri de döner (devam eden yükleme)", async () => {
    const d = await multipartDraft();
    const res = await signParts(
      post(`/api/portal/videos/${d.id}/parts`, { partNumbers: [1], includeFrames: true }),
      idParams(d.id)
    );
    const data = await res.json();
    expect(data.framePutUrls).toHaveLength(6);
    expect(data.framePutUrls[0]).toContain(`clients/${clientId}/frames/${d.id}/0.jpg`);
  });

  it("başka müşterinin postu 404 — imza üretilmez", async () => {
    const other = await createClient(agencyId);
    const foreign = await createPortalPost(agencyId, other.id, { status: "draft", queuePosition: null });
    await db.post.update({ where: { id: foreign.id }, data: { uploadId: "yabanci-id" } });
    const res = await signParts(post(`/api/portal/videos/${foreign.id}/parts`, { partNumbers: [1] }), idParams(foreign.id));
    expect(res.status).toBe(404);
    expect(signUploadPartUrl).not.toHaveBeenCalled();
  });

  it("ajans postu (source: agency) portaldan imzalanamaz — 404", async () => {
    const d = await multipartDraft();
    await db.post.update({ where: { id: d.id }, data: { source: "agency" } });
    const res = await signParts(post(`/api/portal/videos/${d.id}/parts`, { partNumbers: [1] }), idParams(d.id));
    expect(res.status).toBe(404);
  });

  it("taslak değilse 409", async () => {
    const d = await multipartDraft();
    await db.post.update({ where: { id: d.id }, data: { status: "pending" } });
    const res = await signParts(post(`/api/portal/videos/${d.id}/parts`, { partNumbers: [1] }), idParams(d.id));
    expect(res.status).toBe(409);
  });

  it("uploadId yoksa (tek PUT yolu) 400", async () => {
    const d = await multipartDraft(null);
    const res = await signParts(post(`/api/portal/videos/${d.id}/parts`, { partNumbers: [1] }), idParams(d.id));
    expect(res.status).toBe(400);
    expect(signUploadPartUrl).not.toHaveBeenCalled();
  });

  it.each([
    ["boş", []],
    ["dizi değil", "1"],
    ["sıfır", [0]],
    ["sınır üstü", [MAX_PART_NUMBER + 1]],
    ["kesirli", [1.5]],
    ["tekrar", [2, 2]],
    ["tek istekte 21 parça", Array.from({ length: 21 }, (_, i) => i + 1)],
  ])("geçersiz parça listesi (%s) 400 (field: partNumbers)", async (_, partNumbers) => {
    const d = await multipartDraft();
    const res = await signParts(post(`/api/portal/videos/${d.id}/parts`, { partNumbers }), idParams(d.id));
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("partNumbers");
  });

  it("oturum yoksa 401, yabancı Origin 403", async () => {
    const d = await multipartDraft();
    const noSession = await signParts(
      post(`/api/portal/videos/${d.id}/parts`, { partNumbers: [1] }, { cookie: "" }),
      idParams(d.id)
    );
    expect(noSession.status).toBe(401);
    const foreignOrigin = await signParts(
      post(`/api/portal/videos/${d.id}/parts`, { partNumbers: [1] }, { origin: "https://kotu.example" }),
      idParams(d.id)
    );
    expect(foreignOrigin.status).toBe(403);
    expect(signUploadPartUrl).not.toHaveBeenCalled();
  });
});

// ─── Birleştirme ──────────────────────────────────────────────────────────

describe("POST /api/portal/videos/[id]/complete — çok parçalı", () => {
  const parts = [2, 1, 3].map((n) => ({ partNumber: n, etag: etag(n) }));

  it("DB'deki kimlikle birleştirir, kimliği temizler ve kuyruğa ekler; gövdedeki uploadId yok sayılır", async () => {
    const d = await multipartDraft();
    const res = await completeVideo(
      post(`/api/portal/videos/${d.id}/complete`, { parts, uploadId: "saldirgan-id" }),
      idParams(d.id)
    );
    expect(res.status).toBe(200);
    expect(completeMultipartUpload).toHaveBeenCalledWith(d.videoKey, "db-upload-id", [
      { partNumber: 1, etag: etag(1) },
      { partNumber: 2, etag: etag(2) },
      { partNumber: 3, etag: etag(3) },
    ]);
    const row = await db.post.findUniqueOrThrow({ where: { id: d.id } });
    expect(row.status).toBe("pending");
    expect(row.uploadId).toBeNull();
    expect(row.queuePosition).not.toBeNull();
    expect(enqueueCaption).toHaveBeenCalledWith(d.id);
  });

  it("parça listesi yoksa 400 — R2'ye gidilmez", async () => {
    const d = await multipartDraft();
    const res = await completeVideo(post(`/api/portal/videos/${d.id}/complete`), idParams(d.id));
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("parts");
    expect(completeMultipartUpload).not.toHaveBeenCalled();
  });

  it.each([
    ["eksik parça (2 yok)", [1, 3].map((n) => ({ partNumber: n, etag: etag(n) }))],
    ["1'den başlamıyor", [2, 3].map((n) => ({ partNumber: n, etag: etag(n) }))],
    ["aynı parça iki kez", [1, 1].map((n) => ({ partNumber: n, etag: etag(n) }))],
    ["ETag yok", [{ partNumber: 1 }]],
    ["ETag'de keyfi metin", [{ partNumber: 1, etag: "<xml>" }]],
    ["boş liste", []],
  ])("yanlış parça listesi (%s) 400 — R2'ye gidilmez, taslak kalır", async (_, bad) => {
    const d = await multipartDraft();
    const res = await completeVideo(post(`/api/portal/videos/${d.id}/complete`, { parts: bad }), idParams(d.id));
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("parts");
    expect(completeMultipartUpload).not.toHaveBeenCalled();
    expect((await db.post.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("draft");
  });

  it.each(["InvalidPart", "InvalidPartOrder", "EntityTooSmall"])(
    "R2 %s → 400 (field: parts), kimlik ve taslak yerinde kalır",
    async (code) => {
      const d = await multipartDraft();
      vi.mocked(completeMultipartUpload).mockRejectedValueOnce(Object.assign(new Error(code), { name: code }));
      const res = await completeVideo(post(`/api/portal/videos/${d.id}/complete`, { parts }), idParams(d.id));
      expect(res.status).toBe(400);
      expect((await res.json()).field).toBe("parts");
      const row = await db.post.findUniqueOrThrow({ where: { id: d.id } });
      expect(row.status).toBe("draft");
      expect(row.uploadId).toBe("db-upload-id");
      expect(enqueueCaption).not.toHaveBeenCalled();
    }
  );

  it("R2 NoSuchUpload + nesne duruyor → önceki birleştirmenin tekrarı, 200", async () => {
    const d = await multipartDraft();
    vi.mocked(completeMultipartUpload).mockRejectedValueOnce(
      Object.assign(new Error("NoSuchUpload"), { name: "NoSuchUpload" })
    );
    const res = await completeVideo(post(`/api/portal/videos/${d.id}/complete`, { parts }), idParams(d.id));
    expect(res.status).toBe(200);
    expect((await db.post.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("pending");
  });

  it("R2 NoSuchUpload + nesne yok → 400, kuyruğa girmez", async () => {
    const d = await multipartDraft();
    vi.mocked(completeMultipartUpload).mockRejectedValueOnce(
      Object.assign(new Error("NoSuchUpload"), { name: "NoSuchUpload" })
    );
    vi.mocked(headObject).mockResolvedValue(null);
    const res = await completeVideo(post(`/api/portal/videos/${d.id}/complete`, { parts }), idParams(d.id));
    expect(res.status).toBe(400);
    expect((await db.post.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("draft");
  });

  it("R2'nin diğer hataları 502 — taslak ve kimlik yerinde, yeniden denenebilir", async () => {
    const d = await multipartDraft();
    vi.mocked(completeMultipartUpload).mockRejectedValueOnce(
      Object.assign(new Error("boom"), { name: "InternalError" })
    );
    const res = await completeVideo(post(`/api/portal/videos/${d.id}/complete`, { parts }), idParams(d.id));
    expect(res.status).toBe(502);
    expect((await db.post.findUniqueOrThrow({ where: { id: d.id } })).uploadId).toBe("db-upload-id");
  });

  it("birleşen dosya 300 MB'ı aşıyorsa mevcut boyut kontrolü yine 400 (imzalı parça PUT'u boyut sınırlamıyor)", async () => {
    const d = await multipartDraft();
    vi.mocked(headObject).mockResolvedValue({ size: 301 * MB, contentType: "video/mp4" });
    const res = await completeVideo(post(`/api/portal/videos/${d.id}/complete`, { parts }), idParams(d.id));
    expect(res.status).toBe(400);
    expect((await db.post.findUniqueOrThrow({ where: { id: d.id } })).queuePosition).toBeNull();
  });

  it("başka müşterinin taslağı 404 — birleştirilmez", async () => {
    const other = await createClient(agencyId);
    const foreign = await createPortalPost(agencyId, other.id, { status: "draft", queuePosition: null });
    await db.post.update({ where: { id: foreign.id }, data: { uploadId: "yabanci-id" } });
    const res = await completeVideo(post(`/api/portal/videos/${foreign.id}/complete`, { parts }), idParams(foreign.id));
    expect(res.status).toBe(404);
    expect(completeMultipartUpload).not.toHaveBeenCalled();
  });

  it("tek PUT taslağı gövdesiz tamamlanır; gövdede parça gelse de R2 birleştirmesi çağrılmaz", async () => {
    const d = await multipartDraft(null);
    const res = await completeVideo(post(`/api/portal/videos/${d.id}/complete`, { parts }), idParams(d.id));
    expect(res.status).toBe(200);
    expect(completeMultipartUpload).not.toHaveBeenCalled();
  });
});
