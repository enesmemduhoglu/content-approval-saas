import { beforeEach, describe, expect, it } from "vitest";
import { POST } from "./route";
import { db } from "@/lib/db";
import { resetRateLimiter } from "@/lib/rate-limit";
import {
  createAgency,
  createClient,
  createPendingPostWithLink,
  resetDb,
} from "@tests/helpers/db";

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
