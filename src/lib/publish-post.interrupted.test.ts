import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 2026-11-01: kilit tuttuktan sonra DB bağlantısı koptu, `markFailed`in yazması
 * da aynı ölü bağlantıya çarptı. Post `publishing` + container boş kaldı ve
 * hiçbir yol onu ilerletmedi. Bu dosya o olayın yeniden üretimi (gerçek
 * Postgres, kopma `vi.spyOn` ile tek çağrıda) ve kurtarma ağının kaçış yolu.
 * DB'siz karar mantığı `publish-recovery.unit.test.ts`te.
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
vi.mock("@/lib/alerts", () => ({ sendAlert: vi.fn(async () => undefined) }));

import { Prisma } from "@prisma/client";
import { publishApprovedPost, recoverInterruptedPublishes, resumePublish } from "./publish-post";
import { db } from "@/lib/db";
import { sendAlert } from "@/lib/alerts";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { sendAgencyNoticeEmail, sendRawEmail } from "@/lib/email";
import { IGError, createReelContainer, finalizeContainer } from "@/lib/instagram";
import { notifyClientUsers } from "@/lib/push";
import { INTERRUPTED_PUBLISH_DETAIL } from "@/lib/publish-recovery";
import { signGetUrl } from "@/lib/storage-r2";
import { createAgency, createInstagramClient, createPendingPostWithLink, resetDb } from "@tests/helpers/db";
import { createQueuePost } from "@tests/helpers/queue";

const mockCreateReel = vi.mocked(createReelContainer);
const mockFinalize = vi.mocked(finalizeContainer);
const mockSign = vi.mocked(signGetUrl);
const mockRaw = vi.mocked(sendRawEmail);
const mockAgency = vi.mocked(sendAgencyNoticeEmail);
const mockPush = vi.mocked(notifyClientUsers);
const mockAlert = vi.mocked(sendAlert);

const MIN = 60_000;

/** Olaydaki hata: Prisma'nın P1017'si, uyarıdaki metinle. */
const connectionLost = () =>
  new Prisma.PrismaClientKnownRequestError(
    "Invalid `prisma.post.updateMany()` invocation:\n\nServer has closed the connection.",
    { code: "P1017", clientVersion: "6.5.0" }
  );

/**
 * Gerçek `updateMany`, HİÇBİR spy kurulmadan önce yakalanır. Prisma delegate'i
 * bir proxy: `vi.restoreAllMocks` spy'ı geri alırken metodu silip `undefined`
 * bırakıyor, bu yüzden dosya restore etmez — `spyOn` aynı spy'ı geri verir,
 * `*Once` kuyrukları tükenince spy gerçek metoda düşer.
 */
const realUpdateMany = db.post.updateMany.bind(db.post);
const realUpdate = db.post.update.bind(db.post);
const realFindUnique = db.post.findUnique.bind(db.post);

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  // Spy'lar kalıcı olarak gerçeğe bağlı; testler üstüne yalnızca `*Once` koyar.
  vi.spyOn(db.post, "updateMany").mockImplementation(realUpdateMany as never);
  vi.spyOn(db.post, "update").mockImplementation(realUpdate as never);
  vi.spyOn(db.post, "findUnique").mockImplementation(realFindUnique as never);
  vi.stubEnv("APP_URL", "https://app.example");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mockRaw.mockResolvedValue({ sent: true });
  mockAgency.mockResolvedValue({ sent: true });
  mockSign.mockResolvedValue("https://r2.example/v.mp4?X-Amz-Signature=s");
  mockCreateReel.mockResolvedValue("reel-q");
  mockFinalize.mockResolvedValue({
    state: "published",
    mediaId: "media-q",
    permalink: "https://instagram.com/reel/Q/",
  });
});

async function seed() {
  const agency = await createAgency();
  const client = await createInstagramClient(agency.id);
  return { agency, client };
}

/** Kilidin üzerinden `ms` geçmiş gibi — `@updatedAt` Prisma'dan yazılamıyor. */
async function age(postId: string, ms: number) {
  await db.$executeRaw`UPDATE "Post" SET "updatedAt" = ${new Date(Date.now() - ms)} WHERE id = ${postId}`;
}

/** İlk `updateMany` (yayın kilidi) gerçek DB'ye gider, ikincisi (`markFailed`) kopar. */
function breakSecondUpdateMany() {
  vi.spyOn(db.post, "updateMany")
    .mockImplementationOnce(realUpdateMany as never)
    .mockRejectedValueOnce(connectionLost());
}

