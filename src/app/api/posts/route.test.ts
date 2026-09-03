import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/blob")>();
  return { ...actual, uploadPostImage: vi.fn() };
});

vi.mock("@/lib/email", () => ({
  sendApprovalRequestEmail: vi.fn(),
  sendAgencyNoticeEmail: vi.fn(),
}));

vi.mock("@/lib/tokens", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tokens")>();
  return { ...actual, generateApprovalToken: vi.fn(actual.generateApprovalToken) };
});

import { GET, POST } from "./route";
import { auth } from "@/lib/auth";
import { uploadPostImage } from "@/lib/blob";
import { sendAgencyNoticeEmail, sendApprovalRequestEmail } from "@/lib/email";
import { generateApprovalToken } from "@/lib/tokens";
import { db } from "@/lib/db";
import {
  createAgency,
  createClient,
  createInstagramClient,
  createMember,
  resetDb,
} from "@tests/helpers/db";

const mockAuth = vi.mocked(auth);
const mockUpload = vi.mocked(uploadPostImage);
const mockSendEmail = vi.mocked(sendApprovalRequestEmail);
const mockAgencyNotice = vi.mocked(sendAgencyNoticeEmail);
const mockGenerateToken = vi.mocked(generateApprovalToken);

function makeImage() {
  return new File([new Uint8Array([137, 80, 78, 71])], "test.png", {
    type: "image/png",
  });
}

function postRequest(fields: {
  caption?: string;
  clientId?: string;
  image?: File | File[];
}) {
  const formData = new FormData();
  if (fields.caption !== undefined) formData.set("caption", fields.caption);
  if (fields.clientId !== undefined) formData.set("clientId", fields.clientId);
  if (fields.image !== undefined) {
    for (const file of Array.isArray(fields.image) ? fields.image : [fields.image]) {
      formData.append("image", file);
    }
  }
  return new Request("http://localhost/api/posts", {
    method: "POST",
    body: formData,
  });
}

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  mockUpload.mockResolvedValue("/uploads/test.png");
  mockSendEmail.mockResolvedValue({ sent: true });
  mockAgencyNotice.mockResolvedValue({ sent: true });
  const { generateApprovalToken: realGenerate } =
    await vi.importActual<typeof import("@/lib/tokens")>("@/lib/tokens");
  mockGenerateToken.mockImplementation(realGenerate);
});

