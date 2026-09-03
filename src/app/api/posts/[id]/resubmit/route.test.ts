import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

// Mail yolu mock'lanıyor ama `sendRevisedPostEmail` ADI üzerinden: route'un
// `resend.emails.send`'i doğrudan çağırmadığını (yani `gonder()` yolundan
// geçtiğini) bu mock'un çağrılmış olması kanıtlıyor.
vi.mock("@/lib/email", () => ({ sendRevisedPostEmail: vi.fn() }));

// Blob ağ istemesin; hem temizliğin hem yüklemenin çağrıldığı ayrıca denetlenir.
// `InvalidImageError` gerçek bir sınıf olmalı — route `instanceof` ile bakıyor.
vi.mock("@/lib/blob", () => ({
  deletePostImages: vi.fn(),
  uploadPostImage: vi.fn(),
  InvalidImageError: class InvalidImageError extends Error {},
}));

import { POST } from "./route";
import { auth } from "@/lib/auth";
import { deletePostImages, InvalidImageError, uploadPostImage } from "@/lib/blob";
import { db } from "@/lib/db";
import { sendRevisedPostEmail } from "@/lib/email";
import {
  createAgency,
  createClient,
  createPendingPostWithLink,
  createRevisionRequestedPost,
  resetDb,
} from "@tests/helpers/db";

const mockAuth = vi.mocked(auth);
const mockEmail = vi.mocked(sendRevisedPostEmail);
const mockDeleteImages = vi.mocked(deletePostImages);
const mockUpload = vi.mocked(uploadPostImage);

/** Panel yolu: `multipart/form-data`. Dosya boyu 0'dan büyük olmalı — sıfır
 *  baytlık File "alan boş gönderildi" demek ve sunucu onu görmezden gelir. */
