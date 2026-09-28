import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/storage-r2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage-r2")>();
  return { ...actual, signGetUrl: vi.fn() };
});
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendRawEmail: vi.fn() };
});

vi.mock("@/lib/push", () => ({
  notifyClientUsers: vi.fn(async () => ({ sent: 1, removed: 0, failed: 0 })),
}));

import { resetQueueDigestForTests, runQueueDigest } from "./queue-digest";
import { notifyClientUsers } from "@/lib/push";
import { sendRawEmail } from "@/lib/email";
import { StorageNotConfiguredError, signGetUrl } from "@/lib/storage-r2";
import { createAgency, createInstagramClient, resetDb } from "@tests/helpers/db";
import { createPublishSettings, createQueuePost } from "@tests/helpers/queue";

const mockRaw = vi.mocked(sendRawEmail);
const mockSign = vi.mocked(signGetUrl);
const mockPush = vi.mocked(notifyClientUsers);

// Cron'un koştuğu an: 25 Eylül 12:00 İstanbul. "Yarın" = 26 Eylül.
const NOW = new Date("2026-09-25T09:00:00Z");

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  resetQueueDigestForTests();
  mockRaw.mockResolvedValue({ sent: true });
  mockSign.mockImplementation(async (key) => `https://r2.example/${key}?X-Amz-Signature=s`);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function seed(settings: Parameters<typeof createPublishSettings>[1] = {}) {
  const agency = await createAgency();
  const client = await createInstagramClient(agency.id);
  await createPublishSettings(client.id, settings);
  return { agency, client };
}

describe("runQueueDigest", () => {
  it("yarın yayınlanacak videoyu yerel saat ve 7 günlük kapak URL'iyle bildirir", async () => {
    const { agency, client } = await seed({ slots: ["19:00"], requireApproval: false });
    // Bugün 19:00 ilkini alır; yarın 19:00 ikincisi.
    await createQueuePost(agency.id, client.id, { caption: "Bugünkü video" });
    const second = await createQueuePost(agency.id, client.id, {
      status: "pending",
      caption: "Yarınki video",
    });

    const stats = await runQueueDigest(NOW);

    expect(stats).toMatchObject({ sent: 1, failed: 0 });
    const mail = mockRaw.mock.calls[0][0];
    expect(mail.to).toBe(client.email);
    expect(mail.subject).toBe("Yarın 1 video yayınlanacak");
    expect(mail.text).toContain("Yarın 19:00: “Yarınki video”");
    expect(mail.text).not.toContain("Bugünkü video");
    // Onay kapalı: "bekliyor" satırı hiç yok.
    expect(mail.text).not.toContain("onayını bekliyor");
    expect(mockSign).toHaveBeenCalledWith(second.frameKeys[0], 7 * 24 * 60 * 60);
    expect(mail.html).toContain(`https://r2.example/${second.frameKeys[0]}`);
  });

  it("onay açık: bekleyen sayısını verir; onaysızlar takvimde görünmez", async () => {
    const { agency, client } = await seed({ requireApproval: true });
    await createQueuePost(agency.id, client.id, { status: "pending" });
    await createQueuePost(agency.id, client.id, { status: "pending" });
    await createQueuePost(agency.id, client.id, { status: "pending", captionStatus: "generating" });

    await runQueueDigest(NOW);

    const mail = mockRaw.mock.calls[0][0];
    expect(mail.subject).toBe("2 video onayını bekliyor");
    expect(mail.text).toContain("yarın yayın yapılmayacak");
  });

  it("anlatacak bir şey yoksa e-posta gitmez", async () => {
    await seed({ requireApproval: true });
    const stats = await runQueueDigest(NOW);
    expect(stats).toMatchObject({ checked: 1, sent: 0 });
    expect(mockRaw).not.toHaveBeenCalled();
  });

  it("duraklatılmış müşteriye özet gitmez", async () => {
    const { agency, client } = await seed({ paused: true, requireApproval: false });
    await createQueuePost(agency.id, client.id);
    await createQueuePost(agency.id, client.id);
    expect((await runQueueDigest(NOW)).checked).toBe(0);
    expect(mockRaw).not.toHaveBeenCalled();
  });

  it("aynı gün ikinci koşu tekrar göndermez (süreç içi koruma)", async () => {
    const { agency, client } = await seed({ requireApproval: true });
    await createQueuePost(agency.id, client.id, { status: "pending" });

    await runQueueDigest(NOW);
    const second = await runQueueDigest(new Date(NOW.getTime() + 60 * 60_000));

    expect(second).toMatchObject({ sent: 0, duplicate: 1 });
    expect(mockRaw).toHaveBeenCalledTimes(1);
  });

  it("gönderim başarısızsa damga yok — aynı gün yeniden denenebilir", async () => {
    const { agency, client } = await seed({ requireApproval: true });
    await createQueuePost(agency.id, client.id, { status: "pending" });
    mockRaw.mockResolvedValueOnce({ sent: false, reason: "resend reddetti" });
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect((await runQueueDigest(NOW)).failed).toBe(1);
    expect((await runQueueDigest(NOW)).sent).toBe(1);
  });

  it("R2 yapılandırılmamışsa özet kapaksız gider", async () => {
    const { agency, client } = await seed({ requireApproval: false });
    await createQueuePost(agency.id, client.id);
    await createQueuePost(agency.id, client.id);
    mockSign.mockRejectedValue(new StorageNotConfiguredError());
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect((await runQueueDigest(NOW)).sent).toBe(1);
    expect(mockRaw.mock.calls[0][0].html).not.toContain("<img");
  });

  it("notifyEmail varsa oraya gider", async () => {
    const { agency, client } = await seed({ requireApproval: true, notifyEmail: "n@x.test" });
    await createQueuePost(agency.id, client.id, { status: "pending" });
    await runQueueDigest(NOW);
    expect(mockRaw.mock.calls[0][0].to).toBe("n@x.test");
  });
});