describe("POST /api/posts", () => {
  it("happy path: Post + ApprovalLink oluşturur, e-posta gönderir, 201 döner", async () => {
    const agency = await createAgency({ name: "Parlak Ajans" });
    const client = await createClient(agency.id, { email: "musteri@ornek.com" });
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await POST(
      postRequest({ caption: "Yeni post", clientId: client.id, image: makeImage() })
    );
    expect(res.status).toBe(201);
    const data = await res.json();

    const post = await db.post.findUnique({
      where: { id: data.post.id },
      include: { approvalLink: true, images: true },
    });
    expect(post?.status).toBe("pending");
    expect(post?.approvalLink).not.toBeNull();
    expect(post?.images).toHaveLength(1);
    expect(data.approvalUrl).toContain(post!.approvalLink!.token);

    // ApprovalLink 7 gün geçerli
    const ttl = post!.approvalLink!.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);

    expect(mockSendEmail).toHaveBeenCalledOnce();
    const emailArg = mockSendEmail.mock.calls[0][0];
    expect(emailArg.to).toBe("musteri@ornek.com");
    expect(emailArg.agencyName).toBe("Parlak Ajans");
    expect(data.emailSent).toBe(true);
    expect(data.emailError).toBeUndefined();
  });

  // Post oluşuyor ama müşteriye haber gitmiyorsa bunu çağıran bilmeli. Yanıt
  // 201 olduğu için otomasyon "haber gitti" varsayıyordu; 17.08'de iki gün
  // boyunca onay maili gitmedi ve hiçbir yerde iz kalmadı.
  it("e-posta gitmediğinde 201 döner ama emailSent:false + sebep bildirir", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);
    mockSendEmail.mockResolvedValue({ sent: false, reason: "validation_error: geçersiz adres" });

    const res = await POST(
      postRequest({ caption: "Yeni post", clientId: client.id, image: makeImage() })
    );
    expect(res.status).toBe(201);
    const data = await res.json();

    expect(data.post).toBeDefined();
    expect(data.approvalUrl).toContain("/approve/");
    expect(data.emailSent).toBe(false);
    expect(data.emailError).toBe("validation_error: geçersiz adres");
  });

  it("iş sahibine 'onay bekliyor' bildirimi gider", async () => {
    const agency = await createAgency({ name: "Parlak Ajans" });
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    await POST(
      postRequest({ caption: "Yeni post", clientId: client.id, image: makeImage() })
    );

    expect(mockAgencyNotice).toHaveBeenCalledOnce();
    const arg = mockAgencyNotice.mock.calls[0][0];
    expect(arg.to).toEqual([agency.email]);
    expect(arg.event).toBe("request_sent");
    expect(arg.clientName).toBe(client.name);
    expect(arg.clientEmailSent).toBe(true);
  });

  // Ekip özelliği (F6) geldiğinden beri "iş sahibi" tek kişi değil: davetle
  // katılan üye de postun onaya gittiğini bilmek zorunda.
  it("bildirim ekipteki HERKESE gider, yalnızca ajansı kurana değil", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const uye = await createMember(agency.id, { email: "davetli@ornek.com" });
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    await POST(
      postRequest({ caption: "Yeni post", clientId: client.id, image: makeImage() })
    );

    expect(mockAgencyNotice.mock.calls[0][0].to).toEqual([agency.email, uye.email]);
  });

  // İş sahibinin en çok bilmesi gereken durum: post sıraya girdi ama müşteriye
  // haber gitmedi. Bunu bilmezse yayının neden durduğunu anlayamaz.
  it("müşteriye mail gitmediyse iş sahibinin bildirimi bunu söyler", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);
    mockSendEmail.mockResolvedValue({ sent: false, reason: "validation_error: geçersiz adres" });

    await POST(
      postRequest({ caption: "Yeni post", clientId: client.id, image: makeImage() })
    );

    expect(mockAgencyNotice.mock.calls[0][0].clientEmailSent).toBe(false);
  });

  it("ajans bildirimi patlarsa post oluşturma BOZULMAZ — 201 döner", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);
    mockAgencyNotice.mockRejectedValue(new Error("Resend down"));

    const res = await POST(
      postRequest({ caption: "Yeni post", clientId: client.id, image: makeImage() })
    );
    expect(res.status).toBe(201);
  });

  it("çoklu görsel: 3 dosya sıralı PostImage kayıtlarına dönüşür (D3.3)", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);
    mockUpload
      .mockResolvedValueOnce("/uploads/1.png")
      .mockResolvedValueOnce("/uploads/2.png")
      .mockResolvedValueOnce("/uploads/3.png");

    const res = await POST(
      postRequest({
        caption: "Carousel",
        clientId: client.id,
        image: [makeImage(), makeImage(), makeImage()],
      })
    );
    expect(res.status).toBe(201);
    const data = await res.json();

    const images = await db.postImage.findMany({
      where: { postId: data.post.id },
      orderBy: { sortOrder: "asc" },
    });
    expect(images.map((i) => i.url)).toEqual([
      "/uploads/1.png",
      "/uploads/2.png",
      "/uploads/3.png",
    ]);
  });

  it("11 görsel 400 ile reddedilir", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await POST(
      postRequest({
        caption: "Fazla görsel",
        clientId: client.id,
        image: Array.from({ length: 11 }, makeImage),
      })
    );
    expect(res.status).toBe(400);
    expect(await db.post.count()).toBe(0);
  });

  it("cross-agency clientId 403 ile reddedilir, DB'ye yazılmaz (T1)", async () => {
    const agencyA = await createAgency();
    const agencyB = await createAgency();
    const clientB = await createClient(agencyB.id);
    mockAuth.mockResolvedValue({ agencyId: agencyA.id } as never);

    const res = await POST(
      postRequest({ caption: "Deneme", clientId: clientB.id, image: makeImage() })
    );
    expect(res.status).toBe(403);
    expect(await db.post.count()).toBe(0);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("ApprovalLink yazımı başarısız olursa Post da geri alınır — $transaction rollback (T2)", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    // İlk post token X ile oluşur; ikinci post için token üretimi aynı X'i
    // dönecek şekilde sabitlenir → ApprovalLink.token unique ihlali → rollback.
    mockGenerateToken.mockReturnValue("duplicate-token-1234567890abcdef");

    const first = await POST(
      postRequest({ caption: "İlk", clientId: client.id, image: makeImage() })
    );
    expect(first.status).toBe(201);

    const second = await POST(
      postRequest({ caption: "İkinci", clientId: client.id, image: makeImage() })
    );
    expect(second.status).toBe(500);

    // İkinci post tamamen geri alındı — yarım kalmış (linksiz) post yok
    expect(await db.post.count()).toBe(1);
    expect(await db.approvalLink.count()).toBe(1);
  });

  it("blob upload hatası 400 döner, DB'ye hiçbir şey yazılmaz", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);
    mockUpload.mockRejectedValue(new Error("blob down"));

    const res = await POST(
      postRequest({ caption: "Deneme", clientId: client.id, image: makeImage() })
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Görsel yüklenemedi, tekrar deneyin");
    expect(await db.post.count()).toBe(0);
  });

  it("e-posta hatası post oluşturmayı BOZMAZ — 201 döner", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);
    mockSendEmail.mockRejectedValue(new Error("Resend down"));

    const res = await POST(
      postRequest({ caption: "Deneme", clientId: client.id, image: makeImage() })
    );
    expect(res.status).toBe(201);
    expect(await db.post.count()).toBe(1);
  });

  it("boş caption 400 döner", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await POST(
      postRequest({ caption: "   ", clientId: client.id, image: makeImage() })
    );
    expect(res.status).toBe(400);
  });

  it("oturum yoksa 401 döner", async () => {
    mockAuth.mockResolvedValue(null as never);
    const res = await POST(postRequest({ caption: "x" }));
    expect(res.status).toBe(401);
  });
});

