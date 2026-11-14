import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tick ve 2026-11-01 olayı: yayın ortasında DB kopması ve kurtarma ağı.
 *
 * `route.test.ts`ten AYRI dosya: buradaki senaryolar `db.post.updateMany`e spy
 * kuruyor. Prisma delegesinde spy geri alınamıyor (metot kayboluyor) ve
 * `clearAllMocks` onu boş döndürüyor — paylaşılan dosyada sonraki her testi
 * bozardı. Burada spy her testte gerçeğe yeniden bağlanıyor.
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
vi.mock("@/lib/media-retention", () => ({
  retentionDue: vi.fn(() => false),
  runMediaRetention: vi.fn(async () => ({ archived: 0, purged: 0, failed: 0 })),
}));
vi.mock("@upstash/qstash", async () => (await import("@tests/helpers/qstash")).qstashModule());
vi.mock("@/lib/alerts", () => ({ sendAlert: vi.fn(async () => undefined) }));

import { Prisma } from "@prisma/client";
import { POST } from "./route";
import { db } from "@/lib/db";
import { sendAlert } from "@/lib/alerts";
import { sendAgencyNoticeEmail, sendRawEmail } from "@/lib/email";
import { IGError, createReelContainer } from "@/lib/instagram";
import { signGetUrl } from "@/lib/storage-r2";
import { createAgency, createInstagramClient, resetDb } from "@tests/helpers/db";
import { createPublishSettings, createQueuePost, slotMinutesAgo } from "@tests/helpers/queue";
import { resetQstashMock } from "@tests/helpers/qstash";

const mockCreateReel = vi.mocked(createReelContainer);
const mockAlert = vi.mocked(sendAlert);
const CRON_SECRET = "q".repeat(40);
const MIN = 60_000;

const slotWake = () =>
  new Request("http://localhost/api/queue/tick", {
    method: "POST",
    headers: { authorization: `Bearer ${CRON_SECRET}` },
    body: JSON.stringify({ kind: "slot" }),
  });

const connectionLost = () =>
  new Prisma.PrismaClientKnownRequestError(
    "Invalid `prisma.post.updateMany()` invocation:\n\nServer has closed the connection.",
    { code: "P1017", clientVersion: "6.5.0" }
  );

const realUpdateMany = db.post.updateMany.bind(db.post);

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  vi.spyOn(db.post, "updateMany").mockImplementation(realUpdateMany as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  vi.stubEnv("APP_URL", "https://app.example");
  vi.stubEnv("QSTASH_TOKEN", "test-token");
  resetQstashMock();
  vi.mocked(sendRawEmail).mockResolvedValue({ sent: true });
  vi.mocked(sendAgencyNoticeEmail).mockResolvedValue({ sent: true });
  vi.mocked(signGetUrl).mockResolvedValue("https://r2.example/v.mp4?X-Amz-Signature=s");
});

async function seed() {
  const agency = await createAgency();
  const client = await createInstagramClient(agency.id);
  const { slot } = slotMinutesAgo(5);
  await createPublishSettings(client.id, { slots: [slot] });
  return { agency, client };
}

describe("tick: yayın ortasında DB kopması", () => {
  it("markFailed yazması kopuyor → müşteri başına 'patladı' uyarısı YOK, tick 200, publishing sayılır", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id);
    mockCreateReel.mockRejectedValue(new IGError("Instagram API'ye ulaşılamadı"));
    vi.mocked(db.post.updateMany)
      .mockImplementationOnce(realUpdateMany as never) // claimPostForSlot
      .mockImplementationOnce(realUpdateMany as never) // yayın kilidi
      .mockRejectedValueOnce(connectionLost()); // markFailed

    const res = await POST(slotWake());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, publishing: 1, failed: 0 });
    const keys = mockAlert.mock.calls.map((call) => call[0]);
    expect(keys).not.toContain("queue:tick:client");
    expect(keys).toContain("publish:interrupted");
    const row = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(row).toMatchObject({ publishStatus: "publishing", igContainerId: null });
  });

  it("10 dakikayı geçmiş takılı post → tick onu failed'a çeker, SlotRun kapanır, yanıtta recovered", async () => {
    const { agency, client } = await seed();
    // Önceki bir slotun yarıda kalmış yayını: kuyrukta tek video, o da takılı —
    // bu turun slotu boş kalır, kurtarma ise takılıyı çözer.
    const stuck = await createQueuePost(agency.id, client.id, { publishStatus: "publishing" });
    await db.slotRun.create({
      data: { clientId: client.id, slotAt: new Date(Date.now() - 3 * 60 * MIN), postId: stuck.id },
    });
    await db.$executeRaw`UPDATE "Post" SET "updatedAt" = ${new Date(Date.now() - 11 * MIN)} WHERE id = ${stuck.id}`;

    const body = await (await POST(slotWake())).json();

    expect(body).toMatchObject({ ok: true, recovered: 1 });
    const row = await db.post.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(row.publishStatus).toBe("failed");
    const run = await db.slotRun.findFirstOrThrow({ where: { postId: stuck.id } });
    expect(run.outcome).toBe("failed");
  });

  it("yetim SlotRun (postu idle, 3 saatlik) → tick kapatır", async () => {
    const { agency, client } = await seed();
    // Caption'ı hazırlanıyor: o anki slotta seçilmesin ki post idle kalsın. K33
    // öncesi bunu onaysız (`pending`) olmak sağlıyordu; artık bekleyen video da
    // seçilir, seçilirse `publishing`e geçer ve satır haklı olarak bekletilir.
    const idle = await createQueuePost(agency.id, client.id, {
      status: "pending",
      captionStatus: "generating",
    });
    await db.slotRun.create({
      data: {
        clientId: client.id,
        slotAt: new Date(Date.now() - 3 * 60 * MIN),
        postId: idle.id,
        createdAt: new Date(Date.now() - 3 * 60 * MIN),
      },
    });

    const body = await (await POST(slotWake())).json();

    expect(body.recovered).toBe(1);
    const run = await db.slotRun.findFirstOrThrow({ where: { postId: idle.id } });
    expect(run).toMatchObject({ outcome: "failed", detail: "Slot yarıda kaldı — sonuç yazılamadı" });
  });
});
