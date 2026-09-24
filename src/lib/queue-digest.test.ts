import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/storage-r2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage-r2")>();
  return { ...actual, signGetUrl: vi.fn() };
});
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendRawEmail: vi.fn() };
});

import { resetQueueDigestForTests, runQueueDigest } from "./queue-digest";
import { sendRawEmail } from "@/lib/email";
import { StorageNotConfiguredError, signGetUrl } from "@/lib/storage-r2";
import { createAgency, createInstagramClient, resetDb } from "@tests/helpers/db";
import { createPublishSettings, createQueuePost } from "@tests/helpers/queue";

const mockRaw = vi.mocked(sendRawEmail);
const mockSign = vi.mocked(signGetUrl);

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
