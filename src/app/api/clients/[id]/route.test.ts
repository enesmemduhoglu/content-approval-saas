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
import {
  createAgency,
  createClient,
  createInstagramClient,
  createPendingPostWithLink,
  resetDb,
} from "@tests/helpers/db";

const mockAuth = vi.mocked(auth);

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

const request = () =>
  new Request("http://localhost/api/clients/x", { method: "DELETE" });

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

describe("DELETE /api/clients/[id]", () => {
  it("oturum yoksa 401 döner", async () => {
    mockAuth.mockResolvedValue(null as never);
    expect((await DELETE(request(), params("herhangi"))).status).toBe(401);
  });

  it("postsuz müşteriyi siler", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    expect((await DELETE(request(), params(client.id))).status).toBe(200);
    expect(await db.client.findUnique({ where: { id: client.id } })).toBeNull();
  });

  it("portal kullanıcısı ve bildirim aboneliği olan müşteriyi siler (V7c, RESTRICT FK)", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const user = await db.clientUser.create({
      data: { clientId: client.id, email: "portal-sil@test.local" },
    });
    await db.pushSubscription.create({
      data: {
        clientUserId: user.id,
        endpoint: "https://web.push.apple.com/musteri-sil",
        p256dh: "k",
        auth: "a",
      },
    });
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    expect((await DELETE(request(), params(client.id))).status).toBe(200);
    expect(await db.client.findUnique({ where: { id: client.id } })).toBeNull();
    expect(await db.pushSubscription.count()).toBe(0);
  });

  it("Instagram bağlı müşteriyi silince kimlik bilgileri de gider", async () => {
    const agency = await createAgency();
    const client = await createInstagramClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    expect((await DELETE(request(), params(client.id))).status).toBe(200);
    expect(await db.client.findUnique({ where: { id: client.id } })).toBeNull();
  });

  it("postu olan müşteriyi SİLMEZ ve kaç post olduğunu söyler (409)", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    await createPendingPostWithLink(agency.id, client.id);
    await createPendingPostWithLink(agency.id, client.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await DELETE(request(), params(client.id));
    expect(res.status).toBe(409);
    expect((await res.json()).postCount).toBe(2);
    expect(await db.client.findUnique({ where: { id: client.id } })).not.toBeNull();
  });

  it("başka ajansın müşterisini silemez (404)", async () => {
    const agencyA = await createAgency();
    const agencyB = await createAgency();
    const client = await createClient(agencyA.id);
    mockAuth.mockResolvedValue({ agencyId: agencyB.id } as never);

    expect((await DELETE(request(), params(client.id))).status).toBe(404);
    expect(await db.client.findUnique({ where: { id: client.id } })).not.toBeNull();
  });
});
