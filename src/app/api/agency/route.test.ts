import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/blob")>();
  return { ...actual, uploadPostImage: vi.fn() };
});

import { GET, POST } from "./route";
import { auth } from "@/lib/auth";
import { uploadPostImage } from "@/lib/blob";
import { db } from "@/lib/db";
import { createAgency, resetDb } from "@tests/helpers/db";

const mockAuth = vi.mocked(auth);
const mockUpload = vi.mocked(uploadPostImage);

function postRequest(fields: { brandColor?: string; logo?: File; clearBrandColor?: string }) {
  const formData = new FormData();
  if (fields.brandColor !== undefined) formData.set("brandColor", fields.brandColor);
  if (fields.clearBrandColor !== undefined)
    formData.set("clearBrandColor", fields.clearBrandColor);
  if (fields.logo !== undefined) formData.set("logo", fields.logo);
  return new Request("http://localhost/api/agency", { method: "POST", body: formData });
}

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  mockUpload.mockResolvedValue("/uploads/logo.png");
});

describe("POST /api/agency", () => {
  it("marka rengini kaydeder", async () => {
    const agency = await createAgency();
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await POST(postRequest({ brandColor: "#AA3366" }));
    expect(res.status).toBe(200);

    const saved = await db.agency.findUnique({ where: { id: agency.id } });
    expect(saved?.brandColor).toBe("#aa3366");
  });

  it("geçersiz hex rengi 400 ile reddeder", async () => {
    const agency = await createAgency();
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await POST(postRequest({ brandColor: "kırmızı" }));
    expect(res.status).toBe(400);
  });

  it("logo yükler ve URL'i kaydeder", async () => {
    const agency = await createAgency();
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const logo = new File([new Uint8Array([1, 2, 3])], "logo.png", {
      type: "image/png",
    });
    const res = await POST(postRequest({ logo }));
    expect(res.status).toBe(200);

    const saved = await db.agency.findUnique({ where: { id: agency.id } });
    expect(saved?.logoUrl).toBe("/uploads/logo.png");
  });

  it("clearBrandColor rengi siler", async () => {
    const agency = await createAgency();
    await db.agency.update({ where: { id: agency.id }, data: { brandColor: "#112233" } });
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    const res = await POST(postRequest({ clearBrandColor: "1" }));
    expect(res.status).toBe(200);
    const saved = await db.agency.findUnique({ where: { id: agency.id } });
    expect(saved?.brandColor).toBeNull();
  });

  it("boş istek 400 döner", async () => {
    const agency = await createAgency();
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);
    const res = await POST(postRequest({}));
    expect(res.status).toBe(400);
  });

  it("oturum yoksa 401 döner", async () => {
    mockAuth.mockResolvedValue(null as never);
    const res = await POST(postRequest({ brandColor: "#112233" }));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/agency", () => {
  it("oturumdaki ajansın markalama bilgilerini döner", async () => {
    const agency = await createAgency({ name: "Marka Ajansı" });
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);
    const res = await GET();
    const data = await res.json();
    expect(data.agency.name).toBe("Marka Ajansı");
    expect(data.agency.brandColor).toBeNull();
  });
});