describe("günlük hatırlatma telefon bildirimi (V7c — e-postaya EK kanal)", () => {
  it("yarın yayınlanacak → 'Yarın 19:00'da yayınlanacak' + caption başı; imzalı kapak URL'i YOK", async () => {
    const { agency, client } = await seed({ slots: ["19:00"], requireApproval: false });
    await createQueuePost(agency.id, client.id, { caption: "Bugünkü video" });
    await createQueuePost(agency.id, client.id, { status: "pending", caption: "Yarınki video" });
    // Üçüncü gün de dolu: kuyruk azalmıyor, bildirim olağan özet.
    await createQueuePost(agency.id, client.id, { caption: "Öbür günkü video" });

    await runQueueDigest(NOW);

    expect(mockRaw).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledTimes(1);
    const [clientId, payload] = mockPush.mock.calls[0];
    expect(clientId).toBe(client.id);
    expect(payload).toMatchObject({
      title: "Yarın 19:00'da yayınlanacak",
      body: "Yarınki video",
      url: "/portal",
      tag: "gunluk-ozet",
    });
    expect(JSON.stringify(payload)).not.toContain("X-Amz-Signature");
  });

  it("yarın yayın yok ama onay bekleyen var → bekleyen sayısı", async () => {
    const { agency, client } = await seed({ requireApproval: true });
    await createQueuePost(agency.id, client.id, { status: "pending" });
    await runQueueDigest(NOW);
    expect(mockPush).toHaveBeenCalledWith(
      client.id,
      expect.objectContaining({ title: "1 video onayını bekliyor" })
    );
  });

  it("anlatacak bir şey yoksa bildirim de yok; aynı gün ikinci koşuda tekrar yok", async () => {
    await seed({ requireApproval: true });
    await runQueueDigest(NOW);
    expect(mockPush).not.toHaveBeenCalled();

    const { agency, client } = await seed({ requireApproval: true });
    await createQueuePost(agency.id, client.id, { status: "pending" });
    await runQueueDigest(NOW);
    await runQueueDigest(NOW);
    expect(mockPush).toHaveBeenCalledTimes(1);
  });
});

describe("kuyruk azalıyor (2026-09-28 analizi)", () => {
  it("son onaylı video yarın: gövdede uyarı + boş geçecek ilk slot; konu yarının videosu", async () => {
    const { agency, client } = await seed({ slots: ["19:00"], requireApproval: false });
    await createQueuePost(agency.id, client.id, { caption: "Bugünkü video" });
    await createQueuePost(agency.id, client.id, { caption: "Yarınki video" });

    await runQueueDigest(NOW);

    const mail = mockRaw.mock.calls[0][0];
    expect(mail.subject).toBe("Yarın 1 video yayınlanacak");
    expect(mail.text).toContain("Kuyruk yarın bitiyor: yeni video yüklemezsen");
    // Boş geçecek ilk slot: 27 Eylül 19:00 (İstanbul).
    expect(mail.text).toContain("27 Eylül");
    expect(mockPush).toHaveBeenCalledWith(
      client.id,
      expect.objectContaining({
        title: "Kuyruk yarın bitiyor",
        body: "Yeni video yüklemezsen Pazar 19:00 yayını boş geçer.",
        url: "/portal/yukle",
      })
    );
  });

  it("son video bugün: yarın anlatacak bir şey olmasa da özet gider, konu 'bugün bitiyor'", async () => {
    const { agency, client } = await seed({ slots: ["19:00"], requireApproval: false });
    await createQueuePost(agency.id, client.id, { caption: "Bugünkü video" });

    const stats = await runQueueDigest(NOW);

    expect(stats.sent).toBe(1);
    const mail = mockRaw.mock.calls[0][0];
    expect(mail.subject).toBe("Kuyruk bugün bitiyor");
    expect(mail.text).toContain("26 Eylül");
    expect(mockPush.mock.calls[0][1]).toMatchObject({ title: "Kuyruk bugün bitiyor", url: "/portal/yukle" });
  });

  it("onay açık, onaylı video yok ama bekleyen var: 'azalıyor' değil, bekleyen sayısı", async () => {
    const { agency, client } = await seed({ requireApproval: true });
    await createQueuePost(agency.id, client.id, { status: "pending" });
    await runQueueDigest(NOW);
    const mail = mockRaw.mock.calls[0][0];
    expect(mail.subject).toBe("1 video onayını bekliyor");
    expect(mail.text).not.toContain("bitiyor");
  });

  it("3 gün ve üstü yetiyorsa uyarı yok", async () => {
    const { agency, client } = await seed({ slots: ["19:00"], requireApproval: false });
    for (let i = 0; i < 3; i++) await createQueuePost(agency.id, client.id);
    await runQueueDigest(NOW);
    expect(mockRaw.mock.calls[0][0].text).not.toContain("bitiyor");
    expect(mockPush.mock.calls[0][1].title).toBe("Yarın 19:00'da yayınlanacak");
  });
});
