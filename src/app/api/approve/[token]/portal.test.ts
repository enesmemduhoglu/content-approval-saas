import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Video kuyruğu (V4): onay linkinden gelen karar portal postunu YAYINLAMAZ.
// Ajans postunun davranışı `route.test.ts`te, değişmeden sınanıyor.
vi.mock("@/lib/instagram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/instagram")>();
  return {
    ...actual,
    publishToInstagram: vi.fn(),
    createReelContainer: vi.fn(),
    finalizeContainer: vi.fn(),
  };
});
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendRawEmail: vi.fn(), sendAgencyNoticeEmail: vi.fn() };
});

import { POST } from "./route";
import { db } from "@/lib/db";
import { sendAgencyNoticeEmail } from "@/lib/email";
import { createReelContainer, publishToInstagram } from "@/lib/instagram";
import { resetRateLimiter } from "@/lib/rate-limit";
import { approvalLinkExpiry } from "@/lib/tokens";
import { createAgency, createInstagramClient, resetDb } from "@tests/helpers/db";
import { createQueuePost } from "@tests/helpers/queue";

const mockCreateReel = vi.mocked(createReelContainer);
const mockPublish = vi.mocked(publishToInstagram);

beforeEach(async () => {
  await resetDb();
  resetRateLimiter();
  vi.clearAllMocks();
  vi.mocked(sendAgencyNoticeEmail).mockResolvedValue({ sent: true });
});

function approveRequest(action = "approve") {
  return new Request("http://localhost/api/approve/x", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "5.6.7.8" },
    body: JSON.stringify({ action }),
  });
}

async function seedPortalPostWithLink(overrides: Parameters<typeof createQueuePost>[2] = {}) {
  const agency = await createAgency();
  const client = await createInstagramClient(agency.id);
  const post = await createQueuePost(agency.id, client.id, { status: "pending", ...overrides });
  const token = randomUUID().replace(/-/g, "");
  await db.approvalLink.create({
    data: { postId: post.id, token, expiresAt: approvalLinkExpiry() },
  });
  return { post, token };
}

const params = (token: string) => ({ params: Promise.resolve({ token }) });

describe("POST /api/approve/[token] — portal postu", () => {
  it("onay kaydedilir ama yayın TETİKLENMEZ; post kuyrukta idle kalır", async () => {
    const { post, token } = await seedPortalPostWithLink();

    const res = await POST(approveRequest(), params(token));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "approved",
      publishStatus: "idle",
      queued: true,
    });

    expect(mockCreateReel).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    const saved = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(saved.status).toBe("approved");
    expect(saved.publishStatus).toBe("idle");
    expect(saved.queuePosition).toBe(post.queuePosition);
    // Karar yine de müşterinin kararı olarak audit'e düşer.
    expect(await db.approvalAudit.count({ where: { postId: post.id, action: "approved" } })).toBe(
      1
    );
  });

  it("publishAt dolu olsa bile 'scheduled' yapılmaz — zamanlamayı slot belirler", async () => {
    const { post, token } = await seedPortalPostWithLink();
    await db.post.update({
      where: { id: post.id },
      data: { publishAt: new Date(Date.now() + 86_400_000) },
    });

    await POST(approveRequest(), params(token));

    const saved = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(saved.publishStatus).toBe("idle");
  });

  it("onaylı + failed portal postunda 'tekrar dene' yayın tetiklemez", async () => {
    const { post, token } = await seedPortalPostWithLink({
      status: "approved",
      publishStatus: "failed",
    });

    const res = await POST(approveRequest(), params(token));
    expect(await res.json()).toMatchObject({ status: "approved", publishStatus: "failed" });

    expect(mockCreateReel).not.toHaveBeenCalled();
    expect((await db.post.findUniqueOrThrow({ where: { id: post.id } })).publishStatus).toBe(
      "failed"
    );
  });

  it("red aynen çalışır (ajansa bildirim dahil)", async () => {
    const { post, token } = await seedPortalPostWithLink();

    const res = await POST(approveRequest("reject"), params(token));
    expect(await res.json()).toMatchObject({ status: "rejected" });
    expect((await db.post.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("rejected");
    expect(sendAgencyNoticeEmail).toHaveBeenCalledTimes(1);
  });
});
