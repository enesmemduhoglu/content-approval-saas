import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@upstash/qstash", async () => (await import("@tests/helpers/qstash")).qstashModule());

vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendApprovalReminderEmail: vi.fn(),
  sendAgencyNoticeEmail: vi.fn(),
  sendRawEmail: vi.fn(),
}));

import { GET } from "./route";
import { db } from "@/lib/db";
import { sendAgencyNoticeEmail, sendApprovalReminderEmail, sendRawEmail } from "@/lib/email";
import { REMINDER_AFTER_DAYS } from "@/lib/reminders";
import {
  createAgency,
  createClient,
  createPendingPostWithLink,
  resetDb,
} from "@tests/helpers/db";
import { createPublishSettings, createQueuePost } from "@tests/helpers/queue";
import { qstashMock, resetQstashMock } from "@tests/helpers/qstash";

const mockReminder = vi.mocked(sendApprovalReminderEmail);
const mockAgencyNotice = vi.mocked(sendAgencyNoticeEmail);

const CRON_SECRET = "c".repeat(40);
const gunOnce = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

const cronRequest = (secret = CRON_SECRET) =>
  new Request("http://localhost/api/cron/pending-reminders", {
    headers: { authorization: `Bearer ${secret}` },
  });

/** Postu N gün önce oluşmuş gibi geriye alır — bekleme süresini kurmanın tek yolu. */
async function yaslandir(postId: string, gun: number) {
  await db.post.update({ where: { id: postId }, data: { createdAt: gunOnce(gun) } });
}

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  mockReminder.mockResolvedValue({ sent: true });
  mockAgencyNotice.mockResolvedValue({ sent: true });
  vi.mocked(sendRawEmail).mockResolvedValue({ sent: true });
});

describe("yetkilendirme", () => {
  it("sırsız istek 401 alır", async () => {
    expect((await GET(new Request("http://localhost/api/cron/pending-reminders"))).status).toBe(
      401
    );
  });

  it("yanlış sır 401 alır", async () => {
    expect((await GET(cronRequest("x".repeat(40)))).status).toBe(401);
  });

  it("CRON_SECRET tanımlı değilse endpoint TAMAMEN kapalıdır", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await GET(cronRequest())).status).toBe(401);
  });
});

describe("müşteri hatırlatması", () => {
  it("eşiği geçen posta hatırlatma gider ve damga yazılır", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { post } = await createPendingPostWithLink(agency.id, client.id);
    await yaslandir(post.id, REMINDER_AFTER_DAYS);

    const res = await GET(cronRequest());
    expect(await res.json()).toMatchObject({ reminded: 1, expiryNoticed: 0, failed: 0 });

    expect(mockReminder).toHaveBeenCalledTimes(1);
    expect(mockReminder.mock.calls[0][0]).toMatchObject({
      to: client.email,
      clientName: client.name,
      daysPending: REMINDER_AFTER_DAYS,
    });

    const saved = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(saved.reminderSentAt).not.toBeNull();
  });

  it("ikinci koşuda TEKRAR göndermez (spam koruması)", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { post } = await createPendingPostWithLink(agency.id, client.id);
    await yaslandir(post.id, REMINDER_AFTER_DAYS + 3);

    await GET(cronRequest());
    expect(mockReminder).toHaveBeenCalledTimes(1);

    const ikinci = await GET(cronRequest());
    expect(await ikinci.json()).toMatchObject({ reminded: 0, skipped: 1 });
    expect(mockReminder).toHaveBeenCalledTimes(1);
  });

  it("eşiğin altındaki posta dokunmaz", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    await createPendingPostWithLink(agency.id, client.id); // bugün oluştu

    const res = await GET(cronRequest());
    expect(await res.json()).toMatchObject({ reminded: 0, skipped: 1 });
    expect(mockReminder).not.toHaveBeenCalled();
  });

  it("mail GİTMEZSE damga yazılmaz — ertesi gün tekrar denenir", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { post } = await createPendingPostWithLink(agency.id, client.id);
    await yaslandir(post.id, REMINDER_AFTER_DAYS);
    mockReminder.mockResolvedValue({ sent: false, reason: "resend reddetti" });

    const res = await GET(cronRequest());
    expect(await res.json()).toMatchObject({ reminded: 0, failed: 1 });

    const saved = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(saved.reminderSentAt).toBeNull();
  });
});

describe("süresi dolmuş link", () => {
  it("müşteriye değil AJANSA bildirilir", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { post } = await createPendingPostWithLink(agency.id, client.id, {
      expiresAt: gunOnce(1),
    });
    await yaslandir(post.id, 9);

    const res = await GET(cronRequest());
    expect(await res.json()).toMatchObject({ reminded: 0, expiryNoticed: 1 });

    expect(mockReminder).not.toHaveBeenCalled();
    expect(mockAgencyNotice).toHaveBeenCalledTimes(1);
    expect(mockAgencyNotice.mock.calls[0][0]).toMatchObject({
      to: [agency.email],
      event: "link_expired",
      clientName: client.name,
      daysPending: 9,
    });

    const saved = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(saved.expiryNoticeSentAt).not.toBeNull();
    expect(saved.reminderSentAt).toBeNull();
  });

  it("ajansa da yalnızca bir kez bildirilir", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { post } = await createPendingPostWithLink(agency.id, client.id, {
      expiresAt: gunOnce(1),
    });
    await yaslandir(post.id, 9);

    await GET(cronRequest());
    await GET(cronRequest());
    expect(mockAgencyNotice).toHaveBeenCalledTimes(1);
  });
});