describe("yayın ortasında DB koparsa throw etmez", () => {
  it("olayın birebiri: container hatası + markFailed yazması kopuyor → 'publishing', uyarı, post container'sız asılı", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id);
    mockCreateReel.mockRejectedValue(new IGError("Instagram API'ye ulaşılamadı"));
    breakSecondUpdateMany();

    const outcome = await publishApprovedPost(post.id);

    expect(outcome.publishStatus).toBe("publishing");
    expect(mockAlert).toHaveBeenCalledWith(
      "publish:interrupted",
      expect.any(String),
      expect.objectContaining({ postId: post.id })
    );
    const row = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(row).toMatchObject({ publishStatus: "publishing", igContainerId: null });
  });

  it("container açıldı ama id yazılamadı → throw etmez ve yayın YAPILMAZ", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id);
    vi.spyOn(db.post, "update").mockRejectedValueOnce(connectionLost());
    breakSecondUpdateMany(); // aynı bağlantı ölü: markFailed de kopar

    await expect(publishApprovedPost(post.id)).resolves.toMatchObject({ publishStatus: "publishing" });
    expect(mockCreateReel).toHaveBeenCalledTimes(1);
    expect(mockFinalize).not.toHaveBeenCalled();
  });

  it("resumePublish: finalize hata + container temizleme yazması kopuyor → throw etmez", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id, {
      publishStatus: "publishing",
      igContainerId: "reel-x",
      containerAt: new Date(),
    });
    mockFinalize.mockRejectedValue(new IGError("Container reel-x durumu ERROR"));
    vi.spyOn(db.post, "update").mockRejectedValueOnce(connectionLost());

    await expect(resumePublish(post.id)).resolves.toMatchObject({ publishStatus: "publishing" });
  });

  it("kilitten ÖNCE DB kopuyor → throw etmez, post idle kalır, Instagram'a gidilmez", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id);
    vi.spyOn(db.post, "findUnique").mockRejectedValueOnce(connectionLost());

    await expect(publishApprovedPost(post.id)).resolves.toMatchObject({ publishStatus: "publishing" });
    const row = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(row.publishStatus).toBe("idle");
    expect(mockCreateReel).not.toHaveBeenCalled();
  });
});

describe("recoverInterruptedPublishes", () => {
  it("11 dk sessiz takılı portal postu → failed, SlotRun kapanır, bildirimler bir kez", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id, { publishStatus: "publishing" });
    await db.slotRun.create({
      data: { clientId: client.id, slotAt: new Date(Date.now() - 11 * MIN), postId: post.id },
    });
    await age(post.id, 11 * MIN);

    expect(await recoverInterruptedPublishes()).toBe(1);

    const row = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(row).toMatchObject({ publishStatus: "failed", publishError: INTERRUPTED_PUBLISH_DETAIL });
    const run = await db.slotRun.findFirstOrThrow({ where: { postId: post.id } });
    expect(run.outcome).toBe("failed");
    expect(mockRaw).toHaveBeenCalledTimes(1); // müşteriye "yayınlanamadı"
    expect(mockAgency).toHaveBeenCalledTimes(1);
    expect(mockAgency).toHaveBeenCalledWith(expect.objectContaining({ event: "queue_failed" }));
    expect(mockPush).toHaveBeenCalledTimes(1);

    // İkinci tur bir şey yapmaz.
    expect(await recoverInterruptedPublishes()).toBe(0);
    expect(mockRaw).toHaveBeenCalledTimes(1);
  });

  it("2 dk önce kilitlenmiş post → dokunulmaz (kilit sahibi hâlâ yaşıyor olabilir)", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id, { publishStatus: "publishing" });
    await age(post.id, 2 * MIN);

    expect(await recoverInterruptedPublishes()).toBe(0);
    const row = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(row.publishStatus).toBe("publishing");
  });

  it("container'ı açılmış eski post → dokunulmaz (resumePublish'in işi)", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id, {
      publishStatus: "publishing",
      igContainerId: "reel-y",
      containerAt: new Date(Date.now() - 30 * MIN),
    });
    await age(post.id, 30 * MIN);

    expect(await recoverInterruptedPublishes()).toBe(0);
    const row = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(row).toMatchObject({ publishStatus: "publishing", igContainerId: "reel-y" });
  });

  it("failed ve published postlar → dokunulmaz, bildirim yok", async () => {
    const { agency, client } = await seed();
    const failed = await createQueuePost(agency.id, client.id, { publishStatus: "failed" });
    const published = await createQueuePost(agency.id, client.id, { publishStatus: "published" });
    await age(failed.id, 60 * MIN);
    await age(published.id, 60 * MIN);

    expect(await recoverInterruptedPublishes()).toBe(0);
    expect(mockRaw).not.toHaveBeenCalled();
    expect(mockAgency).not.toHaveBeenCalled();
  });

  it("kaçış yolu: kurtarılan video portaldan 'tekrar dene' ile idle'a döner", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id, { publishStatus: "publishing" });
    await age(post.id, 11 * MIN);
    await recoverInterruptedPublishes();

    const portal = getClientScopedDb({ clientUserId: "u", clientId: client.id });
    expect(await portal.posts.retry(post.id)).toBe(true);
    const row = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(row).toMatchObject({ publishStatus: "idle", slotAt: null, publishError: null });
  });

  it("takılı ajans postu → failed, ajansa 'yayınlanamadı' bildirimi bir kez, müşteri e-postası yok", async () => {
    const { agency, client } = await seed();
    const { post } = await createPendingPostWithLink(agency.id, client.id, {
      status: "approved",
      publishStatus: "publishing",
    });
    await age(post.id, 11 * MIN);

    expect(await recoverInterruptedPublishes()).toBe(1);
    expect(mockAgency).toHaveBeenCalledTimes(1);
    expect(mockAgency).toHaveBeenCalledWith(
      expect.objectContaining({ event: "approved", publishStatus: "failed" })
    );
    expect(mockRaw).not.toHaveBeenCalled();
  });
});
