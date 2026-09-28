import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/storage-r2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage-r2")>();
  return {
    ...actual,
    r2Configured: vi.fn(() => true),
    signPutUrl: vi.fn(async (key: string) => `https://acc.r2.cloudflarestorage.com/put/${key}`),
    createMultipartUpload: vi.fn(async () => "upload-1"),
  };
});

import { db } from "@/lib/db";
import { resetRateLimiter } from "@/lib/rate-limit";
import { createAgency, createClient, resetDb } from "@tests/helpers/db";
import { createClientUser, createPortalPost, portalCookie, portalRequest } from "@tests/helpers/portal";

import { POST as check } from "./upload/check/route";
import { POST as upload } from "./upload/route";

/**
 * "Aynı video" kontrolü (2026-09-28 analizi): boyutla eşleşme, müşteri
 * kapsamı, taslakların sayılmaması, eşin yeri.
 */

let agencyId: string;
let clientId: string;
let cookie: string;

beforeEach(async () => {
  await resetDb();
  resetRateLimiter();
  const agency = await createAgency();
  const client = await createClient(agency.id);
  agencyId = agency.id;
  clientId = client.id;
  cookie = portalCookie(await createClientUser(client.id));
});

const post = (path: string, body?: unknown, extra: { origin?: string; cookie?: string } = {}) =>
  portalRequest(path, { method: "POST", cookie: extra.cookie ?? cookie, body, origin: extra.origin });

async function withSource(
  overrides: Parameters<typeof createPortalPost>[2] & { size: number; name?: string; client?: string; agency?: string }
) {
  const { size, name, client, agency, ...rest } = overrides;
  const created = await createPortalPost(agency ?? agencyId, client ?? clientId, rest);
  return db.post.update({
    where: { id: created.id },
    data: { sourceSize: size, sourceName: name ?? "IMG_2041.MOV" },
  });
}

describe("POST /api/portal/upload — kaynak dosya kaydı", () => {
  it("taslağa boyut ve ad yazılır; ad gönderilmezse boş kalır", async () => {
    const res = await upload(
      post("/api/portal/upload", {
        files: [
          { contentType: "video/quicktime", size: 5_000_000, name: "  IMG_2041.MOV " },
          { contentType: "video/mp4", size: 6_000_000 },
        ],
      })
    );
    expect(res.status).toBe(201);
    const drafts = await db.post.findMany({
      where: { clientId },
      orderBy: { sourceSize: "asc" },
      select: { sourceSize: true, sourceName: true },
    });
    expect(drafts).toEqual([
      { sourceSize: 5_000_000, sourceName: "IMG_2041.MOV" },
      { sourceSize: 6_000_000, sourceName: null },
    ]);
  });

  it("geçersiz ad yüklemeyi düşürmez, yok sayılır", async () => {
    const res = await upload(
      post("/api/portal/upload", { files: [{ contentType: "video/mp4", size: 5_000_000, name: 42 }] })
    );
    expect(res.status).toBe(201);
    const draft = await db.post.findFirstOrThrow({ where: { clientId } });
    expect(draft.sourceName).toBeNull();
  });
});

describe("POST /api/portal/upload/check", () => {
  it("eşleşme yoksa her dosya için null; hiçbir şey yazılmaz", async () => {
    const res = await check(post("/api/portal/upload/check", { files: [{ size: 1 }, { size: 2 }] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ matches: [null, null] });
    expect(await db.post.count()).toBe(0);
  });

  it("kuyruktaki eş: yeri ve 1'den başlayan sırası", async () => {
    await withSource({ size: 111, queuePosition: 1 });
    const twin = await withSource({ size: 5_000_000, queuePosition: 2 });
    const res = await check(
      post("/api/portal/upload/check", { files: [{ size: 5_000_000, name: "başka ad.mov" }, { size: 7 }] })
    );
    const { matches } = await res.json();
    expect(matches).toEqual([
      { id: twin.id, createdAt: twin.createdAt.toISOString(), where: "queue", position: 2 },
      null,
    ]);
  });

  it("eşin yeri: kuyruk dışı, reddedilmiş, yayınlanmış", async () => {
    const outside = await withSource({ size: 10, queuePosition: null });
    const rejected = await withSource({ size: 20, queuePosition: null, status: "rejected" });
    const published = await withSource({
      size: 30,
      queuePosition: null,
      status: "approved",
      publishStatus: "published",
    });
    const res = await check(
      post("/api/portal/upload/check", { files: [{ size: 10 }, { size: 20 }, { size: 30 }] })
    );
    const { matches } = await res.json();
    expect(matches.map((m: { id: string; where: string }) => [m.id, m.where])).toEqual([
      [outside.id, "outside"],
      [rejected.id, "rejected"],
      [published.id, "published"],
    ]);
  });

  it("taslak (yarım yükleme) ve başka müşterinin videosu eş sayılmaz", async () => {
    await withSource({ size: 50, status: "draft", queuePosition: null });
    const otherAgency = await createAgency();
    const other = await createClient(otherAgency.id);
    await withSource({ size: 50, client: other.id, agency: otherAgency.id });
    const res = await check(post("/api/portal/upload/check", { files: [{ size: 50 }] }));
    expect(await res.json()).toEqual({ matches: [null] });
  });

  it("aynı boyutta birden fazla eş varsa en yenisi", async () => {
    await withSource({ size: 60, queuePosition: null });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await withSource({ size: 60, queuePosition: 1 });
    const { matches } = await (await check(post("/api/portal/upload/check", { files: [{ size: 60 }] }))).json();
    expect(matches[0].id).toBe(newer.id);
  });

  it("geçersiz gövde 400; oturumsuz 401; yabancı Origin 403", async () => {
    for (const body of [{}, { files: [] }, { files: [{ size: -1 }] }, { files: [{ size: "5" }] }]) {
      expect((await check(post("/api/portal/upload/check", body))).status).toBe(400);
    }
    expect(
      (await check(post("/api/portal/upload/check", { files: [{ size: 1 }] }, { cookie: "" }))).status
    ).toBe(401);
    expect(
      (
        await check(
          post("/api/portal/upload/check", { files: [{ size: 1 }] }, { origin: "https://kotu.example" })
        )
      ).status
    ).toBe(403);
  });
});
