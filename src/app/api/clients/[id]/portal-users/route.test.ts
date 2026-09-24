import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));
vi.mock("@/lib/email-portal", () => ({
  sendPortalLoginEmail: vi.fn(async () => ({ sent: true })),
}));

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { resetRateLimiter } from "@/lib/rate-limit";
import { sendPortalLoginEmail } from "@/lib/email-portal";
import { hashLoginToken } from "@/lib/client-auth";
import { createAgency, createClient, resetDb } from "@tests/helpers/db";
import { createClientUser, portalCookie, portalRequest } from "@tests/helpers/portal";
import { GET, POST } from "./route";
import { DELETE } from "./[userId]/route";
import { GET as listVideos } from "@/app/api/portal/videos/route";

const mockAuth = vi.mocked(auth);
const mockSend = vi.mocked(sendPortalLoginEmail);

function session(agencyId: string, role: "owner" | "member" = "member") {
  return { agencyId, agencyRole: role, user: { email: "ajans@ornek.com" } } as never;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const delParams = (id: string, userId: string) => ({ params: Promise.resolve({ id, userId }) });

const postReq = (email: unknown, origin?: string) =>
  portalRequest("/api/clients/x/portal-users", { method: "POST", body: { email }, origin });

beforeEach(async () => {
  await resetDb();
  resetRateLimiter();
  mockAuth.mockReset();
  mockSend.mockClear();
});

describe("POST /api/clients/[id]/portal-users", () => {
  it("oturumsuz 401", async () => {
    mockAuth.mockResolvedValue(null as never);
    expect((await POST(postReq("a@ornek.com"), params("x"))).status).toBe(401);
  });

  it("member da erişim açabilir; kullanıcı küçük harfle yazılır, davet maili gider", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue(session(agency.id, "member"));

    const res = await POST(postReq("Furkan@Ornek.com"), params(client.id));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ user: { email: "furkan@ornek.com" }, emailSent: true });

    const call = mockSend.mock.calls[0][0];
    expect(call).toMatchObject({ to: "furkan@ornek.com", invited: true });
    const token = new URL(call.loginUrl).searchParams.get("token") as string;
    // Linkteki token DB'de yalnızca hash olarak var.
    const row = await db.clientLoginToken.findFirstOrThrow();
    expect(row.tokenHash).toBe(hashLoginToken(token));
  });

  it("IDOR: başka ajansın müşterisine erişim açılamaz (404)", async () => {
    const agencyA = await createAgency();
    const agencyB = await createAgency();
    const clientB = await createClient(agencyB.id);
    mockAuth.mockResolvedValue(session(agencyA.id));

    expect((await POST(postReq("x@ornek.com"), params(clientB.id))).status).toBe(404);
    expect(await db.clientUser.count()).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("e-posta başka yerde kayıtlıysa 409", async () => {
    const agency = await createAgency();
    const c1 = await createClient(agency.id);
    const c2 = await createClient(agency.id);
    await createClientUser(c1.id, "ortak@ornek.com");
    mockAuth.mockResolvedValue(session(agency.id));
    const res = await POST(postReq("ortak@ornek.com"), params(c2.id));
    expect(res.status).toBe(409);
  });

  it("geçersiz e-posta 400, yabancı Origin 403", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue(session(agency.id));
    expect((await POST(postReq("olmaz"), params(client.id))).status).toBe(400);
    expect((await POST(postReq("a@ornek.com", "https://kotu.example"), params(client.id))).status).toBe(403);
  });

  it("ajans başına hız sınırı 429", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue(session(agency.id));
    for (let i = 0; i < 10; i++) await POST(postReq(`k${i}@ornek.com`), params(client.id));
    expect((await POST(postReq("son@ornek.com"), params(client.id))).status).toBe(429);
  });
});

describe("GET /api/clients/[id]/portal-users", () => {
  it("yalnızca kendi müşterisinin kullanıcıları; başka ajansın müşterisi 404", async () => {
    const agencyA = await createAgency();
    const agencyB = await createAgency();
    const clientA = await createClient(agencyA.id);
    const clientB = await createClient(agencyB.id);
    await createClientUser(clientA.id, "a@ornek.com");
    await createClientUser(clientB.id, "b@ornek.com");
    mockAuth.mockResolvedValue(session(agencyA.id));

    const res = await GET(portalRequest("/x"), params(clientA.id));
    expect((await res.json()).users.map((u: { email: string }) => u.email)).toEqual(["a@ornek.com"]);
    expect((await GET(portalRequest("/x"), params(clientB.id))).status).toBe(404);
  });
});

describe("DELETE /api/clients/[id]/portal-users/[userId]", () => {
  it("erişimi kaldırır; token'lar silinir, açık portal oturumu düşer", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const user = await createClientUser(client.id);
    await db.clientLoginToken.create({
      data: { clientUserId: user.id, tokenHash: "h", expiresAt: new Date(Date.now() + 60_000) },
    });
    const cookie = portalCookie(user);
    mockAuth.mockResolvedValue(session(agency.id));

    const res = await DELETE(portalRequest("/x", { method: "DELETE" }), delParams(client.id, user.id));
    expect(res.status).toBe(200);
    expect(await db.clientUser.count()).toBe(0);
    expect(await db.clientLoginToken.count()).toBe(0);
    expect((await listVideos(portalRequest("/api/portal/videos", { cookie }))).status).toBe(401);
  });

  it("IDOR: başka ajansın kullanıcısı silinemez — kendi müşteri id'siyle bile", async () => {
    const agencyA = await createAgency();
    const agencyB = await createAgency();
    const clientA = await createClient(agencyA.id);
    const clientB = await createClient(agencyB.id);
    const userB = await createClientUser(clientB.id);
    mockAuth.mockResolvedValue(session(agencyA.id));

    expect(
      (await DELETE(portalRequest("/x", { method: "DELETE" }), delParams(clientA.id, userB.id))).status
    ).toBe(404);
    expect(
      (await DELETE(portalRequest("/x", { method: "DELETE" }), delParams(clientB.id, userB.id))).status
    ).toBe(404);
    expect(await db.clientUser.count()).toBe(1);
  });

  it("yabancı Origin 403", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const user = await createClientUser(client.id);
    mockAuth.mockResolvedValue(session(agency.id));
    const res = await DELETE(
      portalRequest("/x", { method: "DELETE", origin: "https://kotu.example" }),
      delParams(client.id, user.id)
    );
    expect(res.status).toBe(403);
  });
});
