import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/email", () => ({ sendTeamInviteEmail: vi.fn() }));

import { GET, POST } from "./route";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { sendTeamInviteEmail } from "@/lib/email";
import { resetRateLimiter } from "@/lib/rate-limit";
import { generateInviteToken, inviteExpiry } from "@/lib/tokens";
import { createAgency, createMember, resetDb } from "@tests/helpers/db";

const mockAuth = vi.mocked(auth);
const mockSendInvite = vi.mocked(sendTeamInviteEmail);

function inviteRequest(body: unknown, init: { origin?: string } = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    host: "localhost",
  };
  if (init.origin) headers.origin = init.origin;
  return new Request("http://localhost/api/agency/members", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** Oturum sahtesi — route yalnızca bu üç alana bakıyor. */
function session(agencyId: string, role: "owner" | "member", email = "ben@ornek.com") {
  return { agencyId, agencyRole: role, user: { email } } as never;
}

beforeEach(async () => {
  await resetDb();
  resetRateLimiter();
  mockAuth.mockReset();
  mockSendInvite.mockReset();
  mockSendInvite.mockResolvedValue({ sent: true });
});

afterEach(() => {
  delete process.env.QUOTA_MAX_PENDING_INVITES;
});

describe("GET /api/agency/members", () => {
  it("oturum yoksa 401 döner", async () => {
    mockAuth.mockResolvedValue(null as never);
    expect((await GET()).status).toBe(401);
  });

  // IDOR: bir ajansın üyesi başka ajansın ekibini GÖREMEZ.
  it("yalnızca kendi ajansının üyelerini ve davetlerini listeler", async () => {
    const agencyA = await createAgency();
    const agencyB = await createAgency();
    await createMember(agencyB.id, { email: "gizli@ornek.com" });
    await db.agencyInvite.create({
      data: {
        agencyId: agencyB.id,
        email: "gizlidavet@ornek.com",
        token: generateInviteToken(),
        expiresAt: inviteExpiry(),
      },
    });

    mockAuth.mockResolvedValue(session(agencyA.id, "owner"));
    const res = await GET();
    const raw = await res.text();
    expect(raw).not.toContain("gizli@ornek.com");
    expect(raw).not.toContain("gizlidavet@ornek.com");

    const data = JSON.parse(raw);
    expect(data.members).toHaveLength(1); // yalnızca A'nın kurucu owner'ı
    expect(data.invites).toHaveLength(0);
  });

  it("bekleyen davetin TOKEN'ı yanıta çıkmaz", async () => {
    const agency = await createAgency();
    const token = generateInviteToken();
    await db.agencyInvite.create({
      data: { agencyId: agency.id, email: "d@ornek.com", token, expiresAt: inviteExpiry() },
    });

    mockAuth.mockResolvedValue(session(agency.id, "owner"));
    const raw = await (await GET()).text();
    expect(raw).not.toContain(token);
  });

  it("süresi dolmuş davet listede kalır ama `expired` ile işaretlenir", async () => {
    const agency = await createAgency();
    await db.agencyInvite.create({
      data: {
        agencyId: agency.id,
        email: "eski@ornek.com",
        token: generateInviteToken(),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    mockAuth.mockResolvedValue(session(agency.id, "member"));
    const data = await (await GET()).json();
    expect(data.invites[0].expired).toBe(true);
  });
});

describe("POST /api/agency/members — yetki ve CSRF", () => {
  it("oturum yoksa 401 döner", async () => {
    mockAuth.mockResolvedValue(null as never);
    expect((await POST(inviteRequest({ email: "a@b.com" }))).status).toBe(401);
  });

  it("member rolü davet EDEMEZ (403) ve DB'ye yazmaz", async () => {
    const agency = await createAgency();
    mockAuth.mockResolvedValue(session(agency.id, "member"));
    const res = await POST(inviteRequest({ email: "yeni@ornek.com" }));
    expect(res.status).toBe(403);
    expect(await db.agencyInvite.count()).toBe(0);
    expect(mockSendInvite).not.toHaveBeenCalled();
  });

  // S8 — Origin kontrolü. Yabancı origin'den gelen istek mail attıramamalı.
  it("yabancı Origin 403 döner ve mail göndermez", async () => {
    const agency = await createAgency();
    mockAuth.mockResolvedValue(session(agency.id, "owner"));
    const res = await POST(
      inviteRequest({ email: "yeni@ornek.com" }, { origin: "https://kotu.example" })
    );
    expect(res.status).toBe(403);
    expect(mockSendInvite).not.toHaveBeenCalled();
  });

  it("kendi origin'i kabul edilir", async () => {
    const agency = await createAgency();
    mockAuth.mockResolvedValue(session(agency.id, "owner"));
    const res = await POST(
      inviteRequest({ email: "yeni@ornek.com" }, { origin: "http://localhost" })
    );
    expect(res.status).toBe(201);
  });
});

describe("POST /api/agency/members — davet oluşturma", () => {
  it("daveti oturumdaki ajansa bağlar ve maili gonder() yolundan atar", async () => {
    const agency = await createAgency({ name: "Ajansım" });
    mockAuth.mockResolvedValue(session(agency.id, "owner", "sahip@ornek.com"));

    const res = await POST(inviteRequest({ email: "Yeni@Ornek.com" }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.emailSent).toBe(true);

    const invite = await db.agencyInvite.findFirst();
    expect(invite?.agencyId).toBe(agency.id);
    // Eşleştirmenin çalışması için e-posta normalize saklanmalı.
    expect(invite?.email).toBe("yeni@ornek.com");
    expect(invite?.invitedByEmail).toBe("sahip@ornek.com");

    const arg = mockSendInvite.mock.calls[0][0];
    expect(arg.to).toBe("yeni@ornek.com");
    expect(arg.agencyName).toBe("Ajansım");
    expect(arg.inviteUrl).toContain(`/invite/${invite?.token}`);
  });

  it("geçersiz e-posta 400 döner", async () => {
    const agency = await createAgency();
    mockAuth.mockResolvedValue(session(agency.id, "owner"));
    expect((await POST(inviteRequest({ email: "gecersiz" }))).status).toBe(400);
  });

  it("bilinmeyen rol 400 döner (enum'a serbest metin yazılmaz)", async () => {
    const agency = await createAgency();
    mockAuth.mockResolvedValue(session(agency.id, "owner"));
    const res = await POST(inviteRequest({ email: "a@ornek.com", role: "admin" }));
    expect(res.status).toBe(400);
  });

  it("rol verilmezse `member` olur — yetki yanlışlıkla yükseltilmez", async () => {
    const agency = await createAgency();
    mockAuth.mockResolvedValue(session(agency.id, "owner"));
    await POST(inviteRequest({ email: "a@ornek.com" }));
    expect((await db.agencyInvite.findFirst())?.role).toBe("member");
  });

  it("zaten ekipte olan e-posta 409 döner ve mail göndermez", async () => {
    const agency = await createAgency();
    await createMember(agency.id, { email: "zaten@ornek.com" });
    mockAuth.mockResolvedValue(session(agency.id, "owner"));

    const res = await POST(inviteRequest({ email: "Zaten@Ornek.com" }));
    expect(res.status).toBe(409);
    expect(mockSendInvite).not.toHaveBeenCalled();
  });

  it("aynı adrese ikinci bekleyen davet 409 döner (spam kapısı)", async () => {
    const agency = await createAgency();
    mockAuth.mockResolvedValue(session(agency.id, "owner"));
    expect((await POST(inviteRequest({ email: "bir@ornek.com" }))).status).toBe(201);
    expect((await POST(inviteRequest({ email: "bir@ornek.com" }))).status).toBe(409);
    expect(await db.agencyInvite.count()).toBe(1);
  });

  it("mail gitmese bile davet kaydı durur ve emailSent=false döner", async () => {
    mockSendInvite.mockResolvedValue({ sent: false, reason: "resend reddetti" });
    const agency = await createAgency();
    mockAuth.mockResolvedValue(session(agency.id, "owner"));

    const res = await POST(inviteRequest({ email: "sessiz@ornek.com" }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.emailSent).toBe(false);
    // Owner linki elle iletebilsin diye yanıtta duruyor.
    expect(data.inviteUrl).toContain("/invite/");
    expect(await db.agencyInvite.count()).toBe(1);
  });
});

describe("POST /api/agency/members — davet spam tavanı (F7 deseni)", () => {
  it("bekleyen davet tavanına ulaşıldığında 403 döner", async () => {
    process.env.QUOTA_MAX_PENDING_INVITES = "1";
    const agency = await createAgency();
    mockAuth.mockResolvedValue(session(agency.id, "owner"));

    expect((await POST(inviteRequest({ email: "a@ornek.com" }))).status).toBe(201);
    const res = await POST(inviteRequest({ email: "b@ornek.com" }));
    expect(res.status).toBe(403);
    expect(await db.agencyInvite.count()).toBe(1);
  });

  it("tavan AJANS KAPSAMLIDIR — başka ajansın davetleri sayılmaz", async () => {
    process.env.QUOTA_MAX_PENDING_INVITES = "1";
    const agencyA = await createAgency();
    const agencyB = await createAgency();
    await db.agencyInvite.create({
      data: {
        agencyId: agencyB.id,
        email: "b@ornek.com",
        token: generateInviteToken(),
        expiresAt: inviteExpiry(),
      },
    });

    mockAuth.mockResolvedValue(session(agencyA.id, "owner"));
    expect((await POST(inviteRequest({ email: "a@ornek.com" }))).status).toBe(201);
  });

  it("süresi dolmuş davetler tavanı işgal etmez", async () => {
    process.env.QUOTA_MAX_PENDING_INVITES = "1";
    const agency = await createAgency();
    await db.agencyInvite.create({
      data: {
        agencyId: agency.id,
        email: "eski@ornek.com",
        token: generateInviteToken(),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    mockAuth.mockResolvedValue(session(agency.id, "owner"));
    expect((await POST(inviteRequest({ email: "yeni@ornek.com" }))).status).toBe(201);
  });
});
