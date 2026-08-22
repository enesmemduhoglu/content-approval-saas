import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

import { DELETE } from "./route";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { generateInviteToken, inviteExpiry } from "@/lib/tokens";
import { createAgency, resetDb } from "@tests/helpers/db";

const mockAuth = vi.mocked(auth);

function deleteRequest(init: { origin?: string } = {}) {
  const headers: Record<string, string> = { host: "localhost" };
  if (init.origin) headers.origin = init.origin;
  return new Request("http://localhost/api/agency/invites/x", {
    method: "DELETE",
    headers,
  });
}

function session(agencyId: string, role: "owner" | "member") {
  return { agencyId, agencyRole: role, user: { email: "ben@ornek.com" } } as never;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function createInvite(agencyId: string, acceptedAt: Date | null = null) {
  return db.agencyInvite.create({
    data: {
      agencyId,
      email: `davet-${Math.random().toString(36).slice(2)}@ornek.com`,
      token: generateInviteToken(),
      expiresAt: inviteExpiry(),
      acceptedAt,
    },
  });
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

describe("DELETE /api/agency/invites/[id]", () => {
  it("oturum yoksa 401 döner", async () => {
    mockAuth.mockResolvedValue(null as never);
    expect((await DELETE(deleteRequest(), params("x"))).status).toBe(401);
  });

  it("member rolü daveti iptal edemez (403)", async () => {
    const agency = await createAgency();
    const invite = await createInvite(agency.id);
    mockAuth.mockResolvedValue(session(agency.id, "member"));

    expect((await DELETE(deleteRequest(), params(invite.id))).status).toBe(403);
    expect(await db.agencyInvite.count()).toBe(1);
  });

  it("yabancı Origin 403 döner (S8)", async () => {
    const agency = await createAgency();
    const invite = await createInvite(agency.id);
    mockAuth.mockResolvedValue(session(agency.id, "owner"));

    const res = await DELETE(
      deleteRequest({ origin: "https://kotu.example" }),
      params(invite.id)
    );
    expect(res.status).toBe(403);
    expect(await db.agencyInvite.count()).toBe(1);
  });

  it("bekleyen daveti iptal eder", async () => {
    const agency = await createAgency();
    const invite = await createInvite(agency.id);
    mockAuth.mockResolvedValue(session(agency.id, "owner"));

    expect((await DELETE(deleteRequest(), params(invite.id))).status).toBe(200);
    expect(await db.agencyInvite.count()).toBe(0);
  });

  // IDOR: başka ajansın daveti iptal edilemez.
  it("BAŞKA ajansın daveti iptal edilemez — 404, satır durur", async () => {
    const agencyA = await createAgency();
    const agencyB = await createAgency();
    const invite = await createInvite(agencyB.id);

    mockAuth.mockResolvedValue(session(agencyA.id, "owner"));
    expect((await DELETE(deleteRequest(), params(invite.id))).status).toBe(404);
    expect(await db.agencyInvite.count()).toBe(1);
  });

  // Kabul edilmiş davet artık bir KAYIT: "kim ne zaman katıldı" bilgisini
  // silmek geçmişi yok etmek olurdu.
  it("kabul edilmiş davet silinmez (404)", async () => {
    const agency = await createAgency();
    const invite = await createInvite(agency.id, new Date());
    mockAuth.mockResolvedValue(session(agency.id, "owner"));

    expect((await DELETE(deleteRequest(), params(invite.id))).status).toBe(404);
    expect(await db.agencyInvite.count()).toBe(1);
  });
});
