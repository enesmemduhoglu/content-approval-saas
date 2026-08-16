import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Instagram'a gerçek istek atılmaz: yayın çekirdeği (`publishToInstagram`) ve
 * canlılık sorgusu (`checkMediaLiveness`) mock'lanır — instagram.test.ts o
 * ikisini kendi başına test ediyor. Burada test edilen şey, `publish-post`'un
 * BU iki cevaba göre verdiği karar.
 */
vi.mock("@/lib/instagram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/instagram")>();
  return { ...actual, publishToInstagram: vi.fn(), checkMediaLiveness: vi.fn() };
});

import { publishApprovedPost } from "./publish-post";
import { db } from "@/lib/db";
import { IGError, checkMediaLiveness, publishToInstagram } from "@/lib/instagram";
import {
  createAgency,
  createInstagramClient,
  createPendingPostWithLink,
  createPublishedPost,
  resetDb,
} from "@tests/helpers/db";

const mockPublish = vi.mocked(publishToInstagram);
const mockLiveness = vi.mocked(checkMediaLiveness);

const REF = "dizi/long-story-short";

beforeEach(async () => {
  await resetDb();
  vi.restoreAllMocks();
  mockPublish.mockReset();
  mockLiveness.mockReset();
  mockPublish.mockResolvedValue({
    mediaId: "media-yeni",
    permalink: "https://instagram.com/p/YENI/",
  });
});

/** Instagram bağlı müşteride, yayına hazır (onaylanmış, idle) bir post. */
async function seedApprovedPost(overrides: { externalRef?: string } = {}) {
  const agency = await createAgency();
  const client = await createInstagramClient(agency.id);
  const { post } = await createPendingPostWithLink(agency.id, client.id, {
    status: "approved",
    ...overrides,
  });
  return { agency, client, post };
}

describe("publishApprovedPost — externalRef yoksa", () => {
  it("davranış eskisi gibi: hiç canlılık sorgusu yapmadan yayınlar", async () => {
    const { post } = await seedApprovedPost();

    const outcome = await publishApprovedPost(post.id);

    expect(outcome.publishStatus).toBe("published");
    expect(mockPublish).toHaveBeenCalledTimes(1);
    // externalRef yokken kardeş sorgusu hiç çalışmamalı — mevcut kullanıcıların
    // akışına tek bir fazladan Instagram çağrısı bile eklenmiyor.
    expect(mockLiveness).not.toHaveBeenCalled();

    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.publishStatus).toBe("published");
    expect(updated?.igMediaId).toBe("media-yeni");
  });
});

