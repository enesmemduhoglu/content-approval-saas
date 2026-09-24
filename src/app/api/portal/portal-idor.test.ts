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

import { db } from "@/lib/db";
import { resetRateLimiter } from "@/lib/rate-limit";
import { signGetUrl, signPutUrl } from "@/lib/storage-r2";
import { enqueueCaption } from "@/lib/qstash";
import { createAgency, createClient, resetDb } from "@tests/helpers/db";
import {
  createClientUser,
  createPortalPost,
  idParams,
  portalCookie,
  portalRequest,
} from "@tests/helpers/portal";

import { GET as listVideos } from "./videos/route";
import { GET as getVideo, PATCH as patchVideo } from "./videos/[id]/route";
import { POST as completeVideo } from "./videos/[id]/complete/route";
import { POST as moveVideo } from "./videos/[id]/move/route";
import { POST as decideVideo } from "./videos/[id]/decision/route";
import { POST as removeVideo } from "./videos/[id]/remove/route";
import { POST as retryVideo } from "./videos/[id]/retry/route";
import { POST as toEndVideo } from "./videos/[id]/to-end/route";
import { POST as regenerateVideo } from "./videos/[id]/regenerate/route";
import { GET as getSettings, PUT as putSettings } from "./settings/route";

/**
 * IDOR — README §5 "A müşterisi B'nin kuyruğunu göremez, taşıyamaz, imzalı
 * URL'sini alamaz". Her portal route'u için ayrı test: A'nın oturumu B'nin
 * post id'siyle çağrılır; yanıt 404, B'nin satırı değişmemiş, B'nin anahtarına
 * imza üretilmemiş olmalı.
 *
 * B BAŞKA bir ajansın müşterisi; aynı ajans içindeki iki müşteri için de ayrı
 * bir test var (portal kapsamı ajans değil MÜŞTERİ).
 */

type Ctx = Awaited<ReturnType<typeof setup>>;

async function setup() {
  const agencyA = await createAgency();
  const agencyB = await createAgency();
  const clientA = await createClient(agencyA.id);
  const clientB = await createClient(agencyB.id);
  const userA = await createClientUser(clientA.id);
  const userB = await createClientUser(clientB.id);
  const postA = await createPortalPost(agencyA.id, clientA.id, { queuePosition: 1 });
  const postB = await createPortalPost(agencyB.id, clientB.id, {
    queuePosition: 1,
    publishStatus: "failed",
  });
  const postB2 = await createPortalPost(agencyB.id, clientB.id, { queuePosition: 2 });
  return { agencyA, agencyB, clientA, clientB, userA, userB, postA, postB, postB2, cookieA: portalCookie(userA) };
}

async function snapshot(id: string) {
  return db.post.findUniqueOrThrow({ where: { id } });
}

let ctx: Ctx;

beforeEach(async () => {
  await resetDb();
  resetRateLimiter();
  vi.mocked(signGetUrl).mockClear();
  vi.mocked(signPutUrl).mockClear();
  vi.mocked(enqueueCaption).mockClear();
  ctx = await setup();
});

function signedKeys(): string[] {
  return vi.mocked(signGetUrl).mock.calls.map(([key]) => key);
}

