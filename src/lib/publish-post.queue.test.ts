import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `publish-post.ts`in video kuyruğu (V4) tarafı: onay koruması, R2 imzalı URL
 * ve yayın sonucu e-postalarının TEK kez gitmesi. Ajans postunun değişmeyen
 * davranışı `publish-post.test.ts`te.
 */
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

import { NOT_APPROVED_ERROR, publishApprovedPost, resumePublish } from "./publish-post";
import { notifyClientUsers } from "@/lib/push";
import { db } from "@/lib/db";
import { sendAgencyNoticeEmail, sendRawEmail } from "@/lib/email";
import {
  IGError,
  createReelContainer,
  finalizeContainer,
  publishToInstagram,
} from "@/lib/instagram";
import { signGetUrl } from "@/lib/storage-r2";
import { expireRevokedToken } from "@/lib/instagram-revoked";
import {
  createAgency,
  createInstagramClient,
  createPendingPostWithLink,
  resetDb,
} from "@tests/helpers/db";
import { createPublishSettings, createQueuePost } from "@tests/helpers/queue";

const mockCreateReel = vi.mocked(createReelContainer);
const mockFinalize = vi.mocked(finalizeContainer);
const mockPublish = vi.mocked(publishToInstagram);
const mockSign = vi.mocked(signGetUrl);
const mockRaw = vi.mocked(sendRawEmail);
const mockAgency = vi.mocked(sendAgencyNoticeEmail);
const mockPush = vi.mocked(notifyClientUsers);

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  vi.stubEnv("APP_URL", "https://app.example");
  mockRaw.mockResolvedValue({ sent: true });
  mockAgency.mockResolvedValue({ sent: true });
  mockSign.mockResolvedValue("https://r2.example/v.mp4?X-Amz-Signature=s");
  mockCreateReel.mockResolvedValue("reel-q");
  mockFinalize.mockResolvedValue({
    state: "published",
    mediaId: "media-q",
    permalink: "https://instagram.com/reel/Q/",
  });
  mockPublish.mockResolvedValue({ mediaId: "m", permalink: "https://instagram.com/p/A/" });
});

async function seed() {
  const agency = await createAgency();
  const client = await createInstagramClient(agency.id);
  return { agency, client };
}

describe("GÜVENLİK: onaysız post yayınlanmaz", () => {
  it("bekleyen portal postu: Instagram'a hiç gidilmez, kilit alınmaz, durum değişmez", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id, { status: "pending" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const outcome = await publishApprovedPost(post.id);

    expect(outcome).toMatchObject({ publishStatus: "idle", publishError: NOT_APPROVED_ERROR });
    expect(mockSign).not.toHaveBeenCalled();
    expect(mockCreateReel).not.toHaveBeenCalled();
    const saved = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(saved.publishStatus).toBe("idle");
    expect(saved.igContainerId).toBeNull();
    expect(mockRaw).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).toContain("onaysız");
  });

  it.each(["pending", "rejected", "revision_requested", "draft"] as const)(
    "%s durumundaki AJANS postu da yayınlanmaz (kapı kaynaktan bağımsız)",
    async (status) => {
      const { agency, client } = await seed();
      const { post } = await createPendingPostWithLink(agency.id, client.id, { status });
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const outcome = await publishApprovedPost(post.id);

      expect(outcome.publishError).toBe(NOT_APPROVED_ERROR);
      expect(mockPublish).not.toHaveBeenCalled();
      const saved = await db.post.findUniqueOrThrow({ where: { id: post.id } });
      // `skipped` bile yazılmaz: karar verilmemiş posta yayın durumu işlenmez.
      expect(saved.publishStatus).toBe("idle");
    }
  );

  it("onaylanınca aynı post yayınlanır — kapı yalnızca onaysızı durdurur", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id, { status: "pending" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await publishApprovedPost(post.id);
    expect(mockCreateReel).not.toHaveBeenCalled();

    await db.post.update({ where: { id: post.id }, data: { status: "approved" } });
    expect((await publishApprovedPost(post.id)).publishStatus).toBe("published");
  });
});

describe("portal videosu: R2 imzalı URL", () => {
  it("videoKey 7 günlük imzalı URL'e çevrilip Instagram'a verilir", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id);

    const outcome = await publishApprovedPost(post.id);

    expect(outcome.publishStatus).toBe("published");
    expect(mockSign).toHaveBeenCalledWith(post.videoKey, 7 * 24 * 60 * 60);
    expect(mockCreateReel).toHaveBeenCalledWith(
      expect.objectContaining({ videoUrl: "https://r2.example/v.mp4?X-Amz-Signature=s" })
    );
  });

  it("container zaten açıksa yeniden imzalanmaz", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id, {
      publishStatus: "publishing",
      igContainerId: "reel-acik",
      containerAt: new Date(),
    });

    await publishApprovedPost(post.id);

    expect(mockSign).not.toHaveBeenCalled();
    expect(mockCreateReel).not.toHaveBeenCalled();
  });

  it("başka müşterinin önekindeki anahtar imzalanmaz → failed", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id);
    await db.post.update({
      where: { id: post.id },
      data: { videoKey: "clients/baska-musteri/videos/x.mp4" },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const outcome = await publishApprovedPost(post.id);

    expect(outcome.publishStatus).toBe("failed");
    expect(mockSign).not.toHaveBeenCalled();
    expect(mockCreateReel).not.toHaveBeenCalled();
  });
});