describe("publishApprovedPost — mükerrer yayın koruması", () => {
  it("kardeş post SİLİNMİŞSE yayınlar (kurtarma yolu korunur)", async () => {
    const { agency, client, post } = await seedApprovedPost({ externalRef: REF });
    await createPublishedPost(agency.id, client.id, { externalRef: REF });
    mockLiveness.mockResolvedValue("deleted");

    const outcome = await publishApprovedPost(post.id);

    expect(mockLiveness).toHaveBeenCalledWith("media-eski", "IGAA-test-token");
    expect(outcome.publishStatus).toBe("published");
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it("kardeş post CANLIYSA yayınlamaz, 'duplicate' der ve canlı linki döner", async () => {
    const { agency, client, post } = await seedApprovedPost({ externalRef: REF });
    await createPublishedPost(agency.id, client.id, {
      externalRef: REF,
      igPermalink: "https://instagram.com/p/CANLI/",
    });
    mockLiveness.mockResolvedValue("live");

    const outcome = await publishApprovedPost(post.id);

    expect(mockPublish).not.toHaveBeenCalled();
    expect(outcome.publishStatus).toBe("duplicate");
    expect(outcome.igPermalink).toBe("https://instagram.com/p/CANLI/");
    expect(outcome.publishError).toContain("zaten Instagram'da yayında");
    expect(outcome.publishError).toContain(REF);

    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.publishStatus).toBe("duplicate");
    expect(updated?.igPermalink).toBe("https://instagram.com/p/CANLI/");
    // Bu satır yayınlanmadı: igMediaId boş kalır, "published" ile karışmaz.
    expect(updated?.igMediaId).toBeNull();
    expect(updated?.publishedAt).toBeNull();
  });

  it("canlılık BELİRSİZSE yayınlar ve konsola uyarı basar", async () => {
    const { agency, client, post } = await seedApprovedPost({ externalRef: REF });
    await createPublishedPost(agency.id, client.id, { externalRef: REF });
    // Ağ hatası / beklenmeyen API cevabı → "unknown"
    mockLiveness.mockResolvedValue("unknown");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const outcome = await publishApprovedPost(post.id);

    // Emniyet ağı, kapı değil: belirsizde silinen-post kurtarma yolu kırılmaz.
    expect(outcome.publishStatus).toBe("published");
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).toContain("belirsiz");
  });

  it("canlılık sorgusu THROW ederse de yayın durmaz", async () => {
    const { agency, client, post } = await seedApprovedPost({ externalRef: REF });
    await createPublishedPost(agency.id, client.id, { externalRef: REF });
    mockLiveness.mockRejectedValue(new IGError("Instagram API'ye ulaşılamadı"));

    // Yayın akışı bir teşhis çağrısı yüzünden ASLA patlamamalı; hata "failed"e
    // dönüşürse ajans sebebini anlamadan tekrar dene döngüsüne girer.
    await expect(publishApprovedPost(post.id)).resolves.toMatchObject({
      publishStatus: "published",
    });
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it("aynı externalRef FARKLI ajansta ise engellemez (izolasyon)", async () => {
    const { post } = await seedApprovedPost({ externalRef: REF });
    // Başka bir ajans aynı slug'ı yayınlamış olabilir — slug'lar jenerik.
    const other = await createAgency();
    const otherClient = await createInstagramClient(other.id);
    await createPublishedPost(other.id, otherClient.id, { externalRef: REF });
    mockLiveness.mockResolvedValue("live");

    const outcome = await publishApprovedPost(post.id);

    expect(mockLiveness).not.toHaveBeenCalled();
    expect(outcome.publishStatus).toBe("published");
  });

  it("kardeş yayınlanmamışsa (failed) canlılık hiç sorulmaz", async () => {
    const { agency, client, post } = await seedApprovedPost({ externalRef: REF });
    const twin = await createPublishedPost(agency.id, client.id, { externalRef: REF });
    await db.post.update({
      where: { id: twin.id },
      data: { publishStatus: "failed", igMediaId: null, publishedAt: null },
    });

    const outcome = await publishApprovedPost(post.id);

    expect(mockLiveness).not.toHaveBeenCalled();
    expect(outcome.publishStatus).toBe("published");
  });

  it("kardeşin igMediaId'si yoksa sorgulanamaz — yayın engellenmez", async () => {
    const { agency, client, post } = await seedApprovedPost({ externalRef: REF });
    await createPublishedPost(agency.id, client.id, {
      externalRef: REF,
      igMediaId: null,
    });

    const outcome = await publishApprovedPost(post.id);

    expect(mockLiveness).not.toHaveBeenCalled();
    expect(outcome.publishStatus).toBe("published");
  });

  it("iki kardeşten biri silinmiş biri canlıysa yayın engellenir", async () => {
    const { agency, client, post } = await seedApprovedPost({ externalRef: REF });
    await createPublishedPost(agency.id, client.id, {
      externalRef: REF,
      igMediaId: "media-silinmis",
    });
    await createPublishedPost(agency.id, client.id, {
      externalRef: REF,
      igMediaId: "media-canli",
      igPermalink: "https://instagram.com/p/CANLI/",
    });
    mockLiveness.mockImplementation(async (mediaId: string) =>
      mediaId === "media-canli" ? "live" : "deleted"
    );

    const outcome = await publishApprovedPost(post.id);

    expect(outcome.publishStatus).toBe("duplicate");
    expect(outcome.igPermalink).toBe("https://instagram.com/p/CANLI/");
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("Instagram bağlı olmayan müşteride kontrol çalışmaz (skipped korunur)", async () => {
    const agency = await createAgency();
    const client = await db.client.create({
      data: { agencyId: agency.id, name: "Bağsız", email: "b@test.local" },
    });
    const { post } = await createPendingPostWithLink(agency.id, client.id, {
      status: "approved",
      externalRef: REF,
    });
    await createPublishedPost(agency.id, client.id, { externalRef: REF });

    const outcome = await publishApprovedPost(post.id);

    expect(outcome.publishStatus).toBe("skipped");
    expect(mockLiveness).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("'duplicate' post tekrar denenemez — yayın kilidi geçit vermez", async () => {
    const { agency, client, post } = await seedApprovedPost({ externalRef: REF });
    await createPublishedPost(agency.id, client.id, {
      externalRef: REF,
      igPermalink: "https://instagram.com/p/CANLI/",
    });
    mockLiveness.mockResolvedValue("live");

    await publishApprovedPost(post.id);
    mockLiveness.mockClear();

    // Kilit `idle`/`failed` dışına çıkmaz: ikinci çağrı mevcut durumu okur,
    // yeniden yayın denemez.
    const again = await publishApprovedPost(post.id);
    expect(again.publishStatus).toBe("duplicate");
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockLiveness).not.toHaveBeenCalled();
  });
});
