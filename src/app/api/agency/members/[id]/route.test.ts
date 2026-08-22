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
import { createAgency, createMember, resetDb } from "@tests/helpers/db";

const mockAuth = vi.mocked(auth);

function deleteRequest(init: { origin?: string } = {}) {
  const headers: Record<string, string> = { host: "localhost" };
  if (init.origin) headers.origin = init.origin;
  return new Request("http://localhost/api/agency/members/x", {
    method: "DELETE",
    headers,
  });
}

function session(agencyId: string, role: "owner" | "member") {
  return { agencyId, agencyRole: role, user: { email: "ben@ornek.com" } } as never;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

describe("DELETE /api/agency/members/[id] — erişim", () => {
  it("oturum yoksa 401 döner", async () => {
    mockAuth.mockResolvedValue(null as never);
    expect((await DELETE(deleteRequest(), params("x"))).status).toBe(401);
  });

  it("member rolü üye çıkaramaz (403)", async () => {
    const agency = await createAgency();
    const hedef = await createMember(agency.id);
    mockAuth.mockResolvedValue(session(agency.id, "member"));

    const res = await DELETE(deleteRequest(), params(hedef.id));
    expect(res.status).toBe(403);
    expect(await db.agencyMember.findUnique({ where: { id: hedef.id } })).not.toBeNull();
  });

  it("yabancı Origin 403 döner (S8)", async () => {
    const agency = await createAgency();
    const hedef = await createMember(agency.id);
    mockAuth.mockResolvedValue(session(agency.id, "owner"));

    const res = await DELETE(
      deleteRequest({ origin: "https://kotu.example" }),
      params(hedef.id)
    );
    expect(res.status).toBe(403);
    expect(await db.agencyMember.findUnique({ where: { id: hedef.id } })).not.toBeNull();
  });

  // ─── IDOR ──────────────────────────────────────────────────────────────
  it("BAŞKA ajansın üyesi çıkarılamaz — 404 döner, satır durur", async () => {
    const agencyA = await createAgency();
    const agencyB = await createAgency();
    const kurban = await createMember(agencyB.id);

    mockAuth.mockResolvedValue(session(agencyA.id, "owner"));
    const res = await DELETE(deleteRequest(), params(kurban.id));
    expect(res.status).toBe(404);
    expect(await db.agencyMember.findUnique({ where: { id: kurban.id } })).not.toBeNull();
  });
});

describe("DELETE /api/agency/members/[id] — çıkarma", () => {
  it("ekip üyesini çıkarır", async () => {
    const agency = await createAgency();
    const hedef = await createMember(agency.id);
    mockAuth.mockResolvedValue(session(agency.id, "owner"));

    const res = await DELETE(deleteRequest(), params(hedef.id));
    expect(res.status).toBe(200);
    expect(await db.agencyMember.findUnique({ where: { id: hedef.id } })).toBeNull();
  });
});

// ─── SON OWNER KORUMASI ──────────────────────────────────────────────────
// Ajans sahipsiz kalırsa kimse davet edemez, kimse üye çıkaramaz ve kurtarma
// yolu kalmaz. Bu yüzden reddin gerçekleştiği yer transaction içi.
describe("DELETE /api/agency/members/[id] — son owner", () => {
  it("tek owner ÇIKARILAMAZ (409) ve satır durur", async () => {
    const agency = await createAgency();
    const owner = agency.members[0];
    mockAuth.mockResolvedValue(session(agency.id, "owner"));

    const res = await DELETE(deleteRequest(), params(owner.id));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("son sahibi");
    expect(await db.agencyMember.findUnique({ where: { id: owner.id } })).not.toBeNull();
  });

  it("tek owner, ajansta başka ÜYELER olsa bile çıkarılamaz", async () => {
    const agency = await createAgency();
    const owner = agency.members[0];
    await createMember(agency.id, { role: "member" });
    mockAuth.mockResolvedValue(session(agency.id, "owner"));

    expect((await DELETE(deleteRequest(), params(owner.id))).status).toBe(409);
  });

  it("iki owner varsa biri çıkarılabilir", async () => {
    const agency = await createAgency();
    const ikinci = await createMember(agency.id, { role: "owner" });
    mockAuth.mockResolvedValue(session(agency.id, "owner"));

    expect((await DELETE(deleteRequest(), params(ikinci.id))).status).toBe(200);
    // Ajans sahipsiz kalmadı.
    expect(
      await db.agencyMember.count({ where: { agencyId: agency.id, role: "owner" } })
    ).toBe(1);
  });

  it("iki owner peş peşe çıkarılmaya çalışılırsa ikincisi reddedilir", async () => {
    const agency = await createAgency();
    const ikinci = await createMember(agency.id, { role: "owner" });
    const ilk = agency.members[0];
    mockAuth.mockResolvedValue(session(agency.id, "owner"));

    expect((await DELETE(deleteRequest(), params(ikinci.id))).status).toBe(200);
    expect((await DELETE(deleteRequest(), params(ilk.id))).status).toBe(409);
    expect(
      await db.agencyMember.count({ where: { agencyId: agency.id, role: "owner" } })
    ).toBe(1);
  });
});