describe("yayın sonucu e-postaları", () => {
  it("başarıda müşteriye TEK e-posta: permalink + caption başı; notifyEmail öncelikli", async () => {
    const { agency, client } = await seed();
    await createPublishSettings(client.id, { notifyEmail: "bildirim@furkan.test" });
    const post = await createQueuePost(agency.id, client.id, {
      caption: "Bugün 'break a leg' deyimini öğreniyoruz\n#ingilizce",
    });

    await publishApprovedPost(post.id);

    expect(mockRaw).toHaveBeenCalledTimes(1);
    const mail = mockRaw.mock.calls[0][0];
    expect(mail.to).toBe("bildirim@furkan.test");
    expect(mail.subject).toBe("Videon Instagram'da yayınlandı");
    expect(mail.text).toContain("https://instagram.com/reel/Q/");
    expect(mail.text).toContain("Bugün 'break a leg' deyimini öğreniyoruz");
    expect(mail.text).not.toContain("#ingilizce");
    expect(mockAgency).not.toHaveBeenCalled();
  });

  it("çok turlu video: işlerken e-posta yok, bitince TEK kez; tekrar yoklama tekrar göndermez", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id);
    mockFinalize.mockResolvedValueOnce({ state: "processing", lastStatus: "IN_PROGRESS" });

    expect((await publishApprovedPost(post.id)).publishStatus).toBe("publishing");
    expect(mockRaw).not.toHaveBeenCalled();

    expect((await resumePublish(post.id)).publishStatus).toBe("published");
    expect(mockRaw).toHaveBeenCalledTimes(1);

    // Sonraki tick / günlük cron yeniden yoklarsa: iş bitmiş, e-posta tekrar gitmez.
    expect((await resumePublish(post.id)).publishStatus).toBe("published");
    expect((await publishApprovedPost(post.id)).publishStatus).toBe("published");
    expect(mockRaw).toHaveBeenCalledTimes(1);
  });

  it("eşzamanlı iki yoklayıcı aynı container'ı bitirirse e-posta yine TEK", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id, {
      publishStatus: "publishing",
      igContainerId: "reel-yaris",
      containerAt: new Date(),
    });

    await Promise.all([resumePublish(post.id), resumePublish(post.id)]);

    expect(mockRaw).toHaveBeenCalledTimes(1);
  });

  it("hatada müşteriye neden (sırsız) + portal linki, ekibe queue_failed", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id);
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockCreateReel.mockRejectedValue(
      new IGError(
        "Video indirilemedi https://graph.instagram.com/v23.0/x?access_token=IGAAgizli",
        { error: { code: 9004, fbtrace_id: "Afb" } }
      )
    );

    const outcome = await publishApprovedPost(post.id);

    expect(outcome.publishStatus).toBe("failed");
    expect(mockRaw).toHaveBeenCalledTimes(1);
    const mail = mockRaw.mock.calls[0][0];
    expect(mail.subject).toBe("Video yayınlanamadı");
    expect(mail.to).toBe(client.email);
    expect(mail.text).toContain("Video indirilemedi");
    expect(mail.text).toContain("fbtrace_id=Afb");
    expect(mail.text).toContain("https://app.example/portal");
    expect(mail.text + mail.html).not.toContain("IGAAgizli");
    expect(mail.text + mail.html).not.toContain("IGAA-test-token");

    expect(mockAgency).toHaveBeenCalledTimes(1);
    const notice = mockAgency.mock.calls[0][0];
    expect(notice.event).toBe("queue_failed");
    expect(notice.publishError).not.toContain("IGAAgizli");
  });

  it("e-posta patlarsa yayın sonucu etkilenmez (throw etmez)", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id);
    mockRaw.mockRejectedValue(new Error("resend çöktü"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(publishApprovedPost(post.id)).resolves.toMatchObject({
      publishStatus: "published",
    });
  });

  it("AJANS postunda kuyruk e-postası gitmez — mevcut davranış aynen", async () => {
    const { agency, client } = await seed();
    const { post } = await createPendingPostWithLink(agency.id, client.id, {
      status: "approved",
      videoUrl: "https://blob.example/v.mp4",
    });

    const outcome = await publishApprovedPost(post.id);

    expect(outcome.publishStatus).toBe("published");
    expect(mockSign).not.toHaveBeenCalled();
    expect(mockCreateReel).toHaveBeenCalledWith(
      expect.objectContaining({ videoUrl: "https://blob.example/v.mp4" })
    );
    expect(mockRaw).not.toHaveBeenCalled();
    expect(mockAgency).not.toHaveBeenCalled();
  });
});

