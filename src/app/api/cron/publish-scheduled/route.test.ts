import { beforeEach, describe, expect, it, vi } from "vitest";

// Instagram'a gerçek istek atılmaz — yayın çekirdeği mock'lanır, kararı
// veren `publish-post.ts` gerçek kalır (publishApprovedPost hiç mock'lanmaz).
vi.mock("@/lib/instagram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/instagram")>();
  return { ...actual, publishToInstagram: vi.fn(), checkMediaLiveness: vi.fn() };
});

// Ajans bildirimi gercek Resend'e gitmesin; cagrilip cagrilmadigi sinaniyor.
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendAgencyNoticeEmail: vi.fn().mockResolvedValue({ sent: true }) };
});

import { GET } from "./route";
import { db } from "@/lib/db";
import { publishToInstagram } from "@/lib/instagram";
import { sendAgencyNoticeEmail } from "@/lib/email";
import {
  createAgency,
  createInstagramClient,
  createPendingPostWithLink,
  resetDb,
} from "@tests/helpers/db";

const mockPublish = vi.mocked(publishToInstagram);
const mockNotify = vi.mocked(sendAgencyNoticeEmail);

const CRON_SECRET = "d".repeat(40);

const cronRequest = (secret = CRON_SECRET) =>
  new Request("http://localhost/api/cron/publish-scheduled", {
    headers: { authorization: `Bearer ${secret}` },
  });

/** Zamanı gelmiş, onaylanmış, yayını crona bırakılmış bir post. */
async function seedDuePost(overrides: { publishAt?: Date } = {}) {
  const agency = await createAgency();
  const client = await createInstagramClient(agency.id);
  const { post } = await createPendingPostWithLink(agency.id, client.id, {
    status: "approved",
    publishAt: overrides.publishAt ?? new Date(Date.now() - 60_000),
  });
  await db.post.update({ where: { id: post.id }, data: { publishStatus: "scheduled" } });
  return { agency, client, post };
}

beforeEach(async () => {
  await resetDb();
  vi.restoreAllMocks();
  mockPublish.mockReset();
  mockNotify.mockClear();
  mockNotify.mockResolvedValue({ sent: true });
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  mockPublish.mockResolvedValue({
    mediaId: "media-cron",
    permalink: "https://instagram.com/p/CRON/",
  });
});

describe("yetkilendirme", () => {
  it("sırsız istek 401 alır", async () => {
    expect(
      (await GET(new Request("http://localhost/api/cron/publish-scheduled"))).status
    ).toBe(401);
  });

  it("yanlış sır 401 alır", async () => {
    expect((await GET(cronRequest("x".repeat(40)))).status).toBe(401);
  });

  it("CRON_SECRET tanımlı değilse endpoint TAMAMEN kapalıdır", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await GET(cronRequest())).status).toBe(401);
  });
});

