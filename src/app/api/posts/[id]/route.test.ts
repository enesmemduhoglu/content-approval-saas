import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

import { DELETE, PATCH } from "./route";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  createAgency,
  createClient,
  createPendingPostWithLink,
  createPublishedPost,
  resetDb,
} from "@tests/helpers/db";

const mockAuth = vi.mocked(auth);

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function patchRequest(body: unknown) {
  return new Request("http://localhost/api/posts/x", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const deleteRequest = () =>
  new Request("http://localhost/api/posts/x", { method: "DELETE" });

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

describe("PATCH /api/posts/[id]", () => {
  it("oturum yoksa 401 döner", async () => {
    mockAuth.mockResolvedValue(null as never);
    const res = await PATCH(patchRequest({ caption: "yeni" }), params("herhangi"));
    expect(res.status).toBe(401);
  });

  it("pending postun metnini günceller", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { post } = await createPendingPostWithLink(agency.id, client.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await PATCH(patchRequest({ caption: "  düzeltilmiş metin  " }), params(post.id));
    expect(res.status).toBe(200);

    const updated = await db.post.findUnique({ where: { id: post.id } });
    expect(updated?.caption).toBe("düzeltilmiş metin");
  });

  it("karar verilmiş postu değiştirmez (409)", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { post } = await createPendingPostWithLink(agency.id, client.id, {
      status: "approved",
    });
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await PATCH(patchRequest({ caption: "yeni" }), params(post.id));
    expect(res.status).toBe(409);

    const unchanged = await db.post.findUnique({ where: { id: post.id } });
    expect(unchanged?.caption).toBe("Test caption");
  });

  it("başka ajansın postuna dokunamaz (404)", async () => {
    const agencyA = await createAgency();
    const agencyB = await createAgency();
    const client = await createClient(agencyA.id);
    const { post } = await createPendingPostWithLink(agencyA.id, client.id);
    mockAuth.mockResolvedValue({ agencyId: agencyB.id } as never);

    const res = await PATCH(patchRequest({ caption: "ele geçir" }), params(post.id));
    expect(res.status).toBe(404);

    const unchanged = await db.post.findUnique({ where: { id: post.id } });
    expect(unchanged?.caption).toBe("Test caption");
  });

  it("boş caption reddedilir", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { post } = await createPendingPostWithLink(agency.id, client.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await PATCH(patchRequest({ caption: "   " }), params(post.id));
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/posts/[id]", () => {
  it("oturum yoksa 401 döner", async () => {
    mockAuth.mockResolvedValue(null as never);
    const res = await DELETE(deleteRequest(), params("herhangi"));
    expect(res.status).toBe(401);
  });

  it("postu, görsellerini, linkini ve audit kayıtlarını siler", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { post } = await createPendingPostWithLink(agency.id, client.id);
    await db.approvalAudit.create({
      data: { postId: post.id, action: "approved", ip: "1.2.3.4" },
    });
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await DELETE(deleteRequest(), params(post.id));
    expect(res.status).toBe(200);

    expect(await db.post.findUnique({ where: { id: post.id } })).toBeNull();
    expect(await db.postImage.count({ where: { postId: post.id } })).toBe(0);
    expect(await db.approvalLink.count({ where: { postId: post.id } })).toBe(0);
    // ApprovalAudit'in Post'a FK'sı yok — elle silinmezse öksüz kalırdı.
    expect(await db.approvalAudit.count({ where: { postId: post.id } })).toBe(0);
  });

  it("yayınlanmış postu SİLMEZ (409)", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const post = await createPublishedPost(agency.id, client.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await DELETE(deleteRequest(), params(post.id));
    expect(res.status).toBe(409);
    expect(await db.post.findUnique({ where: { id: post.id } })).not.toBeNull();
  });

  it("başka ajansın postunu silemez (404)", async () => {
    const agencyA = await createAgency();
    const agencyB = await createAgency();
    const client = await createClient(agencyA.id);
    const { post } = await createPendingPostWithLink(agencyA.id, client.id);
    mockAuth.mockResolvedValue({ agencyId: agencyB.id } as never);

    const res = await DELETE(deleteRequest(), params(post.id));
    expect(res.status).toBe(404);
    expect(await db.post.findUnique({ where: { id: post.id } })).not.toBeNull();
  });
});