describe("yayın sonucu telefon bildirimi (V7c — e-postaya EK kanal)", () => {
  it("yayınlandı → TEK bildirim, dokununca Instagram linki; e-posta da gider", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id, { caption: "Deyim dersi\n#ingilizce" });

    await publishApprovedPost(post.id);

    expect(mockRaw).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(client.id, {
      title: "Videon yayınlandı",
      body: "Deyim dersi",
      url: "https://instagram.com/reel/Q/",
      tag: "yayin-sonucu",
    });
  });

  it("çok turlu videoda bildirim de TEK kez (sonucu kazanan çağrıda)", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id);
    mockFinalize.mockResolvedValueOnce({ state: "processing", lastStatus: "IN_PROGRESS" });

    await publishApprovedPost(post.id);
    expect(mockPush).not.toHaveBeenCalled();
    await resumePublish(post.id);
    await resumePublish(post.id);
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it("yayınlanamadı → video detayına gider; neden sırsız", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id);
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockCreateReel.mockRejectedValue(
      new IGError("Video indirilemedi https://graph.instagram.com/v23.0/x?access_token=IGAAgizli", {
        error: { code: 9004 },
      })
    );

    await publishApprovedPost(post.id);

    expect(mockPush).toHaveBeenCalledTimes(1);
    const [clientId, payload] = mockPush.mock.calls[0];
    expect(clientId).toBe(client.id);
    expect(payload).toMatchObject({ title: "Video yayınlanamadı", url: `/portal/video/${post.id}` });
    expect(payload.body).toContain("Video indirilemedi");
    expect(JSON.stringify(payload)).not.toContain("IGAAgizli");
  });

  it("AJANS postunda bildirim yok", async () => {
    const { agency, client } = await seed();
    const { post } = await createPendingPostWithLink(agency.id, client.id, {
      status: "approved",
      videoUrl: "https://blob.example/v.mp4",
    });
    await publishApprovedPost(post.id);
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe("code=190: Meta token'ı iptal etti", () => {
  const revoked = () =>
    new IGError("Error validating access token: The session has been invalidated", {
      error: { type: "OAuthException", code: 190, fbtrace_id: "Afb" },
    });

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("token 'süresi dolmuş' işaretlenir; sonraki yayın Instagram'a gitmeden düşer", async () => {
    const { agency, client } = await seed();
    const first = await createQueuePost(agency.id, client.id);
    const second = await createQueuePost(agency.id, client.id);
    mockCreateReel.mockRejectedValueOnce(revoked());

    const outcome = await publishApprovedPost(first.id);
    expect(outcome).toMatchObject({ publishStatus: "failed", tokenRevoked: true });
    const saved = await db.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(saved.instagramTokenExpiry!.getTime()).toBeLessThanOrEqual(Date.now());
    // Teşhis metni korunur: ajans "neden" sorusunun cevabını panelde görür.
    const failedPost = await db.post.findUniqueOrThrow({ where: { id: first.id } });
    expect(failedPost.publishError).toContain("code=190");

    const next = await publishApprovedPost(second.id);
    expect(next.publishStatus).toBe("failed");
    expect(mockCreateReel).toHaveBeenCalledTimes(1);
  });

  it("devam eden videoda (resumePublish) 190 da işaretler", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id);
    await db.post.update({
      where: { id: post.id },
      data: {
        status: "approved",
        publishStatus: "publishing",
        igContainerId: "reel-x",
        containerAt: new Date(),
      },
    });
    mockFinalize.mockRejectedValueOnce(revoked());

    expect(await resumePublish(post.id)).toMatchObject({
      publishStatus: "failed",
      tokenRevoked: true,
    });
    const saved = await db.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(saved.instagramTokenExpiry!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("190 OLMAYAN hata bitiş tarihine dokunmaz", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id);
    mockCreateReel.mockRejectedValueOnce(
      new IGError("Video indirilemedi", { error: { code: 9004 } })
    );

    const outcome = await publishApprovedPost(post.id);
    expect(outcome.publishStatus).toBe("failed");
    expect(outcome.tokenRevoked).toBeUndefined();
    const saved = await db.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(saved.instagramTokenExpiry).toEqual(client.instagramTokenExpiry);
  });

  it("yayın sürerken ajans YENİ token bağladıysa eski token'ın 190'ı yenisini kilitlemez", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id);
    const fresh = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
    mockCreateReel.mockImplementationOnce(async () => {
      await db.client.update({
        where: { id: client.id },
        data: { instagramAccessToken: "IGAA-yeni-token", instagramTokenExpiry: fresh },
      });
      throw revoked();
    });

    await publishApprovedPost(post.id);
    const saved = await db.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(saved.instagramTokenExpiry).toEqual(fresh);
  });

  it("zaten geçmiş bir bitiş tarihi ezilmez (gerçek tarih daha anlamlı)", async () => {
    // Kapı geçmiş tarihi yayından önce yakalar; bu dal ancak okuma ile hata
    // arasında tarih geçerse görünür. İşaretleyicinin koşulu doğrudan sınanıyor.
    const { client } = await seed();
    const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await db.client.update({ where: { id: client.id }, data: { instagramTokenExpiry: past } });

    expect(await expireRevokedToken(client.id, "IGAA-test-token")).toBe(false);
    const saved = await db.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(saved.instagramTokenExpiry).toEqual(past);
  });
});
