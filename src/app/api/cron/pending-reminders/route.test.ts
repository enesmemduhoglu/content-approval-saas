import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendApprovalReminderEmail: vi.fn(),
  sendAgencyNoticeEmail: vi.fn(),
}));

import { GET } from "./route";
import { db } from "@/lib/db";
import { sendAgencyNoticeEmail, sendApprovalReminderEmail } from "@/lib/email";
import { REMINDER_AFTER_DAYS } from "@/lib/reminders";
import {
  createAgency,
  createClient,
  createPendingPostWithLink,
  resetDb,
} from "@tests/helpers/db";

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
      to: agency.email,
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
