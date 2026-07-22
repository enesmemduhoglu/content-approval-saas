import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

import { GET, POST } from "./route";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { createAgency, createClient, resetDb } from "@tests/helpers/db";

const mockAuth = vi.mocked(auth);

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

describe("GET /api/clients", () => {
  it("oturum yoksa 401 döner", async () => {
    mockAuth.mockResolvedValue(null as never);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("yalnızca kendi ajansının müşterilerini listeler (agency-scoped)", async () => {
    const agencyA = await createAgency();
    const agencyB = await createAgency();
    const clientA = await createClient(agencyA.id);
    await createClient(agencyB.id);

    mockAuth.mockResolvedValue({ agencyId: agencyA.id } as never);
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.clients).toHaveLength(1);
    expect(data.clients[0].id).toBe(clientA.id);
  });
});

describe("POST /api/clients", () => {
  it("müşteri oluşturur ve oturumdaki ajansa bağlar", async () => {
    const agency = await createAgency();
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await POST(
      jsonRequest({ name: "Kahve Dükkanı", email: "kahve@ornek.com" })
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.client.agencyId).toBe(agency.id);

    const saved = await db.client.findUnique({ where: { id: data.client.id } });
    expect(saved?.name).toBe("Kahve Dükkanı");
  });

  it("boş isim 400 döner", async () => {
    const agency = await createAgency();
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);
    const res = await POST(jsonRequest({ name: "", email: "a@b.com" }));
    expect(res.status).toBe(400);
  });

  it("geçersiz e-posta 400 döner", async () => {
    const agency = await createAgency();
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);
    const res = await POST(jsonRequest({ name: "Ad", email: "gecersiz" }));
    expect(res.status).toBe(400);
  });

  it("oturum yoksa 401 döner", async () => {
    mockAuth.mockResolvedValue(null as never);
    const res = await POST(jsonRequest({ name: "Ad", email: "a@b.com" }));
    expect(res.status).toBe(401);
  });
});
