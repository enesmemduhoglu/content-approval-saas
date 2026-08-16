import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

import { DELETE, POST } from "./route";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { createAgency, createClient, createInstagramClient, resetDb } from "@tests/helpers/db";

const mockAuth = vi.mocked(auth);

const VALID_TOKEN = "IGAAtest0000000000000000000000000000token";
const IG_USER_ID = "17841400000000000";

/** Sıradaki `GET /me` çağrısına verilecek yanıtlar; her çağrı birini tüketir. */
let responses: { status: number; body: unknown }[] = [];
let meCalls: string[] = [];

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/clients/x/instagram", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  responses = [];
  meCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      meCalls.push(String(input));
      const next = responses.shift();
      if (!next) throw new Error(`Beklenmeyen fetch çağrısı: ${String(input)}`);
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function respondMe(userId = IG_USER_ID, username = "test_hesap") {
  responses.push({ status: 200, body: { user_id: userId, username } });
}

describe("POST /api/clients/[id]/instagram", () => {
  it("oturum yoksa 401 döner", async () => {
    mockAuth.mockResolvedValue(null as never);
    const res = await POST(jsonRequest({ accessToken: VALID_TOKEN }), routeParams("x"));
    expect(res.status).toBe(401);
  });

  it("token'ı doğrular, hesap kimliğini /me'den doldurur ve kaydeder", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);
    respondMe();

    const res = await POST(
      jsonRequest({ accessToken: VALID_TOKEN, tokenExpiry: "2099-10-15" }),
      routeParams(client.id)
    );
    expect(res.status).toBe(200);

    expect(meCalls).toHaveLength(1);
    expect(meCalls[0]).toContain("/me?");
    expect(meCalls[0]).toContain("fields=user_id");

    const saved = await db.client.findUnique({ where: { id: client.id } });
    expect(saved?.instagramUserId).toBe(IG_USER_ID);
    expect(saved?.instagramAccessToken).toBe(VALID_TOKEN);
    expect(saved?.instagramTokenExpiry?.toISOString().slice(0, 10)).toBe("2099-10-15");
  });

  it("yanıtta token HAM dönmez, yalnızca maskelenmiş ipucu döner", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);
    respondMe();

    const res = await POST(jsonRequest({ accessToken: VALID_TOKEN }), routeParams(client.id));
    const raw = await res.text();
    expect(raw).not.toContain(VALID_TOKEN);
    expect(raw).not.toContain("instagramAccessToken");

    const data = JSON.parse(raw);
    expect(data.client.instagramConnected).toBe(true);
    expect(data.client.instagramTokenHint).toBe("…oken");
    expect(data.client.instagramUserId).toBe(IG_USER_ID);
  });

  it("başka ajansın müşterisi 404 döner ve Instagram'a hiç gidilmez", async () => {
    const agencyA = await createAgency();
    const agencyB = await createAgency();
    const clientB = await createClient(agencyB.id);
    mockAuth.mockResolvedValue({ agencyId: agencyA.id } as never);

    const res = await POST(jsonRequest({ accessToken: VALID_TOKEN }), routeParams(clientB.id));
    expect(res.status).toBe(404);
    expect(meCalls).toHaveLength(0);

    const saved = await db.client.findUnique({ where: { id: clientB.id } });
    expect(saved?.instagramAccessToken).toBeNull();
  });

  it("Instagram token'ı reddederse 400 + anlaşılır mesaj döner, DB'ye yazılmaz", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);
    responses.push({
      status: 400,
      body: { error: { message: "Invalid OAuth access token", code: 190 } },
    });

    const res = await POST(jsonRequest({ accessToken: VALID_TOKEN }), routeParams(client.id));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.field).toBe("accessToken");
    expect(data.error).toContain("Instagram bu token'ı kabul etmedi");

    const saved = await db.client.findUnique({ where: { id: client.id } });
    expect(saved?.instagramAccessToken).toBeNull();
  });

  it("elle girilen hesap kimliği token'ınkiyle uyuşmazsa 400 döner", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);
    respondMe();

    const res = await POST(
      jsonRequest({ accessToken: VALID_TOKEN, instagramUserId: "17841499999999999" }),
      routeParams(client.id)
    );
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("instagramUserId");

    const saved = await db.client.findUnique({ where: { id: client.id } });
    expect(saved?.instagramUserId).toBeNull();
  });

  it("boş token 400 döner ve Instagram'a gidilmez", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await POST(jsonRequest({ accessToken: "" }), routeParams(client.id));
    expect(res.status).toBe(400);
    expect(meCalls).toHaveLength(0);
  });

  it("geçmiş bir bitiş tarihi 400 döner", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await POST(
      jsonRequest({ accessToken: VALID_TOKEN, tokenExpiry: "2020-01-01" }),
      routeParams(client.id)
    );
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("tokenExpiry");
    expect(meCalls).toHaveLength(0);
  });
});

describe("DELETE /api/clients/[id]/instagram", () => {
  it("bağlantıyı kaldırır", async () => {
    const agency = await createAgency();
    const client = await createInstagramClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await DELETE(new Request("http://localhost"), routeParams(client.id));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.client.instagramConnected).toBe(false);
    expect(data.client.instagramTokenHint).toBeNull();

    const saved = await db.client.findUnique({ where: { id: client.id } });
    expect(saved?.instagramUserId).toBeNull();
    expect(saved?.instagramAccessToken).toBeNull();
    expect(saved?.instagramTokenExpiry).toBeNull();
  });

  it("başka ajansın müşterisinin bağlantısını kaldıramaz", async () => {
    const agencyA = await createAgency();
    const agencyB = await createAgency();
    const clientB = await createInstagramClient(agencyB.id);
    mockAuth.mockResolvedValue({ agencyId: agencyA.id } as never);

    const res = await DELETE(new Request("http://localhost"), routeParams(clientB.id));
    expect(res.status).toBe(404);

    const saved = await db.client.findUnique({ where: { id: clientB.id } });
    expect(saved?.instagramAccessToken).toBe("IGAA-test-token");
  });

  it("oturum yoksa 401 döner", async () => {
    mockAuth.mockResolvedValue(null as never);
    const res = await DELETE(new Request("http://localhost"), routeParams("x"));
    expect(res.status).toBe(401);
  });
});
