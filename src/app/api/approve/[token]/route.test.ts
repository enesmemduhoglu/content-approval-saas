import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";
import { db } from "@/lib/db";
import { resetRateLimiter, RATE_LIMIT_MAX } from "@/lib/rate-limit";
import {
  createAgency,
  createClient,
  createPendingPostWithLink,
  resetDb,
} from "@tests/helpers/db";

function makeParams(token: string) {
  return { params: Promise.resolve({ token }) };
}

function getRequest(ip = "1.2.3.4") {
  return new Request("http://localhost/api/approve/x", {
    headers: { "x-forwarded-for": ip },
  });
}

function postRequest(body: unknown, ip = "1.2.3.4") {
  return new Request("http://localhost/api/approve/x", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

async function seedPendingPost(overrides: Parameters<typeof createPendingPostWithLink>[2] = {}) {
  const agency = await createAgency({ name: "Parlak Ajans" });
  const client = await createClient(agency.id);
  return createPendingPostWithLink(agency.id, client.id, overrides);
}

beforeEach(async () => {
  await resetDb();
  resetRateLimiter();
  vi.restoreAllMocks();
});

describe("GET /api/approve/[token]", () => {
  it("geçerli token için post detayını döner", async () => {
    const { link } = await seedPendingPost();
    const res = await GET(getRequest(), makeParams(link.token));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.post.caption).toBe("Test caption");
    expect(data.post.agencyName).toBe("Parlak Ajans");
    expect(data.post.status).toBe("pending");
  });

  it("geçersiz token 404 döner", async () => {
    const res = await GET(getRequest(), makeParams("yok-boyle-bir-token"));
    expect(res.status).toBe(404);
  });

  it("süresi dolmuş token 410 döner", async () => {
    const { link } = await seedPendingPost({
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await GET(getRequest(), makeParams(link.token));
    expect(res.status).toBe(410);
  });
});

describe("POST /api/approve/[token]", () => {
  it("approve: durumu günceller, audit kaydını IP ile yazar", async () => {
    const { post, link } = await seedPendingPost();
    const res = await POST(
      postRequest({ action: "approve" }, "9.8.7.6"),
      makeParams(link.token)
    );
    expect(res.status).toBe(200);

    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.status).toBe("approved");

    const audits = await db.approvalAudit.findMany({ where: { postId: post.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("approved");
    expect(audits[0].ip).toBe("9.8.7.6");
  });

  it("x-forwarded-for yoksa audit IP'si 'unknown' yazılır (TENSION 4)", async () => {
    const { post, link } = await seedPendingPost();
    const res = await POST(
      new Request("http://localhost/api/approve/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      }),
      makeParams(link.token)
    );
    expect(res.status).toBe(200);
    const audit = await db.approvalAudit.findFirst({ where: { postId: post.id } });
    expect(audit?.ip).toBe("unknown");
  });

  it("reject: reddetme sebebini kaydeder", async () => {
    const { post, link } = await seedPendingPost();
    const res = await POST(
      postRequest({ action: "reject", rejectionReason: "Logo eski sürüm" }),
      makeParams(link.token)
    );
    expect(res.status).toBe(200);

    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.status).toBe("rejected");
    expect(updated?.rejectionReason).toBe("Logo eski sürüm");
  });

  it("geçersiz token 404 döner", async () => {
    const res = await POST(postRequest({ action: "approve" }), makeParams("yok"));
    expect(res.status).toBe(404);
  });

  it("süresi dolmuş token 410 döner, karar kabul etmez", async () => {
    const { post, link } = await seedPendingPost({
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await POST(postRequest({ action: "approve" }), makeParams(link.token));
    expect(res.status).toBe(410);
    const unchanged = await db.post.findUnique({ where: { id: post.id } });
    expect(unchanged?.status).toBe("pending");
  });

  it("zaten karar verilmiş post 409 döner, mevcut durumu bildirir", async () => {
    const { link } = await seedPendingPost({ status: "approved" });
    const res = await POST(postRequest({ action: "reject" }), makeParams(link.token));
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.status).toBe("approved");
  });

  it("geçersiz action 400 döner", async () => {
    const { link } = await seedPendingPost();
    const res = await POST(postRequest({ action: "belki" }), makeParams(link.token));
    expect(res.status).toBe(400);
  });

  it("yarış: aynı anda iki karar — yalnızca biri kazanır, tek audit kaydı (WHERE status='pending' guard)", async () => {
    const { post, link } = await seedPendingPost();
    const [res1, res2] = await Promise.all([
      POST(postRequest({ action: "approve" }, "1.1.1.1"), makeParams(link.token)),
      POST(postRequest({ action: "reject" }, "2.2.2.2"), makeParams(link.token)),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const audits = await db.approvalAudit.findMany({ where: { postId: post.id } });
    expect(audits).toHaveLength(1);
  });

  it(`rate limit: aynı IP'den ${RATE_LIMIT_MAX + 1}. istek 429 döner`, async () => {
    const { link } = await seedPendingPost();
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      const res = await GET(getRequest("7.7.7.7"), makeParams(link.token));
      expect(res.status).toBe(200);
    }
    const blocked = await POST(
      postRequest({ action: "approve" }, "7.7.7.7"),
      makeParams(link.token)
    );
    expect(blocked.status).toBe(429);
  });
});
