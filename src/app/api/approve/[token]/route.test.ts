import { beforeEach, describe, expect, it, vi } from "vitest";

// Instagram'a gerçek istek atılmaz; yayın çekirdeği ayrıca instagram.test.ts'te
// test ediliyor. Burada onay akışıyla yayının BAĞLANTISI test edilir.
vi.mock("@/lib/instagram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/instagram")>();
  return { ...actual, publishToInstagram: vi.fn() };
});

vi.mock("@/lib/email", () => ({ sendAgencyNoticeEmail: vi.fn() }));

import { GET, POST } from "./route";
import { db } from "@/lib/db";
import { sendAgencyNoticeEmail } from "@/lib/email";
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
const mockAgencyNotice = vi.mocked(sendAgencyNoticeEmail);

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
  const seeded = await createPendingPostWithLink(agency.id, client.id, overrides);
  return { ...seeded, agency };
}

beforeEach(async () => {
  await resetDb();
  resetRateLimiter();
  vi.restoreAllMocks();
  mockPublish.mockReset();
  mockAgencyNotice.mockReset();
  mockAgencyNotice.mockResolvedValue({ sent: true });
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

  // İş sahibi (ajans) müşterinin ne yaptığını başka hiçbir yerden öğrenemiyordu:
  // onay maili müşteriye gidiyor, karar da onay sayfasında veriliyordu.
  it("onayda iş sahibine bildirim gider — yayın sonucuyla birlikte", async () => {
    const { link, agency } = await seedPendingPost();
    const res = await POST(postRequest({ action: "approve" }), makeParams(link.token));
    expect(res.status).toBe(200);

    expect(mockAgencyNotice).toHaveBeenCalledOnce();
    const arg = mockAgencyNotice.mock.calls[0][0];
    expect(arg.to).toBe(agency.email);
    expect(arg.event).toBe("approved");
    // Instagram bağlı olmayan müşteride yayın "skipped" olur; bildirim kararı
    // değil AKIBETİ taşımalı, yoksa "onaylandı" deyip yayının olmadığını gizler.
    expect(arg.publishStatus).toBe("skipped");
  });

  it("redde iş sahibine bildirim gider — gerekçesiyle", async () => {
    const { link, agency } = await seedPendingPost();
    await POST(
      postRequest({ action: "reject", rejectionReason: "Logo eski sürüm" }),
      makeParams(link.token)
    );

    expect(mockAgencyNotice).toHaveBeenCalledOnce();
    const arg = mockAgencyNotice.mock.calls[0][0];
    expect(arg.to).toBe(agency.email);
    expect(arg.event).toBe("rejected");
    expect(arg.rejectionReason).toBe("Logo eski sürüm");
  });

  it("bildirim patlarsa onay BOZULMAZ — karar yerinde kalır", async () => {
    const { post, link } = await seedPendingPost();
    mockAgencyNotice.mockRejectedValue(new Error("Resend down"));

    const res = await POST(postRequest({ action: "approve" }), makeParams(link.token));
    expect(res.status).toBe(200);
    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.status).toBe("approved");
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

  it("onaylanmış ama yayını hiç denenmemiş ('idle') post sonradan yayınlanabilir", async () => {
    // Toplu onaydan kalan eski postların kurtarma yolu — karar yeniden verilmez.
    const { post, link } = await seedWithInstagram();
    await db.post.update({ where: { id: post.id }, data: { status: "approved" } });
    mockPublish.mockResolvedValue({
      mediaId: "media-9",
      permalink: "https://instagram.com/p/D/",
    });

    const res = await POST(postRequest({ action: "approve" }), makeParams(link.token));
    expect(res.status).toBe(200);
    expect((await res.json()).publishStatus).toBe("published");

    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.publishStatus).toBe("published");
    expect(updated?.igMediaId).toBe("media-9");

    const audits = await db.approvalAudit.findMany({ where: { postId: post.id } });
    expect(audits).toHaveLength(0);
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

describe("POST /api/approve/[token] — F8 zamanlanmış yayın", () => {
  async function seedWithInstagram(publishAt: Date | null) {
    const agency = await createAgency();
    const client = await createInstagramClient(agency.id);
    const seeded = await createPendingPostWithLink(agency.id, client.id, { publishAt });
    return { agency, client, ...seeded };
  }

  it("publishAt GELECEKTEYSE onay ANINDA yayınlamaz — publishStatus 'scheduled' olur", async () => {
    const gelecek = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const { post, link } = await seedWithInstagram(gelecek);

    const res = await POST(postRequest({ action: "approve" }), makeParams(link.token));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("approved");
    expect(data.publishStatus).toBe("scheduled");

    // Yayın hiç tetiklenmedi — kilit "publishing"e hiç geçmedi.
    expect(mockPublish).not.toHaveBeenCalled();
    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.status).toBe("approved");
    expect(updated?.publishStatus).toBe("scheduled");
    expect(updated?.igMediaId).toBeNull();

    // Ajans "onaylandı ama şu saatte yayınlanacak" bilgisini alır — "yayınlandı" değil.
    expect(mockAgencyNotice).toHaveBeenCalledOnce();
    expect(mockAgencyNotice.mock.calls[0][0]).toMatchObject({ publishStatus: "scheduled" });
  });

  it("publishAt GEÇMİŞTEYSE mevcut davranış aynen korunur — hemen yayınlanır", async () => {
    const gecmis = new Date(Date.now() - 60_000);
    const { post, link } = await seedWithInstagram(gecmis);
    mockPublish.mockResolvedValue({
      mediaId: "media-gecmis",
      permalink: "https://instagram.com/p/GECMIS/",
    });

    const res = await POST(postRequest({ action: "approve" }), makeParams(link.token));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.publishStatus).toBe("published");

    expect(mockPublish).toHaveBeenCalledOnce();
    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.publishStatus).toBe("published");
  });

  it("publishAt BOŞSA mevcut davranış aynen korunur — hemen yayınlanır", async () => {
    const { post, link } = await seedWithInstagram(null);
    mockPublish.mockResolvedValue({
      mediaId: "media-bos",
      permalink: "https://instagram.com/p/BOS/",
    });

    const res = await POST(postRequest({ action: "approve" }), makeParams(link.token));
    expect((await res.json()).publishStatus).toBe("published");

    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.publishStatus).toBe("published");
  });
});