function formRequest(fields: {
  caption?: string;
  message?: string;
  files?: { name: string; bytes?: string }[];
  origin?: string;
}) {
  const body = new FormData();
  if (fields.caption !== undefined) body.set("caption", fields.caption);
  if (fields.message !== undefined) body.set("message", fields.message);
  for (const file of fields.files ?? []) {
    body.append("image", new File([file.bytes ?? "jpegbytes"], file.name, { type: "image/jpeg" }));
  }
  return new Request("http://localhost/api/posts/x/resubmit", {
    method: "POST",
    headers: fields.origin ? { origin: fields.origin } : undefined,
    body,
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function request(body?: unknown) {
  return new Request("http://localhost/api/posts/x/resubmit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function seed(
  overrides: Parameters<typeof createRevisionRequestedPost>[2] = {}
) {
  const agency = await createAgency({ name: "Parlak Ajans" });
  const client = await createClient(agency.id);
  const seeded = await createRevisionRequestedPost(agency.id, client.id, overrides);
  mockAuth.mockResolvedValue({ agencyId: agency.id } as never);
  return { agency, client, ...seeded };
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  mockEmail.mockReset();
  mockEmail.mockResolvedValue({ sent: true });
  mockDeleteImages.mockReset();
  mockDeleteImages.mockResolvedValue(undefined);
  mockUpload.mockReset();
  mockUpload.mockImplementation(async (file: File) => `https://blob.test/${file.name}`);
});

describe("POST /api/posts/[id]/resubmit", () => {
  it("oturum yoksa 401 döner", async () => {
    mockAuth.mockResolvedValue(null as never);
    const res = await POST(request({ caption: "yeni" }), params("herhangi"));
    expect(res.status).toBe(401);
  });

  it("revizyon bekleyen postu düzeltip pending'e döndürür ve zincire yazar", async () => {
    const { post } = await seed();

    const res = await POST(
      request({ caption: "  düzeltilmiş metin  ", message: "İkinci cümleyi yumuşattım" }),
      params(post.id)
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "pending", round: 1 });

    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.status).toBe("pending");
    expect(updated?.caption).toBe("düzeltilmiş metin");
    // Tur numarası ARTMAZ: turu müşteri açar, ajans aynı turu kapatır.
    expect(updated?.revisionRound).toBe(1);

    const revisions = await db.postRevision.findMany({
      where: { postId: post.id },
      orderBy: { createdAt: "asc" },
    });
    expect(revisions).toHaveLength(2);
    expect(revisions[1]).toMatchObject({
      round: 1,
      actor: "agency",
      event: "resubmitted",
      message: "İkinci cümleyi yumuşattım",
      caption: "düzeltilmiş metin",
      // Ajans oturumla yetkileniyor; IP kaydı müşteri satırlarına ait.
      ip: null,
    });
  });

  it("gövdesiz istek meşru: metin korunur, post yine onaya döner", async () => {
    const { post } = await seed();
    const res = await POST(request(), params(post.id));
    expect(res.status).toBe(200);
    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.status).toBe("pending");
    expect(updated?.caption).toBe("Test caption");
  });

  it("ONAY LİNKİ AYNI TOKEN'LA DEVAM EDER, yalnızca süresi tazelenir", async () => {
    // Müşterinin elindeki eski maildeki link ölmemeli — revizyon aynı işin devamı.
    const { post, link } = await seed({
      expiresAt: new Date(Date.now() + 60 * 1000),
    });

    const res = await POST(request({ caption: "yeni metin" }), params(post.id));
    const data = await res.json();

    const after = await db.approvalLink.findUnique({ where: { postId: post.id } });
    expect(after?.token).toBe(link.token);
    expect(data.approvalUrl).toContain(link.token);
    expect(after!.expiresAt.getTime()).toBeGreaterThan(link.expiresAt.getTime());
  });

  it("süresi dolmuş link de aynı token'la canlanır", async () => {
    const { post, link } = await seed({ expiresAt: new Date(Date.now() - 1000) });
    await POST(request(), params(post.id));

    const after = await db.approvalLink.findUnique({ where: { postId: post.id } });
    expect(after?.token).toBe(link.token);
    expect(after!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("hatırlatma sayaçları sıfırlanır — yeni tur yeni bir bekleyiştir", async () => {
    const { post } = await seed();
    await db.post.update({
      where: { id: post.id },
      data: { reminderSentAt: new Date(), expiryNoticeSentAt: new Date() },
    });

    await POST(request(), params(post.id));
    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.reminderSentAt).toBeNull();
    expect(updated?.expiryNoticeSentAt).toBeNull();
  });

  it("görseller değiştirilebilir; yerini kaybedenler blob'dan temizlenir", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { post } = await createRevisionRequestedPost(agency.id, client.id);
    await db.postImage.deleteMany({ where: { postId: post.id } });
    await db.postImage.create({
      data: { postId: post.id, url: "https://eski.example.com/a.jpg", sortOrder: 0 },
    });
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await POST(
      request({ imageUrls: ["https://raw.githubusercontent.com/a/yeni.jpg"] }),
      params(post.id)
    );
    expect(res.status).toBe(200);

    const images = await db.postImage.findMany({ where: { postId: post.id } });
    expect(images.map((image) => image.url)).toEqual([
      "https://raw.githubusercontent.com/a/yeni.jpg",
    ]);
    expect(mockDeleteImages).toHaveBeenCalledWith(["https://eski.example.com/a.jpg"]);
  });

  it("görsel verilmediğinde mevcut görsellere DOKUNULMAZ", async () => {
    const { post } = await seed();
    await POST(request({ caption: "sadece metin" }), params(post.id));

    const images = await db.postImage.findMany({ where: { postId: post.id } });
    expect(images).toHaveLength(1);
    // Silinen bir şey yok; boş listeyle çağrılması zararsız ama URL geçmemeli.
    expect(mockDeleteImages).toHaveBeenCalledWith([]);
  });

  it("allowlist dışı görsel host'u 400 alır — revizyon yolu yeni kapı açmaz", async () => {
    const { post } = await seed();
    const res = await POST(
      request({ imageUrls: ["https://kotu.example.com/a.jpg"] }),
      params(post.id)
    );
    expect(res.status).toBe(400);
    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.status).toBe("revision_requested");
  });

  it("boş caption 400 alır", async () => {
    const { post } = await seed();
    const res = await POST(request({ caption: "   " }), params(post.id));
    expect(res.status).toBe(400);
  });

  // ------------------------------------------------------------- korumalar

  it("YAYINLANMIŞ POST REVİZE EDİLEMEZ (409) ve metni değişmez", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { post } = await createRevisionRequestedPost(agency.id, client.id, {
      publishStatus: "published",
    });
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await POST(request({ caption: "gizli düzeltme" }), params(post.id));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("yayınlanmış");

    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.caption).toBe("Test caption");
    expect(updated?.status).toBe("revision_requested");
    expect(mockEmail).not.toHaveBeenCalled();
  });

  it("pending post tekrar gönderilemez (409) — mevcut onay isteği ikiye bölünmez", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { post } = await createPendingPostWithLink(agency.id, client.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await POST(request({ caption: "yeni" }), params(post.id));
    expect(res.status).toBe(409);
    expect((await res.json()).status).toBe("pending");
  });

  it("onaylanmış postun metni bu yoldan değiştirilemez", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { post } = await createPendingPostWithLink(agency.id, client.id, {
      status: "approved",
    });
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await POST(request({ caption: "sonradan" }), params(post.id));
    expect(res.status).toBe(409);
    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.caption).toBe("Test caption");
  });

  it("IDOR: başka ajansın postu 404 alır ve dokunulmaz", async () => {
    const sahip = await createAgency();
    const sahipClient = await createClient(sahip.id);
    const { post } = await createRevisionRequestedPost(sahip.id, sahipClient.id);

    const yabanci = await createAgency();
    mockAuth.mockResolvedValue({ agencyId: yabanci.id } as never);

    const res = await POST(request({ caption: "ele geçirildi" }), params(post.id));
    expect(res.status).toBe(404);

    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.caption).toBe("Test caption");
    expect(updated?.status).toBe("revision_requested");
    expect(await db.postRevision.count({ where: { postId: post.id } })).toBe(1);
  });

  it("YARIŞ: iki 'tekrar gönder' aynı anda gelirse tek zincir satırı yazılır", async () => {
    const { post } = await seed();

    const results = await Promise.all([
      POST(request({ caption: "a" }), params(post.id)),
      POST(request({ caption: "b" }), params(post.id)),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);

    const resubmits = await db.postRevision.count({
      where: { postId: post.id, event: "resubmitted" },
    });
    expect(resubmits).toBe(1);
  });

  // ------------------------------------------------------------ bildirimler

  it("müşteriye bildirim gider; müşterinin kendi isteği geri okunur", async () => {
    const { post, client } = await seed({ message: "Logo büyüsün" });

    await POST(request({ caption: "yeni", message: "Logoyu büyüttüm" }), params(post.id));

    expect(mockEmail).toHaveBeenCalledTimes(1);
    expect(mockEmail.mock.calls[0][0]).toMatchObject({
      to: client.email,
      agencyName: "Parlak Ajans",
      revisionRequest: "Logo büyüsün",
      agencyNote: "Logoyu büyüttüm",
      round: 1,
    });
  });

  it("mail gitmezse yanıt bunu SÖYLER ve posta yazılır (sessiz yutma yok)", async () => {
    const { post } = await seed();
    mockEmail.mockResolvedValue({ sent: false, reason: "domain doğrulanmadı" });

    const res = await POST(request({ caption: "yeni" }), params(post.id));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.emailSent).toBe(false);
    expect(data.emailError).toBe("domain doğrulanmadı");

    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.approvalEmailSent).toBe(false);
    expect(updated?.approvalEmailError).toBe("domain doğrulanmadı");
    // Mail gitmese bile revizyon gerçekten gitti — durum geri alınmaz.
    expect(updated?.status).toBe("pending");
  });

  it("panel formu dosya yükleyerek görselleri değiştirir", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { post } = await createRevisionRequestedPost(agency.id, client.id);
    await db.postImage.deleteMany({ where: { postId: post.id } });
    await db.postImage.create({
      data: { postId: post.id, url: "https://eski.example.com/a.jpg", sortOrder: 0 },
    });
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await POST(
      formRequest({
        caption: "yeni metin",
        message: "Görseli değiştirdim",
        files: [{ name: "1.jpg" }, { name: "2.jpg" }],
      }),
      params(post.id)
    );
    expect(res.status).toBe(200);

    const images = await db.postImage.findMany({
      where: { postId: post.id },
      orderBy: { sortOrder: "asc" },
    });
    expect(images.map((image) => image.url)).toEqual([
      "https://blob.test/1.jpg",
      "https://blob.test/2.jpg",
    ]);
    expect(mockDeleteImages).toHaveBeenCalledWith(["https://eski.example.com/a.jpg"]);
    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.caption).toBe("yeni metin");
    expect(updated?.status).toBe("pending");
  });

  it("form dosyasız gelirse görseller korunur — 'sadece metni düzelttim' hâli", async () => {
    const { post } = await seed();
    const res = await POST(formRequest({ caption: "sadece metin" }), params(post.id));
    expect(res.status).toBe(200);
    expect(mockUpload).not.toHaveBeenCalled();

    const images = await db.postImage.findMany({ where: { postId: post.id } });
    expect(images).toHaveLength(1);
    expect(mockDeleteImages).toHaveBeenCalledWith([]);
  });

  it("revizyon beklemeyen posta dosya yüklenmez — 409 Blob'a yazmadan döner", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { post } = await createPendingPostWithLink(agency.id, client.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await POST(
      formRequest({ caption: "yeni", files: [{ name: "1.jpg" }] }),
      params(post.id)
    );
    expect(res.status).toBe(409);
    // Asıl mesele: sahipsiz dosya kalmasın.
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("yabancı Origin 403 alır — panel yolu CSRF'e açık bırakılmaz", async () => {
    const { post } = await seed();
    const res = await POST(
      formRequest({ caption: "yeni", origin: "https://kotu.example.com" }),
      params(post.id)
    );
    expect(res.status).toBe(403);
    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.status).toBe("revision_requested");
  });

  it("bozuk görsel 400 alır ve post revizyonda kalır", async () => {
    const { post } = await seed();
    mockUpload.mockRejectedValue(new InvalidImageError("Görsel JPEG/PNG/WebP olmalı"));

    const res = await POST(
      formRequest({ caption: "yeni", files: [{ name: "kotu.txt" }] }),
      params(post.id)
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: "image" });
    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.status).toBe("revision_requested");
  });

  it("Reel'e görsel yüklenemez — 409, Blob'a yazılmadan", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { post } = await createRevisionRequestedPost(agency.id, client.id, {
      videoUrl: "https://blob.test/reel.mp4",
    });
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await POST(
      formRequest({ caption: "yeni", files: [{ name: "1.jpg" }] }),
      params(post.id)
    );
    expect(res.status).toBe(409);
    expect(mockUpload).not.toHaveBeenCalled();
    // Video postu görselle karışırsa hangi medyanın yayınlanacağı belirsizleşir.
    expect(await db.postImage.count({ where: { postId: post.id } })).toBe(0);
  });

  it("Reel'in metni düzeltilip onaya geri gönderilebilir", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { post } = await createRevisionRequestedPost(agency.id, client.id, {
      videoUrl: "https://blob.test/reel.mp4",
    });
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await POST(formRequest({ caption: "düzeltilmiş" }), params(post.id));
    expect(res.status).toBe(200);
    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.status).toBe("pending");
    expect(updated?.caption).toBe("düzeltilmiş");
    expect(updated?.videoUrl).toBe("https://blob.test/reel.mp4");
  });

  it("mail yolu throw etse bile revizyon ayakta kalır", async () => {
    const { post } = await seed();
    mockEmail.mockRejectedValue(new Error("resend down"));

    const res = await POST(request({ caption: "yeni" }), params(post.id));
    expect(res.status).toBe(200);
    expect((await res.json()).emailSent).toBe(false);
    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.status).toBe("pending");
  });
});
