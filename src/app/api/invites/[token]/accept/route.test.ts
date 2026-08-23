import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
  // Route oturumu tazelemek için çağırıyor; testte gerçek çerez yazımı yok.
  unstable_update: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

import { POST } from "./route";
import { auth, unstable_update } from "@/lib/auth";
import { db } from "@/lib/db";
import { generateInviteToken, inviteExpiry } from "@/lib/tokens";
import { resetRateLimiter } from "@/lib/rate-limit";
import { createAgency, createClient, resetDb } from "@tests/helpers/db";

const mockAuth = vi.mocked(auth);
const mockUpdate = vi.mocked(unstable_update);

function postRequest(token: string, init: { origin?: string } = {}) {
  const headers: Record<string, string> = { host: "localhost" };
  if (init.origin) headers.origin = init.origin;
  return new Request(`http://localhost/api/invites/${token}/accept`, {
    method: "POST",
    headers,
  });
}

function session(input: { googleId: string; email: string; agencyId?: string }) {
  return {
    agencyId: input.agencyId ?? "eski-ajans",
    googleId: input.googleId,
    user: { email: input.email, name: "Davetli" },
  } as never;
}

const params = (token: string) => ({ params: Promise.resolve({ token }) });

function createInvite(
  agencyId: string,
  overrides: { email?: string; expiresAt?: Date; acceptedAt?: Date | null } = {}
) {
  return db.agencyInvite.create({
    data: {
      agencyId,
      email: overrides.email ?? "davetli@ornek.com",
      token: generateInviteToken(),
      expiresAt: overrides.expiresAt ?? inviteExpiry(),
      acceptedAt: overrides.acceptedAt ?? null,
    },
  });
}

beforeEach(async () => {
  await resetDb();
  resetRateLimiter();
  mockAuth.mockReset();
  mockUpdate.mockReset();
  mockUpdate.mockResolvedValue(null as never);
});

describe("POST /api/invites/[token]/accept", () => {
  it("oturum yoksa 401", async () => {
    mockAuth.mockResolvedValue(null as never);
    const res = await POST(postRequest("x"), params("x"));
    expect(res.status).toBe(401);
  });

  it("oturumda googleId yoksa 401 — F6 öncesi token'lar devir yapamaz", async () => {
    mockAuth.mockResolvedValue({
      agencyId: "a",
      user: { email: "eski@ornek.com" },
    } as never);
    expect((await POST(postRequest("x"), params("x"))).status).toBe(401);
  });

  it("yabancı Origin 403 — CSRF ikinci katmanı", async () => {
    const hedef = await createAgency();
    const invite = await createInvite(hedef.id);
    mockAuth.mockResolvedValue(
      session({ googleId: "google-x", email: "davetli@ornek.com" })
    );
    const res = await POST(
      postRequest(invite.token, { origin: "https://kotu.example" }),
      params(invite.token)
    );
    expect(res.status).toBe(403);
    // Yazma OLMAMALI.
    expect((await db.agencyInvite.findUnique({ where: { id: invite.id } }))?.acceptedAt).toBeNull();
  });

  it("boş ajanstan devir: 200, oturum tazelenir", async () => {
    const bos = await createAgency({ name: "Boş" });
    const hedef = await createAgency({ name: "Hedef" });
    const sahip = bos.members[0];
    const invite = await createInvite(hedef.id, { email: sahip.email });

    mockAuth.mockResolvedValue(
      session({ googleId: sahip.googleId, email: sahip.email, agencyId: bos.id })
    );
    const res = await POST(postRequest(invite.token), params(invite.token));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.agencyId).toBe(hedef.id);
    expect(body.leftAgencyId).toBe(bos.id);
    expect(body.sessionRefreshed).toBe(true);
    expect(mockUpdate).toHaveBeenCalledOnce();

    const uyelik = await db.agencyMember.findUnique({ where: { googleId: sahip.googleId } });
    expect(uyelik?.agencyId).toBe(hedef.id);
  });

  it("oturum tazelenemezse devir GERİ ALINMAZ, yanıt uyarır", async () => {
    const bos = await createAgency();
    const hedef = await createAgency();
    const sahip = bos.members[0];
    const invite = await createInvite(hedef.id, { email: sahip.email });
    mockUpdate.mockRejectedValue(new Error("çerez yazılamadı"));

    mockAuth.mockResolvedValue(
      session({ googleId: sahip.googleId, email: sahip.email, agencyId: bos.id })
    );
    const res = await POST(postRequest(invite.token), params(invite.token));
    expect(res.status).toBe(200);
    expect((await res.json()).sessionRefreshed).toBe(false);
    // Devir commit oldu; tazeleme yalnızca konfor.
    const uyelik = await db.agencyMember.findUnique({ where: { googleId: sahip.googleId } });
    expect(uyelik?.agencyId).toBe(hedef.id);
  });

  it("başka adrese gönderilmiş davet 403", async () => {
    const bos = await createAgency();
    const hedef = await createAgency();
    const sahip = bos.members[0];
    const invite = await createInvite(hedef.id, { email: "baskasi@ornek.com" });

    mockAuth.mockResolvedValue(
      session({ googleId: sahip.googleId, email: sahip.email, agencyId: bos.id })
    );
    const res = await POST(postRequest(invite.token), params(invite.token));
    expect(res.status).toBe(403);
    expect((await db.agencyInvite.findUnique({ where: { id: invite.id } }))?.acceptedAt).toBeNull();
  });

  it("dolu ajansın son owner'ı 409 alır", async () => {
    const dolu = await createAgency();
    const hedef = await createAgency();
    const sahip = dolu.members[0];
    await createClient(dolu.id);
    const invite = await createInvite(hedef.id, { email: sahip.email });

    mockAuth.mockResolvedValue(
      session({ googleId: sahip.googleId, email: sahip.email, agencyId: dolu.id })
    );
    const res = await POST(postRequest(invite.token), params(invite.token));
    expect(res.status).toBe(409);
    const uyelik = await db.agencyMember.findUnique({ where: { googleId: sahip.googleId } });
    expect(uyelik?.agencyId).toBe(dolu.id);
  });

  it("süresi dolmuş davet 409", async () => {
    const bos = await createAgency();
    const hedef = await createAgency();
    const sahip = bos.members[0];
    const invite = await createInvite(hedef.id, {
      email: sahip.email,
      expiresAt: new Date(Date.now() - 1000),
    });

    mockAuth.mockResolvedValue(
      session({ googleId: sahip.googleId, email: sahip.email, agencyId: bos.id })
    );
    expect((await POST(postRequest(invite.token), params(invite.token))).status).toBe(409);
  });

  it("olmayan token 409 — davetin VARLIĞI sızmaz", async () => {
    mockAuth.mockResolvedValue(
      session({ googleId: "google-yok", email: "yok@ornek.com" })
    );
    expect((await POST(postRequest("hayalet"), params("hayalet"))).status).toBe(409);
  });

  it("hız sınırı: aynı hesap arka arkaya deneyemez", async () => {
    mockAuth.mockResolvedValue(
      session({ googleId: "google-hizli", email: "hizli@ornek.com" })
    );
    let sonStatus = 0;
    for (let i = 0; i < 12; i += 1) {
      sonStatus = (await POST(postRequest("hayalet"), params("hayalet"))).status;
    }
    expect(sonStatus).toBe(429);
  });
});