// ------------------------------------------------- revizyon turu (F10)

describe("POST /api/approve/[token] · revizyon talebi", () => {
  it("pending postu revision_requested yapar, turu artırır, zincire yazar", async () => {
    const { post, link } = await seedPendingPost();

    const res = await POST(
      postRequest({
        action: "request_revision",
        revisionMessage: "  İkinci cümleyi yumuşat  ",
      }),
      makeParams(link.token)
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "revision_requested",
      revisionRound: 1,
    });

    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.status).toBe("revision_requested");
    expect(updated?.revisionRound).toBe(1);
    // Red DEĞİL: `rejectionReason` alanına dokunulmamalı, yoksa panel bunu
    // reddedilmiş post gibi gösterirdi.
    expect(updated?.rejectionReason).toBeNull();

    const revisions = await db.postRevision.findMany({ where: { postId: post.id } });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      round: 1,
      actor: "client",
      event: "revision_requested",
      message: "İkinci cümleyi yumuşat",
      // O anki metin donduruluyor — ajans düzeltince neye itiraz edildiği kaybolmasın.
      caption: "Test caption",
      ip: "1.2.3.4",
    });
  });

  it("karar defterine de yazılır (anlaşmazlıkta bakılacak yer orası)", async () => {
    const { post, link } = await seedPendingPost();
    await POST(postRequest({ action: "request_revision" }), makeParams(link.token));

    const audits = await db.approvalAudit.findMany({ where: { postId: post.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("revision_requested");
    expect(audits[0].ip).toBe("1.2.3.4");
  });

  it("mesaj boş bırakılabilir — müşteri duvara çarpmaz", async () => {
    const { post, link } = await seedPendingPost();
    const res = await POST(
      postRequest({ action: "request_revision", revisionMessage: "   " }),
      makeParams(link.token)
    );
    expect(res.status).toBe(200);
    const revisions = await db.postRevision.findMany({ where: { postId: post.id } });
    expect(revisions[0].message).toBeNull();
  });

  it("ajansa bildirim gider ve `gonder()` yolundan geçer", async () => {
    const { link } = await seedPendingPost();
    await POST(
      postRequest({ action: "request_revision", revisionMessage: "Logo büyüsün" }),
      makeParams(link.token)
    );
    expect(mockAgencyNotice).toHaveBeenCalledTimes(1);
    expect(mockAgencyNotice.mock.calls[0][0]).toMatchObject({
      event: "revision_requested",
      revisionRequest: "Logo büyüsün",
      revisionRound: 1,
    });
  });

  it("bildirim patlasa da revizyon talebi kaydı yerinde kalır", async () => {
    const { post, link } = await seedPendingPost();
    mockAgencyNotice.mockRejectedValue(new Error("resend down"));

    const res = await POST(
      postRequest({ action: "request_revision" }),
      makeParams(link.token)
    );
    expect(res.status).toBe(200);
    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.status).toBe("revision_requested");
  });

  it("YARIŞ: onay ile revizyon aynı anda gelirse yalnızca biri kazanır", async () => {
    const { post, link } = await seedPendingPost();

    const [approveRes, revisionRes] = await Promise.all([
      POST(postRequest({ action: "approve" }), makeParams(link.token)),
      POST(
        postRequest({ action: "request_revision", revisionMessage: "dur" }),
        makeParams(link.token)
      ),
    ]);

    expect([approveRes.status, revisionRes.status].sort()).toEqual([200, 409]);

    const updated = await db.post.findUnique({ where: { id: post.id } });
    // Kazanan hangisiyse durum ODUR; iki karar üst üste yazılmaz.
    expect(["approved", "revision_requested"]).toContain(updated?.status);
    const revisionCount = await db.postRevision.count({ where: { postId: post.id } });
    expect(revisionCount).toBe(updated?.status === "revision_requested" ? 1 : 0);
    expect(updated?.revisionRound).toBe(
      updated?.status === "revision_requested" ? 1 : 0
    );
  });

  it("YARIŞ: iki revizyon talebi aynı anda gelirse tur bir kez artar", async () => {
    const { post, link } = await seedPendingPost();

    const results = await Promise.all([
      POST(
        postRequest({ action: "request_revision", revisionMessage: "a" }),
        makeParams(link.token)
      ),
      POST(
        postRequest({ action: "request_revision", revisionMessage: "b" }),
        makeParams(link.token)
      ),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);

    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.revisionRound).toBe(1);
    expect(await db.postRevision.count({ where: { postId: post.id } })).toBe(1);
  });

  it("revizyon beklerken gelen karar 409 alır, mesaj 'zaten karar verildi' DEMEZ", async () => {
    const { link } = await seedPendingPost();
    await POST(postRequest({ action: "request_revision" }), makeParams(link.token));

    const res = await POST(postRequest({ action: "approve" }), makeParams(link.token));
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.status).toBe("revision_requested");
    expect(data.error).toContain("düzeltme istedin");
  });

  it("geçersiz token 404, süresi dolmuş token 410 — onay yolundaki koruma aynen", async () => {
    const yok = await POST(
      postRequest({ action: "request_revision" }),
      makeParams("boyle-bir-token-yok")
    );
    expect(yok.status).toBe(404);

    const { link } = await seedPendingPost({ expiresAt: new Date(Date.now() - 1000) });
    const olmus = await POST(
      postRequest({ action: "request_revision" }),
      makeParams(link.token)
    );
    expect(olmus.status).toBe(410);
  });

  it("rate limit revizyon yolunda da geçerli", async () => {
    const { link } = await seedPendingPost();
    for (let i = 0; i < RATE_LIMIT_MAX; i += 1) {
      await GET(getRequest("5.5.5.5"), makeParams(link.token));
    }
    const res = await POST(
      postRequest({ action: "request_revision" }, "5.5.5.5"),
      makeParams(link.token)
    );
    expect(res.status).toBe(429);
  });

  it("bilinmeyen action 400 alır — yeni değer eskileri gevşetmedi", async () => {
    const { link } = await seedPendingPost();
    const res = await POST(postRequest({ action: "revise" }), makeParams(link.token));
    expect(res.status).toBe(400);
  });

  it("GET yanıtı revizyon turunu bildirir", async () => {
    const { link } = await seedPendingPost();
    await POST(postRequest({ action: "request_revision" }), makeParams(link.token));
    const res = await GET(getRequest(), makeParams(link.token));
    const data = await res.json();
    expect(data.post.status).toBe("revision_requested");
    expect(data.post.revisionRound).toBe(1);
  });

  it("yayınlanmış posta revizyon istenemez", async () => {
    const { post, link } = await seedPendingPost();
    await db.post.update({
      where: { id: post.id },
      data: { status: "approved", publishStatus: "published", igMediaId: "media-1" },
    });

    const res = await POST(
      postRequest({ action: "request_revision" }),
      makeParams(link.token)
    );
    expect(res.status).toBe(409);
    expect(await db.postRevision.count({ where: { postId: post.id } })).toBe(0);
  });
});