// F7 — ajans başına kaba post tavanı. Panel (oturum) yolu buradan test edilir;
// makine (API anahtarı) yolu aşağıdaki "JSON yolu" describe'ında.
describe("POST /api/posts — kota (F7)", () => {
  const ORIGINAL_ENV = process.env.QUOTA_MAX_POSTS;
  const ORIGINAL_DAILY_ENV = process.env.QUOTA_MAX_POSTS_PER_DAY;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.QUOTA_MAX_POSTS;
    else process.env.QUOTA_MAX_POSTS = ORIGINAL_ENV;
    if (ORIGINAL_DAILY_ENV === undefined) delete process.env.QUOTA_MAX_POSTS_PER_DAY;
    else process.env.QUOTA_MAX_POSTS_PER_DAY = ORIGINAL_DAILY_ENV;
  });

  it("tavanın altındayken oluşturmaya izin verir", async () => {
    process.env.QUOTA_MAX_POSTS = "2";
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await POST(
      postRequest({ caption: "İlk post", clientId: client.id, image: makeImage() })
    );
    expect(res.status).toBe(201);
  });

  it("tavana ulaşıldığında 403 döner (429 DEĞİL), Blob'a yazılmaz", async () => {
    process.env.QUOTA_MAX_POSTS = "1";
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    await POST(postRequest({ caption: "İlk post", clientId: client.id, image: makeImage() }));
    mockUpload.mockClear();

    const res = await POST(
      postRequest({ caption: "Fazla post", clientId: client.id, image: makeImage() })
    );
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain("tavan");
    expect(await db.post.count({ where: { agencyId: agency.id } })).toBe(1);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("günlük hız tavanına ulaşıldığında 403 döner ve Blob'a yazılmaz", async () => {
    // Ömür boyu tavanı yolun dışında tut — burada sınanan HIZ tavanı.
    process.env.QUOTA_MAX_POSTS = "1000";
    process.env.QUOTA_MAX_POSTS_PER_DAY = "1";
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    await POST(postRequest({ caption: "İlk post", clientId: client.id, image: makeImage() }));
    mockUpload.mockClear();

    const res = await POST(
      postRequest({ caption: "Aynı gün ikinci post", clientId: client.id, image: makeImage() })
    );
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain("Günlük");
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("pencere DIŞINDA kalan post günlük tavanı doldurmaz", async () => {
    process.env.QUOTA_MAX_POSTS = "1000";
    process.env.QUOTA_MAX_POSTS_PER_DAY = "1";
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    await POST(postRequest({ caption: "Eski post", clientId: client.id, image: makeImage() }));
    // 25 saat geriye it: kayan pencerenin dışına düşsün.
    await db.post.updateMany({
      where: { agencyId: agency.id },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });

    const res = await POST(
      postRequest({ caption: "Yeni post", clientId: client.id, image: makeImage() })
    );
    expect(res.status).toBe(201);
  });

  it("sayım ajans kapsamındadır — başka ajansın postları tavana dahil değildir", async () => {
    process.env.QUOTA_MAX_POSTS = "1";
    const agencyA = await createAgency();
    const agencyB = await createAgency();
    const clientA = await createClient(agencyA.id);
    const clientB = await createClient(agencyB.id);
    mockAuth.mockResolvedValue({ agencyId: agencyB.id } as never);
    await POST(postRequest({ caption: "B'nin postu", clientId: clientB.id, image: makeImage() }));

    mockAuth.mockResolvedValue({ agencyId: agencyA.id } as never);
    const res = await POST(
      postRequest({ caption: "A'nın postu", clientId: clientA.id, image: makeImage() })
    );
    expect(res.status).toBe(201);
  });
});

describe("POST /api/posts — JSON yolu (makine erişimi)", () => {
  const API_KEY = "f".repeat(48);

  function jsonRequest(body: unknown, key: string | null = API_KEY) {
    return new Request("http://localhost/api/posts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  function enableApiKey(agencyId: string) {
    process.env.FURI_API_KEY = API_KEY;
    process.env.FURI_API_AGENCY_ID = agencyId;
  }

  beforeEach(() => {
    mockAuth.mockResolvedValue(null as never);
  });

  afterEach(() => {
    delete process.env.FURI_API_KEY;
    delete process.env.FURI_API_AGENCY_ID;
  });

  it("API anahtarıyla URL'lerden post oluşturur — Blob'a yazılmaz", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    enableApiKey(agency.id);

    const res = await POST(
      jsonRequest({
        clientId: client.id,
        caption: "Furi postu",
        imageUrls: [
          "https://raw.githubusercontent.com/enesmemduhoglu/furi/main/dizi/a/1.jpg",
          "https://raw.githubusercontent.com/enesmemduhoglu/furi/main/dizi/a/2.jpg",
        ],
        altTexts: ["İlk slayt", "İkinci slayt"],
        externalRef: "dizi/long-story-short",
      })
    );
    expect(res.status).toBe(201);
    const data = await res.json();

    const post = await db.post.findUnique({
      where: { id: data.post.id },
      include: { images: { orderBy: { sortOrder: "asc" } } },
    });
    expect(post?.status).toBe("pending");
    expect(post?.publishStatus).toBe("idle");
    expect(post?.externalRef).toBe("dizi/long-story-short");
    expect(post?.images.map((i) => i.url)).toEqual([
      "https://raw.githubusercontent.com/enesmemduhoglu/furi/main/dizi/a/1.jpg",
      "https://raw.githubusercontent.com/enesmemduhoglu/furi/main/dizi/a/2.jpg",
    ]);
    expect(post?.images.map((i) => i.altText)).toEqual(["İlk slayt", "İkinci slayt"]);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockSendEmail).toHaveBeenCalledOnce();
  });

  it("anahtarsız istek 401 döner", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    enableApiKey(agency.id);

    const res = await POST(
      jsonRequest(
        { clientId: client.id, caption: "x", imageUrls: ["https://raw.githubusercontent.com/a/1.jpg"] },
        null
      )
    );
    expect(res.status).toBe(401);
    expect(await db.post.count()).toBe(0);
  });

  it("yanlış anahtar 401 döner", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    enableApiKey(agency.id);

    const res = await POST(
      jsonRequest(
        { clientId: client.id, caption: "x", imageUrls: ["https://raw.githubusercontent.com/a/1.jpg"] },
        "z".repeat(48)
      )
    );
    expect(res.status).toBe(401);
    expect(await db.post.count()).toBe(0);
  });

  it("API anahtarı BAŞKA ajansın müşterisine yazamaz — 403 (IDOR)", async () => {
    const agencyA = await createAgency();
    const agencyB = await createAgency();
    const clientB = await createClient(agencyB.id);
    enableApiKey(agencyA.id);

    const res = await POST(
      jsonRequest({
        clientId: clientB.id,
        caption: "Başkasının müşterisi",
        imageUrls: ["https://raw.githubusercontent.com/a/1.jpg"],
      })
    );
    expect(res.status).toBe(403);
    expect(await db.post.count()).toBe(0);
  });

  it("allowlist dışı host 400 ile reddedilir", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    enableApiKey(agency.id);

    const res = await POST(
      jsonRequest({
        clientId: client.id,
        caption: "Kötü host",
        imageUrls: ["https://evil.example.com/1.jpg"],
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("imageUrls");
    expect(await db.post.count()).toBe(0);
  });

  it("http (https olmayan) URL 400 ile reddedilir", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    enableApiKey(agency.id);

    const res = await POST(
      jsonRequest({
        clientId: client.id,
        caption: "Şifresiz",
        imageUrls: ["http://raw.githubusercontent.com/a/1.jpg"],
      })
    );
    expect(res.status).toBe(400);
    expect(await db.post.count()).toBe(0);
  });

  /* ─── Video (Reels) ──────────────────────────────────────────────────── */

  const VIDEO_URL = "https://abc123.public.blob.vercel-storage.com/videos/a.mp4";

  it("videoUrl ile post oluşturur — görsel satırı yaratılmaz", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    enableApiKey(agency.id);

    const res = await POST(
      jsonRequest({
        clientId: client.id,
        caption: "Reel postu",
        videoUrl: VIDEO_URL,
        externalRef: "reels/ingilizce-3-ipucu",
      })
    );
    expect(res.status).toBe(201);

    const post = await db.post.findFirst({ include: { images: true } });
    expect(post?.videoUrl).toBe(VIDEO_URL);
    // Karusel tablosuna hiç satır düşmemeli: bir Reel tek medyadır.
    expect(post?.images).toHaveLength(0);
    expect(post?.externalRef).toBe("reels/ingilizce-3-ipucu");
  });

  it("ikisi birden gönderilirse 400 — hangisinin yayınlanacağı belirsiz kalmaz", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    enableApiKey(agency.id);

    const res = await POST(
      jsonRequest({
        clientId: client.id,
        caption: "İkisi birden",
        imageUrls: ["https://raw.githubusercontent.com/a/1.jpg"],
        videoUrl: VIDEO_URL,
      })
    );
    expect(res.status).toBe(400);
    expect(await db.post.count()).toBe(0);
  });

  it("ikisi de yoksa 400 — medyasız post oluşmaz", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    enableApiKey(agency.id);

    const res = await POST(jsonRequest({ clientId: client.id, caption: "Medyasız" }));
    expect(res.status).toBe(400);
    expect(await db.post.count()).toBe(0);
  });

  it("allowlist dışı video host'u 400 ile reddedilir", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    enableApiKey(agency.id);

    const res = await POST(
      jsonRequest({
        clientId: client.id,
        caption: "Kötü host",
        videoUrl: "https://evil.example.com/a.mp4",
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("videoUrl");
    expect(await db.post.count()).toBe(0);
  });

  it("11 URL 400 ile reddedilir", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    enableApiKey(agency.id);

    const res = await POST(
      jsonRequest({
        clientId: client.id,
        caption: "Fazla görsel",
        imageUrls: Array.from(
          { length: 11 },
          (_, i) => `https://raw.githubusercontent.com/a/${i}.jpg`
        ),
      })
    );
    expect(res.status).toBe(400);
    expect(await db.post.count()).toBe(0);
  });

  it("makine yolu da post tavanına tabidir — 403 döner (F7)", async () => {
    const ORIGINAL_ENV = process.env.QUOTA_MAX_POSTS;
    process.env.QUOTA_MAX_POSTS = "1";
    try {
      const agency = await createAgency();
      const client = await createClient(agency.id);
      enableApiKey(agency.id);

      await POST(
        jsonRequest({
          clientId: client.id,
          caption: "İlk",
          imageUrls: ["https://raw.githubusercontent.com/a/1.jpg"],
        })
      );

      const res = await POST(
        jsonRequest({
          clientId: client.id,
          caption: "Fazla",
          imageUrls: ["https://raw.githubusercontent.com/a/2.jpg"],
        })
      );
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toContain("tavan");
      expect(await db.post.count({ where: { agencyId: agency.id } })).toBe(1);
    } finally {
      if (ORIGINAL_ENV === undefined) delete process.env.QUOTA_MAX_POSTS;
      else process.env.QUOTA_MAX_POSTS = ORIGINAL_ENV;
    }
  });

  it("oturumlu kullanıcı da JSON gövde gönderebilir (anahtar gerekmez)", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await POST(
      jsonRequest(
        {
          clientId: client.id,
          caption: "Panelden URL",
          imageUrls: ["https://raw.githubusercontent.com/a/1.jpg"],
        },
        null
      )
    );
    expect(res.status).toBe(201);
  });
});