describe("zamanlanmış yayın", () => {
  it("zamanı gelmiş 'scheduled' postu yayınlar", async () => {
    const { post } = await seedDuePost();

    const res = await GET(cronRequest());
    expect(await res.json()).toMatchObject({ checked: 1, published: 1, failed: 0 });
    expect(mockPublish).toHaveBeenCalledTimes(1);

    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.publishStatus).toBe("published");
    expect(updated?.igMediaId).toBe("media-cron");
  });

  it("zamanı henüz GELMEMİŞ postu atlar — dokunmaz", async () => {
    await seedDuePost({ publishAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });

    const res = await GET(cronRequest());
    expect(await res.json()).toMatchObject({ checked: 0, published: 0 });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("onaylanmamış (hâlâ pending) postlara dokunmaz", async () => {
    const agency = await createAgency();
    const client = await createInstagramClient(agency.id);
    const { post } = await createPendingPostWithLink(agency.id, client.id, {
      publishAt: new Date(Date.now() - 60_000),
    });
    // status hâlâ "pending" — approve route'u hiç çağrılmadı, "scheduled"a hiç geçmedi.

    const res = await GET(cronRequest());
    expect(await res.json()).toMatchObject({ checked: 0 });
    expect(mockPublish).not.toHaveBeenCalled();

    const unchanged = await db.post.findUnique({ where: { id: post.id } });
    expect(unchanged?.publishStatus).toBe("idle");
  });

  it("birden fazla zamanı gelmiş postu sırayla yayınlar", async () => {
    const a = await seedDuePost();
    const b = await seedDuePost();

    const res = await GET(cronRequest());
    expect(await res.json()).toMatchObject({ checked: 2, published: 2 });

    const updatedA = await db.post.findUnique({ where: { id: a.post.id } });
    const updatedB = await db.post.findUnique({ where: { id: b.post.id } });
    expect(updatedA?.publishStatus).toBe("published");
    expect(updatedB?.publishStatus).toBe("published");
  });

  it("koşu başına sınır çalışır — RUN_LIMIT'i aşan postlar bu koşuda denenmez", async () => {
    // RUN_LIMIT = 5 (bkz. route.ts) — 6 due post oluşturup 6.'nın
    // dokunulmadığını doğruluyoruz. Tam sayıyı burada tekrar etmek yerine
    // "en az bir post ertelendi" ölçülüyor ki sabit route.ts sınırı değişirse
    // test kırılgan olmasın.
    const posts = await Promise.all(Array.from({ length: 6 }, () => seedDuePost()));

    const res = await GET(cronRequest());
    const data = await res.json();
    expect(data.checked).toBeLessThan(6);
    expect(mockPublish.mock.calls.length).toBeLessThan(6);

    const stillScheduled = await db.post.findMany({
      where: { id: { in: posts.map((p) => p.post.id) }, publishStatus: "scheduled" },
    });
    // En az biri bu koşuda hiç denenmemiş olmalı — sınır gerçekten kesiyor.
    expect(stillScheduled.length).toBeGreaterThan(0);
  });

  it("bir postun yayını patlasa da diğerleri işlenir", async () => {
    const a = await seedDuePost();
    const b = await seedDuePost();

    let calls = 0;
    mockPublish.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error("beklenmedik Instagram hatası");
      return { mediaId: "media-2", permalink: "https://instagram.com/p/B/" };
    });

    const res = await GET(cronRequest());
    const data = await res.json();
    expect(data.checked).toBe(2);
    expect(data.published + data.failed).toBe(2);
    expect(data.failed).toBeGreaterThanOrEqual(1);

    // Hangisi başarısız olduysa "failed" durumunda kaldı, diğeri yayınlandı —
    // ikisi de "scheduled" kilidinde takılı kalmadı.
    const updatedA = await db.post.findUnique({ where: { id: a.post.id } });
    const updatedB = await db.post.findUnique({ where: { id: b.post.id } });
    expect([updatedA?.publishStatus, updatedB?.publishStatus]).toContain("published");
  });

  it("yanıt yalnızca sayı taşır — caption/müşteri bilgisi sızmaz", async () => {
    const { post, client } = await seedDuePost();
    const raw = await (await GET(cronRequest())).text();
    expect(raw).not.toContain(client.email);
    expect(raw).not.toContain(post.caption);
  });
});

// Zamanlanmis yolun asil riski: yayin saatler sonra, kimse bakmazken oluyor.
// Ajansa sonuc bildirilmezse "onaylandi, su saatte yayinlanacak" mailinden
// sonra hicbir haber gelmez ve yayinin patladigi hic ogrenilmez.
describe("ajans bildirimi", () => {
  it("basarili yayindan sonra ajansa sonuc bildirilir", async () => {
    await seedDuePost();

    await GET(cronRequest());

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const arg = mockNotify.mock.calls[0][0];
    expect(arg.event).toBe("approved");
    expect(arg.publishStatus).toBe("published");
    expect(arg.igPermalink).toBe("https://instagram.com/p/CRON/");
  });

  it("yayin patlasa da ajansa bildirilir — sessiz kalinmaz", async () => {
    await seedDuePost();
    mockPublish.mockRejectedValue(new Error("instagram patladi"));

    await GET(cronRequest());

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][0].publishStatus).toBe("failed");
  });

  it("bildirim gonderimi patlasa bile cron basarili doner — yayin geri alinmaz", async () => {
    await seedDuePost();
    mockNotify.mockRejectedValue(new Error("resend down"));

    const res = await GET(cronRequest());

    expect(res.status).toBe(200);
    expect((await res.json()).published).toBe(1);
  });
});
