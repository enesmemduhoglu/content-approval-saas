import { beforeEach, describe, expect, it, vi } from "vitest";

// Toplu onay hiçbir şey yayınlamamalı; gerçek istek atılmadığını da garanti eder.
vi.mock("@/lib/instagram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/instagram")>();
  return { ...actual, publishToInstagram: vi.fn() };
});

import { POST } from "./route";
import { db } from "@/lib/db";
import { publishToInstagram } from "@/lib/instagram";
import { resetRateLimiter } from "@/lib/rate-limit";
import {
  createAgency,
  createClient,
  createInstagramClient,
  createPendingPostWithLink,
  resetDb,
} from "@tests/helpers/db";

const mockPublish = vi.mocked(publishToInstagram);

function makeParams(token: string) {
  return { params: Promise.resolve({ token }) };
}

function batchRequest(ip = "1.2.3.4") {
  return new Request("http://localhost/api/approve/x/batch", {
    method: "POST",
    headers: { "x-forwarded-for": ip },
  });
}

beforeEach(async () => {
  await resetDb();
  resetRateLimiter();
  mockPublish.mockReset();
});

describe("POST /api/approve/[token]/batch", () => {
  it("aynı müşterinin tüm bekleyen postlarını onaylar, her biri için audit yazar", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const a = await createPendingPostWithLink(agency.id, client.id);
    const b = await createPendingPostWithLink(agency.id, client.id);
    const c = await createPendingPostWithLink(agency.id, client.id);

    const res = await POST(batchRequest("5.5.5.5"), makeParams(a.link.token));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.approved).toBe(3);
    expect(data.skippedPublishTargets).toBe(0);

    for (const { post } of [a, b, c]) {
      const updated = await db.post.findUnique({ where: { id: post.id } });
      expect(updated?.status).toBe("approved");
    }
    const audits = await db.approvalAudit.findMany();
    expect(audits).toHaveLength(3);
    expect(audits.every((audit) => audit.ip === "5.5.5.5")).toBe(true);
  });

  it("BAŞKA müşterinin bekleyen postlarına dokunmaz", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const otherClient = await createClient(agency.id);
    const mine = await createPendingPostWithLink(agency.id, client.id);
    const theirs = await createPendingPostWithLink(agency.id, otherClient.id);

    const res = await POST(batchRequest(), makeParams(mine.link.token));
    expect((await res.json()).approved).toBe(1);

    const untouched = await db.post.findUnique({ where: { id: theirs.post.id } });
    expect(untouched?.status).toBe("pending");
  });

  it("süresi dolmuş linkli veya zaten karar verilmiş postları atlar", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const active = await createPendingPostWithLink(agency.id, client.id);
    const expired = await createPendingPostWithLink(agency.id, client.id, {
      expiresAt: new Date(Date.now() - 1000),
    });
    const decided = await createPendingPostWithLink(agency.id, client.id, {
      status: "rejected",
    });

    const res = await POST(batchRequest(), makeParams(active.link.token));
    expect((await res.json()).approved).toBe(1);

    expect(
      (await db.post.findUnique({ where: { id: expired.post.id } }))?.status
    ).toBe("pending");
    expect(
      (await db.post.findUnique({ where: { id: decided.post.id } }))?.status
    ).toBe("rejected");
  });

  it("geçersiz token 404, süresi dolmuş token 410 döner", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const expired = await createPendingPostWithLink(agency.id, client.id, {
      expiresAt: new Date(Date.now() - 1000),
    });

    expect((await POST(batchRequest(), makeParams("yok"))).status).toBe(404);
    expect((await POST(batchRequest(), makeParams(expired.link.token))).status).toBe(410);
  });

  it("bekleyen post kalmadıysa 409 döner", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { link } = await createPendingPostWithLink(agency.id, client.id);

    await POST(batchRequest(), makeParams(link.token));
    const second = await POST(batchRequest(), makeParams(link.token));
    expect(second.status).toBe(409);
  });
});

describe("POST /api/approve/[token]/batch — yayın hedefli postlar", () => {
  it("Instagram bağlı müşteride toplu onay REDDEDİLİR, postlar bekliyor kalır", async () => {
    // Sessiz hata senaryosunun kökü: batch yayın yapmıyordu, postlar onaylanıp
    // Instagram'a hiç düşmüyordu. Artık hiç onaylanmıyorlar.
    const agency = await createAgency();
    const client = await createInstagramClient(agency.id);
    const a = await createPendingPostWithLink(agency.id, client.id);
    const b = await createPendingPostWithLink(agency.id, client.id);

    const res = await POST(batchRequest(), makeParams(a.link.token));
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.approved).toBe(0);
    expect(data.skippedPublishTargets).toBe(2);
    expect(data.error).toContain("tek tek");

    for (const { post } of [a, b]) {
      const untouched = await db.post.findUnique({ where: { id: post.id } });
      expect(untouched?.status).toBe("pending");
      expect(untouched?.publishStatus).toBe("idle");
    }
    expect(await db.approvalAudit.count()).toBe(0);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("kimlik bilgisi YARIM (token yok) müşteri yayın hedefi sayılmaz, toplu onay çalışır", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id, {
      instagramUserId: "17841400000000000",
    });
    const { post, link } = await createPendingPostWithLink(agency.id, client.id);

    const res = await POST(batchRequest(), makeParams(link.token));
    expect(res.status).toBe(200);
    expect((await res.json()).approved).toBe(1);
    expect((await db.post.findUnique({ where: { id: post.id } }))?.status).toBe(
      "approved"
    );
  });
});