describe("GET /api/posts", () => {
  it("yalnızca kendi ajansının postlarını döner (agency-scoped)", async () => {
    const agencyA = await createAgency();
    const agencyB = await createAgency();
    const clientA = await createClient(agencyA.id);
    const clientB = await createClient(agencyB.id);
    await db.post.create({
      data: {
        agencyId: agencyA.id,
        clientId: clientA.id,
        caption: "A",
        status: "pending",
        images: { create: [{ url: "/a.png", sortOrder: 0 }] },
      },
    });
    await db.post.create({
      data: {
        agencyId: agencyB.id,
        clientId: clientB.id,
        caption: "B",
        status: "pending",
        images: { create: [{ url: "/b.png", sortOrder: 0 }] },
      },
    });

    mockAuth.mockResolvedValue({ agencyId: agencyA.id } as never);
    const res = await GET();
    const data = await res.json();
    expect(data.posts).toHaveLength(1);
    expect(data.posts[0].caption).toBe("A");
  });

  // `client` ilişkisi tam kayıt olarak eager-load edilirse token yanıta düşer.
  it("eager-load edilen müşteride Instagram token'ı dönmez", async () => {
    const agency = await createAgency();
    const client = await createInstagramClient(agency.id);
    await db.post.create({
      data: {
        agencyId: agency.id,
        clientId: client.id,
        caption: "A",
        status: "pending",
        images: { create: [{ url: "/a.png", sortOrder: 0 }] },
      },
    });

    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);
    const raw = await (await GET()).text();
    expect(raw).not.toContain("IGAA-test-token");
    expect(raw).not.toContain("instagramAccessToken");
    expect(JSON.parse(raw).posts[0].client.name).toBe(client.name);
  });
});
