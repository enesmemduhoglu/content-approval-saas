import { beforeEach, describe, expect, it, vi } from "vitest";

// Instagram'a gerçek istek atılmaz; yayın çekirdeği ayrıca instagram.test.ts'te
// test ediliyor. Burada onay akışıyla yayının BAĞLANTISI test edilir.
vi.mock("@/lib/instagram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/instagram")>();
  return { ...actual, publishToInstagram: vi.fn() };
});

import { GET, POST } from "./route";
import { db } from "@/lib/db";
import { publishToInstagram, IGError } from "@/lib/instagram";
import { resetRateLimiter, RATE_LIMIT_MAX } from "@/lib/rate-limit";
import {
  createAgency,
  createClient,
  createInstagramClient,
  createPendingPostWithLink,
  resetDb,
} from "@tests/helpers/db";

const mockPublish = vi.mocked(publishToInstagram);

function makeParams(token: string) {
  return { params: Promise.resolve({ token }) };
}

function getRequest(ip = "1.2.3.4") {
  return new Request("http://localhost/api/approve/x", {
    headers: { "x-forwarded-for": ip },
  });
}

function postRequest(body: unknown, ip = "1.2.3.4") {
  return new Request("http://localhost/api/approve/x", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

async function seedPendingPost(overrides: Parameters<typeof createPendingPostWithLink>[2] = {}) {
  const agency = await createAgency({ name: "Parlak Ajans" });
  const client = await createClient(agency.id);
  return createPendingPostWithLink(agency.id, client.id, overrides);
}

beforeEach(async () => {
  await resetDb();
  resetRateLimiter();
  vi.restoreAllMocks();
  mockPublish.mockReset();
});

describe("GET /api/approve/[token]", () => {
  it("geçerli token için post detayını döner", async () => {
    const { link } = await seedPendingPost();
    const res = await GET(getRequest(), makeParams(link.token));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.post.caption).toBe("Test caption");
    expect(data.post.agencyName).toBe("Parlak Ajans");
    expect(data.post.status).toBe("pending");
  });

  it("geçersiz token 404 döner", async () => {
    const res = await GET(getRequest(), makeParams("yok-boyle-bir-token"));
    expect(res.status).toBe(404);
  });

  it("süresi dolmuş token 410 döner", async () => {
    const { link } = await seedPendingPost({
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await GET(getRequest(), makeParams(link.token));
    expect(res.status).toBe(410);
  });
});

describe("POST /api/approve/[token]", () => {
  it("approve: durumu günceller, audit kaydını IP ile yazar", async () => {
    const { post, link } = await seedPendingPost();
    const res = await POST(
      postRequest({ action: "approve" }, "9.8.7.6"),
      makeParams(link.token)
    );
    expect(res.status).toBe(200);

    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.status).toBe("approved");

    const audits = await db.approvalAudit.findMany({ where: { postId: post.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("approved");
    expect(audits[0].ip).toBe("9.8.7.6");
  });

  it("x-forwarded-for yoksa audit IP'si 'unknown' yazılır (TENSION 4)", async () => {
    const { post, link } = await seedPendingPost();
    const res = await POST(
      new Request("http://localhost/api/approve/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      }),
      makeParams(link.token)
    );
    expect(res.status).toBe(200);
    const audit = await db.approvalAudit.findFirst({ where: { postId: post.id } });
    expect(audit?.ip).toBe("unknown");
  });

  it("reject: reddetme sebebini kaydeder", async () => {
    const { post, link } = await seedPendingPost();
    const res = await POST(
      postRequest({ action: "reject", rejectionReason: "Logo eski sürüm" }),
      makeParams(link.token)
    );
    expect(res.status).toBe(200);

    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.status).toBe("rejected");
    expect(updated?.rejectionReason).toBe("Logo eski sürüm");
  });

  it("geçersiz token 404 döner", async () => {
    const res = await POST(postRequest({ action: "approve" }), makeParams("yok"));
    expect(res.status).toBe(404);
  });

  it("süresi dolmuş token 410 döner, karar kabul etmez", async () => {
    const { post, link } = await seedPendingPost({
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await POST(postRequest({ action: "approve" }), makeParams(link.token));
    expect(res.status).toBe(410);
    const unchanged = await db.post.findUnique({ where: { id: post.id } });
    expect(unchanged?.status).toBe("pending");
  });

  it("zaten karar verilmiş post 409 döner, mevcut durumu bildirir", async () => {
    const { link } = await seedPendingPost({ status: "approved" });
    const res = await POST(postRequest({ action: "reject" }), makeParams(link.token));
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.status).toBe("approved");
  });

  it("geçersiz action 400 döner", async () => {
    const { link } = await seedPendingPost();
    const res = await POST(postRequest({ action: "belki" }), makeParams(link.token));
    expect(res.status).toBe(400);
  });

  it("yarış: aynı anda iki karar — yalnızca biri kazanır, tek audit kaydı (WHERE status='pending' guard)", async () => {
    const { post, link } = await seedPendingPost();
    const [res1, res2] = await Promise.all([
      POST(postRequest({ action: "approve" }, "1.1.1.1"), makeParams(link.token)),
      POST(postRequest({ action: "reject" }, "2.2.2.2"), makeParams(link.token)),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const audits = await db.approvalAudit.findMany({ where: { postId: post.id } });
    expect(audits).toHaveLength(1);
  });

  it("reddetme yayın tetiklemez, publishStatus 'idle' kalır", async () => {
    const agency = await createAgency();
    const client = await createInstagramClient(agency.id);
    const { post, link } = await createPendingPostWithLink(agency.id, client.id);

    const res = await POST(postRequest({ action: "reject" }), makeParams(link.token));
    expect(res.status).toBe(200);
    expect(mockPublish).not.toHaveBeenCalled();

    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.publishStatus).toBe("idle");
  });

  it(`rate limit: aynı IP'den ${RATE_LIMIT_MAX + 1}. istek 429 döner`, async () => {
    const { link } = await seedPendingPost();
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      const res = await GET(getRequest("7.7.7.7"), makeParams(link.token));
      expect(res.status).toBe(200);
    }
    const blocked = await POST(
      postRequest({ action: "approve" }, "7.7.7.7"),
      makeParams(link.token)
    );
    expect(blocked.status).toBe(429);
  });
});

describe("POST /api/approve/[token] — Instagram yayını", () => {
  async function seedWithInstagram(overrides: { imageUrls?: string[] } = {}) {
    const agency = await createAgency();
    const client = await createInstagramClient(agency.id);
    const seeded = await createPendingPostWithLink(agency.id, client.id, overrides);
    return { agency, client, ...seeded };
  }

  it("Instagram bağlı DEĞİLSE hiçbir şey yayınlanmaz, publishStatus 'skipped' olur", async () => {
    // Mevcut kullanıcıların davranışının bozulmadığını kanıtlayan test.
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { post, link } = await createPendingPostWithLink(agency.id, client.id);

    const res = await POST(postRequest({ action: "approve" }), makeParams(link.token));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("approved");
    expect(data.publishStatus).toBe("skipped");

    expect(mockPublish).not.toHaveBeenCalled();
    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.status).toBe("approved");
    expect(updated?.publishStatus).toBe("skipped");
    expect(updated?.igMediaId).toBeNull();
    expect(updated?.publishedAt).toBeNull();
  });

  it("başarılı yayında igMediaId, igPermalink ve publishedAt dolar", async () => {
    const { post, link, client } = await seedWithInstagram({
      imageUrls: [
        "https://raw.githubusercontent.com/a/1.jpg",
        "https://raw.githubusercontent.com/a/2.jpg",
      ],
    });
    mockPublish.mockResolvedValue({
      mediaId: "media-77",
      permalink: "https://www.instagram.com/p/ABC/",
    });

    const res = await POST(postRequest({ action: "approve" }), makeParams(link.token));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      status: "approved",
      publishStatus: "published",
      igPermalink: "https://www.instagram.com/p/ABC/",
    });

    // Yayın çekirdeğine müşterinin kimlik bilgileri ve sıralı görseller gider
    expect(mockPublish).toHaveBeenCalledOnce();
    expect(mockPublish.mock.calls[0][0]).toMatchObject({
      igUserId: client.instagramUserId,
      accessToken: client.instagramAccessToken,
      imageUrls: [
        "https://raw.githubusercontent.com/a/1.jpg",
        "https://raw.githubusercontent.com/a/2.jpg",
      ],
      caption: "Test caption",
    });

    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.publishStatus).toBe("published");
    expect(updated?.igMediaId).toBe("media-77");
    expect(updated?.igPermalink).toBe("https://www.instagram.com/p/ABC/");
    expect(updated?.publishedAt).not.toBeNull();
    expect(updated?.publishError).toBeNull();
  });

  it("Instagram hatası ONAYI BOZMAZ — status approved kalır, publishStatus 'failed'", async () => {
    const { post, link } = await seedWithInstagram();
    mockPublish.mockRejectedValue(
      new IGError("Invalid OAuth access token", {
        error: { code: 190, fbtrace_id: "trace-1" },
      })
    );

    const res = await POST(postRequest({ action: "approve" }), makeParams(link.token));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("approved");
    expect(data.publishStatus).toBe("failed");
    // Public sayfaya Meta'nın ham hatası sızmaz
    expect(data.publishError).not.toContain("fbtrace_id");

    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.status).toBe("approved"); // onay yerinde
    expect(updated?.publishStatus).toBe("failed");
    expect(updated?.publishError).toContain("Invalid OAuth access token");
    expect(updated?.publishError).toContain("code=190"); // ajans için teşhis
    expect(updated?.igMediaId).toBeNull();

    // Onay audit kaydı yine yazılmış olmalı
    const audits = await db.approvalAudit.findMany({ where: { postId: post.id } });
    expect(audits).toHaveLength(1);
  });

  it("süresi dolmuş token'da API'ye gidilmez, publishStatus 'failed'", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id, {
      instagramUserId: "1784100",
      instagramAccessToken: "IGAA-eski",
      instagramTokenExpiry: new Date(Date.now() - 60_000),
    });
    const { post, link } = await createPendingPostWithLink(agency.id, client.id);

    const res = await POST(postRequest({ action: "approve" }), makeParams(link.token));
    expect(res.status).toBe(200);
    expect(mockPublish).not.toHaveBeenCalled();

    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.status).toBe("approved");
    expect(updated?.publishStatus).toBe("failed");
    expect(updated?.publishError).toContain("süresi dolmuş");
  });

  it("YARIŞ: aynı anda iki onay isteğinde Instagram'a TEK yayın gider", async () => {
    const { post, link } = await seedWithInstagram();

    // Yayın yavaş olsun ki iki istek gerçekten üst üste binsin
    let calls = 0;
    mockPublish.mockImplementation(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { mediaId: `media-${calls}`, permalink: "https://instagram.com/p/A/" };
    });

    const [res1, res2] = await Promise.all([
      POST(postRequest({ action: "approve" }, "1.1.1.1"), makeParams(link.token)),
      POST(postRequest({ action: "approve" }, "2.2.2.2"), makeParams(link.token)),
    ]);

    expect([res1.status, res2.status].sort()).toEqual([200, 409]);
    expect(mockPublish).toHaveBeenCalledOnce();

    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.publishStatus).toBe("published");
    expect(updated?.igMediaId).toBe("media-1");

    const audits = await db.approvalAudit.findMany({ where: { postId: post.id } });
    expect(audits).toHaveLength(1);
  });

  it("YARIŞ: aynı anda iki 'tekrar dene' isteğinde de TEK yayın gider (publishStatus kilidi)", async () => {
    const { post, link } = await seedWithInstagram();
    // Önce onaylanmış ama yayını başarısız olmuş bir posta getir
    await db.post.update({
      where: { id: post.id },
      data: { status: "approved", publishStatus: "failed", publishError: "önceki hata" },
    });

    let calls = 0;
    mockPublish.mockImplementation(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { mediaId: `media-${calls}`, permalink: "https://instagram.com/p/B/" };
    });

    const [res1, res2] = await Promise.all([
      POST(postRequest({ action: "approve" }, "1.1.1.1"), makeParams(link.token)),
      POST(postRequest({ action: "approve" }, "2.2.2.2"), makeParams(link.token)),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(mockPublish).toHaveBeenCalledOnce();

    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.publishStatus).toBe("published");
    expect(updated?.igMediaId).toBe("media-1");

    // Karar yeniden verilmediği için yeni audit kaydı da oluşmaz
    const audits = await db.approvalAudit.findMany({ where: { postId: post.id } });
    expect(audits).toHaveLength(0);
  });

  it("başarısız yayın tekrar denenebilir ve başarılı olur", async () => {
    const { post, link } = await seedWithInstagram();
    mockPublish.mockRejectedValueOnce(new IGError("geçici hata"));

    const first = await POST(postRequest({ action: "approve" }), makeParams(link.token));
    expect((await first.json()).publishStatus).toBe("failed");

    mockPublish.mockResolvedValueOnce({
      mediaId: "media-2",
      permalink: "https://instagram.com/p/C/",
    });
    const retry = await POST(postRequest({ action: "approve" }), makeParams(link.token));
    expect(retry.status).toBe(200);
    expect((await retry.json()).publishStatus).toBe("published");

    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.publishStatus).toBe("published");
    expect(updated?.publishError).toBeNull();
  });

  it("zaten yayınlanmış post 409 döner, ikinci kez yayınlanmaz", async () => {
    const { post, link } = await seedWithInstagram();
    await db.post.update({
      where: { id: post.id },
      data: { status: "approved", publishStatus: "published", igMediaId: "media-1" },
    });

    const res = await POST(postRequest({ action: "approve" }), makeParams(link.token));
    expect(res.status).toBe(409);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("GET yanıtı publishStatus ve bağlantı durumunu bildirir", async () => {
    const { link } = await seedWithInstagram();
    const res = await GET(getRequest(), makeParams(link.token));
    const data = await res.json();
    expect(data.post.publishStatus).toBe("idle");
    expect(data.post.instagramConnected).toBe(true);
  });
});