describe("karar verilmiş postlar", () => {
  it("onaylanmış/reddedilmiş postlar hiç taranmaz", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { post: onayli } = await createPendingPostWithLink(agency.id, client.id, {
      status: "approved",
    });
    const { post: red } = await createPendingPostWithLink(agency.id, client.id, {
      status: "rejected",
      expiresAt: gunOnce(1),
    });
    await yaslandir(onayli.id, 10);
    await yaslandir(red.id, 10);

    const res = await GET(cronRequest());
    expect(await res.json()).toMatchObject({ checked: 0, reminded: 0, expiryNoticed: 0 });
    expect(mockReminder).not.toHaveBeenCalled();
    expect(mockAgencyNotice).not.toHaveBeenCalled();
  });
});

describe("dayanıklılık ve gizlilik", () => {
  it("bir postun maili patlasa da diğerleri işlenir", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { post: a } = await createPendingPostWithLink(agency.id, client.id);
    const { post: b } = await createPendingPostWithLink(agency.id, client.id);
    await yaslandir(a.id, 5);
    await yaslandir(b.id, 5);

    let cagri = 0;
    mockReminder.mockImplementation(async () => {
      cagri += 1;
      if (cagri === 1) throw new Error("beklenmedik");
      return { sent: true };
    });

    const res = await GET(cronRequest());
    expect(await res.json()).toMatchObject({ reminded: 1, failed: 1 });
  });

  it("yanıt yalnızca sayı taşır — müşteri adı/e-posta/caption sızmaz", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { post } = await createPendingPostWithLink(agency.id, client.id);
    await yaslandir(post.id, 5);

    const raw = await (await GET(cronRequest())).text();
    expect(raw).not.toContain(client.email);
    expect(raw).not.toContain(client.name);
    expect(raw).not.toContain("Test caption");
  });
});

describe("video kuyruğu (V4)", () => {
  it("portal postu tek tek hatırlatılmaz; günlük kuyruk özeti gider", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    await createPublishSettings(client.id, { requireApproval: true });
    const post = await createQueuePost(agency.id, client.id, { status: "pending" });
    // Linki ölmüş ve günlerdir bekleyen bir ajans postu olsaydı iki bildirim
    // birden giderdi; portal postunda ikisi de gitmemeli.
    await db.approvalLink.create({
      data: { postId: post.id, token: "portal-token-1", expiresAt: gunOnce(1) },
    });
    await yaslandir(post.id, 10);

    const body = await (await GET(cronRequest())).json();

    expect(body).toMatchObject({ checked: 0, reminded: 0, expiryNoticed: 0 });
    expect(body.queueDigest).toMatchObject({ sent: 1 });
    expect(mockReminder).not.toHaveBeenCalled();
    expect(mockAgencyNotice).not.toHaveBeenCalled();
    expect(vi.mocked(sendRawEmail).mock.calls[0][0].subject).toBe("1 video onayını bekliyor");
  });
});

describe("V11: slot uyandırmaları ve Neon kotası", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetQstashMock();
    vi.stubEnv("QSTASH_TOKEN", "test-token");
    vi.stubEnv("APP_URL", "https://cas.test");
    vi.stubEnv("NEON_API_KEY", "napi_test");
    vi.stubEnv("NEON_PROJECT_ID", "proj-1");
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ project: { compute_time_seconds: 10 * 3600 } }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    // `vi.restoreAllMocks` YOK — bkz. dosyanın son testi.
  });

  async function seedQueueClient() {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    await createPublishSettings(client.id, { slots: ["09:00", "20:00"] });
    return { agency, client };
  }

  it("önümüzdeki günlerin uyandırmalarını kurar ve sayıları döner", async () => {
    await seedQueueClient();

    const body = await (await GET(cronRequest())).json();

    expect(body.queueWakes).toMatchObject({ failed: 0 });
    expect(body.queueWakes.armed).toBeGreaterThanOrEqual(11);
    expect(await db.queueWake.count()).toBe(body.queueWakes.armed);
    expect(body.neonUsage).toMatchObject({ ok: true, alerted: false });
  });

  it("senkron patlasa da diğer adımlar koşar ve cron 200 döner", async () => {
    const { agency, client } = await seedQueueClient();
    const { post } = await createPendingPostWithLink(agency.id, client.id);
    await yaslandir(post.id, REMINDER_AFTER_DAYS);
    qstashMock.failPublishAfter = 0;
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await GET(cronRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, reminded: 1 });
    expect(body.queueWakes.failed).toBeGreaterThan(0);
  });

  it("Neon API patlasa da cron sürer", async () => {
    fetchMock.mockRejectedValue(new Error("ağ yok"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await GET(cronRequest());

    expect(res.status).toBe(200);
    expect((await res.json()).neonUsage).toMatchObject({ ok: false });
  });

  // DOSYANIN SON TESTİ olmalı: Prisma delegesindeki spy güvenle geri
  // alınamıyor (delegeler proxy; geri alınca metot kayboluyor, bırakılınca
  // sonraki testlerin `clearAllMocks`ı onu boş döndürüyor).
  it("Neon kontrolü DB'den ÖNCE koşar — DB kapalıyken de kullanım okunur", async () => {
    const findMany = vi
      .spyOn(db.post, "findMany")
      .mockRejectedValueOnce(new Error("Can't reach database server at `x:5432`"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await GET(cronRequest());

    expect(res.status).toBe(500);
    const neonCall = fetchMock.mock.calls.findIndex(([url]) => String(url).includes("console.neon.tech"));
    expect(neonCall).toBeGreaterThanOrEqual(0);
    expect(fetchMock.mock.invocationCallOrder[neonCall]).toBeLessThan(findMany.mock.invocationCallOrder[0]);
  });
});