describe("IDOR — A müşterisinin kullanıcısı B'nin videosuna dokunamaz", () => {
  it("GET /api/portal/videos: listede yalnızca kendi videoları, imza yalnızca kendi anahtarına", async () => {
    const res = await listVideos(portalRequest("/api/portal/videos", { cookie: ctx.cookieA }));
    expect(res.status).toBe(200);
    const data = await res.json();
    const ids = [...data.queue, ...data.outside, ...data.history].map((v: { id: string }) => v.id);
    expect(ids).toEqual([ctx.postA.id]);
    expect(signedKeys().every((key) => key.startsWith(`clients/${ctx.clientA.id}/`))).toBe(true);
    // Ham anahtar yanıta sızmaz.
    expect(JSON.stringify(data)).not.toContain("videoKey");
  });

  it("GET /api/portal/videos/[id]: B'nin videosu 404, imzalı URL üretilmez", async () => {
    const res = await getVideo(
      portalRequest(`/api/portal/videos/${ctx.postB.id}`, { cookie: ctx.cookieA }),
      idParams(ctx.postB.id)
    );
    expect(res.status).toBe(404);
    expect(signGetUrl).not.toHaveBeenCalled();
  });

  it("PATCH caption: B'nin videosu 404, caption değişmez", async () => {
    const res = await patchVideo(
      portalRequest(`/api/portal/videos/${ctx.postB.id}`, {
        method: "PATCH",
        cookie: ctx.cookieA,
        body: { caption: "ele geçirildi" },
      }),
      idParams(ctx.postB.id)
    );
    expect(res.status).toBe(404);
    expect((await snapshot(ctx.postB.id)).caption).toBe("Hazır caption");
  });

  it("POST complete: B'nin taslağı tamamlanamaz, caption işi kuyruğa girmez", async () => {
    const draftB = await createPortalPost(ctx.agencyB.id, ctx.clientB.id, {
      status: "draft",
      queuePosition: null,
      captionStatus: "pending",
      frameKeys: [],
    });
    const res = await completeVideo(
      portalRequest(`/api/portal/videos/${draftB.id}/complete`, { method: "POST", cookie: ctx.cookieA }),
      idParams(draftB.id)
    );
    expect(res.status).toBe(404);
    expect((await snapshot(draftB.id)).status).toBe("draft");
    expect(enqueueCaption).not.toHaveBeenCalled();
  });

  it("POST move: B'nin videosu taşınamaz", async () => {
    const res = await moveVideo(
      portalRequest(`/api/portal/videos/${ctx.postB2.id}/move`, {
        method: "POST",
        cookie: ctx.cookieA,
        body: { beforeId: ctx.postB.id },
      }),
      idParams(ctx.postB2.id)
    );
    expect(res.status).toBe(404);
    expect((await snapshot(ctx.postB2.id)).queuePosition).toBe(2);
  });

  it("POST move: kendi videosu B'nin videosunu komşu gösteremez", async () => {
    const res = await moveVideo(
      portalRequest(`/api/portal/videos/${ctx.postA.id}/move`, {
        method: "POST",
        cookie: ctx.cookieA,
        body: { afterId: ctx.postB2.id },
      }),
      idParams(ctx.postA.id)
    );
    expect(res.status).toBe(409);
    expect((await snapshot(ctx.postA.id)).queuePosition).toBe(1);
  });

  it("POST decision (onay): B'nin videosu onaylanamaz, audit yazılmaz", async () => {
    const res = await decideVideo(
      portalRequest(`/api/portal/videos/${ctx.postB2.id}/decision`, {
        method: "POST",
        cookie: ctx.cookieA,
        body: { action: "approve" },
      }),
      idParams(ctx.postB2.id)
    );
    expect(res.status).toBe(404);
    expect((await snapshot(ctx.postB2.id)).status).toBe("pending");
    expect(await db.approvalAudit.count()).toBe(0);
  });

  it("POST decision (red): B'nin videosu reddedilemez", async () => {
    const res = await decideVideo(
      portalRequest(`/api/portal/videos/${ctx.postB2.id}/decision`, {
        method: "POST",
        cookie: ctx.cookieA,
        body: { action: "reject" },
      }),
      idParams(ctx.postB2.id)
    );
    expect(res.status).toBe(404);
    expect((await snapshot(ctx.postB2.id)).status).toBe("pending");
  });

  it("POST remove: B'nin videosu kuyruktan çıkarılamaz", async () => {
    const res = await removeVideo(
      portalRequest(`/api/portal/videos/${ctx.postB2.id}/remove`, { method: "POST", cookie: ctx.cookieA }),
      idParams(ctx.postB2.id)
    );
    expect(res.status).toBe(404);
    expect((await snapshot(ctx.postB2.id)).queuePosition).toBe(2);
  });

  it("POST retry: B'nin hatalı videosu idle'a çekilemez", async () => {
    const res = await retryVideo(
      portalRequest(`/api/portal/videos/${ctx.postB.id}/retry`, { method: "POST", cookie: ctx.cookieA }),
      idParams(ctx.postB.id)
    );
    expect(res.status).toBe(404);
    expect((await snapshot(ctx.postB.id)).publishStatus).toBe("failed");
  });

  it("POST to-end: B'nin videosu sona atılamaz", async () => {
    const res = await toEndVideo(
      portalRequest(`/api/portal/videos/${ctx.postB.id}/to-end`, { method: "POST", cookie: ctx.cookieA }),
      idParams(ctx.postB.id)
    );
    expect(res.status).toBe(404);
    expect((await snapshot(ctx.postB.id)).queuePosition).toBe(1);
  });

  it("POST regenerate: B'nin videosu için caption işi kuyruğa atılamaz", async () => {
    const res = await regenerateVideo(
      portalRequest(`/api/portal/videos/${ctx.postB.id}/regenerate`, {
        method: "POST",
        cookie: ctx.cookieA,
        body: { note: "kısa" },
      }),
      idParams(ctx.postB.id)
    );
    expect(res.status).toBe(404);
    expect((await snapshot(ctx.postB.id)).captionStatus).toBe("ready");
    expect(enqueueCaption).not.toHaveBeenCalled();
  });

  it("settings: A'nın kaydı B'nin ayarına yazılmaz, B'nin ayarı A'ya okunmaz", async () => {
    await db.publishSettings.create({
      data: { clientId: ctx.clientB.id, slots: ["08:00"], requireApproval: false },
    });
    const put = await putSettings(
      portalRequest("/api/portal/settings", {
        method: "PUT",
        cookie: ctx.cookieA,
        body: { slots: ["10:00"], timezone: "Europe/Istanbul", requireApproval: true, paused: false },
      })
    );
    expect(put.status).toBe(200);
    const b = await db.publishSettings.findUniqueOrThrow({ where: { clientId: ctx.clientB.id } });
    expect(b.slots).toEqual(["08:00"]);
    expect(b.requireApproval).toBe(false);

    const get = await getSettings(portalRequest("/api/portal/settings", { cookie: ctx.cookieA }));
    expect((await get.json()).settings.slots).toEqual(["10:00"]);
  });

  it("aynı AJANSIN iki müşterisi de birbirini göremez (kapsam müşteri, ajans değil)", async () => {
    const sibling = await createClient(ctx.agencyA.id);
    const siblingPost = await createPortalPost(ctx.agencyA.id, sibling.id);
    const res = await getVideo(
      portalRequest(`/api/portal/videos/${siblingPost.id}`, { cookie: ctx.cookieA }),
      idParams(siblingPost.id)
    );
    expect(res.status).toBe(404);
  });

  it("ajansın aynı müşteri için hazırladığı (source: agency) post portalda görünmez", async () => {
    const agencyPost = await db.post.create({
      data: {
        agencyId: ctx.agencyA.id,
        clientId: ctx.clientA.id,
        caption: "Ajans postu",
        status: "pending",
      },
    });
    const res = await decideVideo(
      portalRequest(`/api/portal/videos/${agencyPost.id}/decision`, {
        method: "POST",
        cookie: ctx.cookieA,
        body: { action: "approve" },
      }),
      idParams(agencyPost.id)
    );
    expect(res.status).toBe(404);
    expect((await snapshot(agencyPost.id)).status).toBe("pending");
  });

  it("çerezdeki clientId ile kullanıcının gerçek müşterisi uyuşmazsa oturum yok sayılır", async () => {
    // İmza geçerli ama kullanıcı başka müşteriye ait: satır doğrulaması yakalar.
    const forged = portalCookie({ id: ctx.userA.id, clientId: ctx.clientB.id });
    const res = await listVideos(portalRequest("/api/portal/videos", { cookie: forged }));
    expect(res.status).toBe(401);
  });

  it("silinmiş kullanıcının çerezi bir sonraki istekte ölür", async () => {
    await db.clientUser.delete({ where: { id: ctx.userA.id } });
    const res = await listVideos(portalRequest("/api/portal/videos", { cookie: ctx.cookieA }));
    expect(res.status).toBe(401);
  });
});
