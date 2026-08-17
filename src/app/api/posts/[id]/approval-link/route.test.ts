import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendApprovalRequestEmail: vi.fn(),
}));

import { POST } from "./route";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { sendApprovalRequestEmail } from "@/lib/email";
import {
  createAgency,
  createClient,
  createPendingPostWithLink,
  resetDb,
} from "@tests/helpers/db";

const mockAuth = vi.mocked(auth);
const mockSendEmail = vi.mocked(sendApprovalRequestEmail);

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function request(body?: unknown) {
  return new Request("http://localhost/api/posts/x/approval-link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Süresi dolmuş link için geçmişte bir tarih. */
const GECMIS = new Date(Date.now() - 24 * 60 * 60 * 1000);

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  mockSendEmail.mockReset();
  mockSendEmail.mockResolvedValue({ sent: true });
});

describe("POST /api/posts/[id]/approval-link", () => {
  it("oturum yoksa 401 döner", async () => {
    mockAuth.mockResolvedValue(null as never);
    const res = await POST(request({}), params("herhangi"));
    expect(res.status).toBe(401);
  });

  it("süresi dolmuş linki renew istenmese bile yeniler (F1)", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { post, link } = await createPendingPostWithLink(agency.id, client.id, {
      expiresAt: GECMIS,
    });
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await POST(request({}), params(post.id));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.renewed).toBe(true);

    const fresh = await db.approvalLink.findUnique({ where: { postId: post.id } });
    expect(fresh?.token).not.toBe(link.token);
    expect(fresh!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(data.approvalUrl).toContain(fresh!.token);
  });

  it("geçerli linki varsayılan olarak KORUR, yalnızca maili tekrar gönderir", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { post, link } = await createPendingPostWithLink(agency.id, client.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await POST(request({}), params(post.id));
    const data = await res.json();
    expect(data.renewed).toBe(false);
    expect(data.emailSent).toBe(true);

    const unchanged = await db.approvalLink.findUnique({ where: { postId: post.id } });
    expect(unchanged?.token).toBe(link.token);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it("renew:true geçerli linki de değiştirir (sızan link iptali)", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { post, link } = await createPendingPostWithLink(agency.id, client.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await POST(request({ renew: true }), params(post.id));
    expect((await res.json()).renewed).toBe(true);

    const fresh = await db.approvalLink.findUnique({ where: { postId: post.id } });
    expect(fresh?.token).not.toBe(link.token);
  });

  it("mail sonucunu posta YAZAR (F5)", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { post } = await createPendingPostWithLink(agency.id, client.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);
    mockSendEmail.mockResolvedValue({ sent: false, reason: "resend reddetti" });

    const res = await POST(request({}), params(post.id));
    const data = await res.json();
    expect(data.emailSent).toBe(false);
    expect(data.emailError).toBe("resend reddetti");

    const saved = await db.post.findUnique({ where: { id: post.id } });
    expect(saved?.approvalEmailSent).toBe(false);
    expect(saved?.approvalEmailError).toBe("resend reddetti");
    expect(saved?.approvalEmailSentAt).not.toBeNull();
  });

  it("karar verilmiş postta linki yeniler ama mail GÖNDERMEZ", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { post, link } = await createPendingPostWithLink(agency.id, client.id, {
      status: "approved",
      expiresAt: GECMIS,
    });
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await POST(request({}), params(post.id));
    const data = await res.json();
    expect(data.renewed).toBe(true);
    expect(data.emailSent).toBe(false);
    expect(data.emailSkipped).toBeTruthy();
    expect(mockSendEmail).not.toHaveBeenCalled();

    const fresh = await db.approvalLink.findUnique({ where: { postId: post.id } });
    expect(fresh?.token).not.toBe(link.token);
  });

  it("başka ajansın postuna link üretmez (404)", async () => {
    const agencyA = await createAgency();
    const agencyB = await createAgency();
    const client = await createClient(agencyA.id);
    const { post, link } = await createPendingPostWithLink(agencyA.id, client.id);
    mockAuth.mockResolvedValue({ agencyId: agencyB.id } as never);

    const res = await POST(request({ renew: true }), params(post.id));
    expect(res.status).toBe(404);
    expect(mockSendEmail).not.toHaveBeenCalled();

    const unchanged = await db.approvalLink.findUnique({ where: { postId: post.id } });
    expect(unchanged?.token).toBe(link.token);
  });

  it("eski token yenilemeden sonra artık çalışmaz", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { post, link } = await createPendingPostWithLink(agency.id, client.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    await POST(request({ renew: true }), params(post.id));

    expect(await db.approvalLink.findUnique({ where: { token: link.token } })).toBeNull();
  });
});
