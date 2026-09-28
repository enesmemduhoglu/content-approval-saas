import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/storage-r2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage-r2")>();
  return {
    ...actual,
    r2Configured: vi.fn(() => true),
    deleteObject: vi.fn(async () => true),
  };
});
vi.mock("@/lib/alerts", () => ({ sendAlert: vi.fn(async () => undefined) }));

import type { PostStatus, PublishStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { sendAlert } from "@/lib/alerts";
import { deleteObject, r2Configured } from "@/lib/storage-r2";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { retentionDue, runMediaRetention } from "@/lib/media-retention";
import { OUTSIDE_TTL_MS, PUBLISHED_VIDEO_TTL_MS } from "@/lib/retention-rules";
import { createAgency, createClient, resetDb } from "@tests/helpers/db";
import { createClientUser, createPortalPost } from "@tests/helpers/portal";

const NOW = new Date("2026-09-28T12:02:00Z");
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

let agencyId: string;
let clientId: string;

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  vi.mocked(r2Configured).mockReturnValue(true);
  vi.mocked(deleteObject).mockResolvedValue(true);
  const agency = await createAgency();
  agencyId = agency.id;
  clientId = (await createClient(agency.id)).id;
});

const frames = (id: string) =>
  Array.from({ length: 6 }, (_, i) => `clients/${clientId}/frames/${id}/${i}.jpg`);

async function published(opts: {
  publishedAt: Date | null;
  updatedAt?: Date;
  publishStatus?: PublishStatus;
}) {
  const post = await createPortalPost(agencyId, clientId, {
    status: "approved",
    publishStatus: opts.publishStatus ?? "published",
    queuePosition: null,
  });
  return db.post.update({
    where: { id: post.id },
    data: {
      frameKeys: frames(post.id),
      publishedAt: opts.publishedAt,
      ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
    },
  });
}

async function outside(opts: { outsideAt: Date | null; status?: PostStatus; publishStatus?: PublishStatus; queuePosition?: number | null }) {
  const post = await createPortalPost(agencyId, clientId, {
    status: opts.status ?? "rejected",
    publishStatus: opts.publishStatus ?? "idle",
    queuePosition: opts.queuePosition ?? null,
  });
  return db.post.update({
    where: { id: post.id },
    data: { frameKeys: frames(post.id), outsideAt: opts.outsideAt },
  });
}

const deletedKeys = () => vi.mocked(deleteObject).mock.calls.map(([key]) => key).sort();

describe("yayınlanan video — 2 gün sonra arşiv", () => {
  it("49 saatlik yayın: video + 5 kare silinir, ilk kare kapak olarak kalır, satır durur", async () => {
    const post = await published({ publishedAt: ago(49 * HOUR) });
    const stats = await runMediaRetention(NOW);

    expect(stats).toMatchObject({ archived: 1, purged: 0, failed: 0 });
    const after = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(after.videoKey).toBeNull();
    expect(after.frameKeys).toEqual([frames(post.id)[0]]);
    expect(after.publishStatus).toBe("published");
    expect(deletedKeys()).toEqual([post.videoKey!, ...frames(post.id).slice(1)].sort());
  });

  it("47 saatlik yayına dokunulmaz", async () => {
    const post = await published({ publishedAt: ago(47 * HOUR) });
    expect(await runMediaRetention(NOW)).toMatchObject({ archived: 0 });
    expect((await db.post.findUniqueOrThrow({ where: { id: post.id } })).videoKey).not.toBeNull();
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("duplicate'te publishedAt yoksa updatedAt'e bakılır", async () => {
    const old = await published({ publishedAt: null, updatedAt: ago(PUBLISHED_VIDEO_TTL_MS + HOUR), publishStatus: "duplicate" });
    const fresh = await published({ publishedAt: null, updatedAt: ago(HOUR), publishStatus: "duplicate" });
    await runMediaRetention(NOW);
    expect((await db.post.findUniqueOrThrow({ where: { id: old.id } })).videoKey).toBeNull();
    expect((await db.post.findUniqueOrThrow({ where: { id: fresh.id } })).videoKey).not.toBeNull();
  });

  it("yayınlanmamış (idle/publishing/failed) ve ajans postuna asla dokunulmaz", async () => {
    const ids: string[] = [];
    for (const publishStatus of ["idle", "publishing", "failed"] as const) {
      ids.push((await published({ publishedAt: ago(10 * 24 * HOUR), publishStatus })).id);
    }
    const agencyPost = await published({ publishedAt: ago(10 * 24 * HOUR) });
    await db.post.update({ where: { id: agencyPost.id }, data: { source: "agency" } });
    ids.push(agencyPost.id);

    expect(await runMediaRetention(NOW)).toMatchObject({ archived: 0 });
    for (const id of ids) {
      expect((await db.post.findUniqueOrThrow({ where: { id } })).videoKey).not.toBeNull();
    }
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("ikinci koşu aynı videoyu tekrar işlemez", async () => {
    await published({ publishedAt: ago(3 * 24 * HOUR) });
    await runMediaRetention(NOW);
    vi.mocked(deleteObject).mockClear();
    expect(await runMediaRetention(NOW)).toMatchObject({ archived: 0 });
    expect(deleteObject).not.toHaveBeenCalled();
  });
});

describe("kuyruk dışı video — 3 gün sonra tamamen silinir", () => {
  it("süresi dolan reddedilen ve çıkarılan video: satır ve tüm nesneler gider", async () => {
    const rejected = await outside({ outsideAt: ago(OUTSIDE_TTL_MS + HOUR) });
    const removed = await outside({ outsideAt: ago(OUTSIDE_TTL_MS + HOUR), status: "approved", publishStatus: "failed" });

    const stats = await runMediaRetention(NOW);
    expect(stats).toMatchObject({ purged: 2, failed: 0 });
    for (const post of [rejected, removed]) {
      expect(await db.post.findUnique({ where: { id: post.id } })).toBeNull();
    }
    expect(deletedKeys()).toEqual(
      [rejected, removed].flatMap((p) => [p.videoKey!, ...frames(p.id)]).sort()
    );
  });

  it("süresi dolmamış, sayacı olmayan ve kuyruktaki videoya dokunulmaz", async () => {
    const fresh = await outside({ outsideAt: ago(OUTSIDE_TTL_MS - HOUR) });
    const noStamp = await outside({ outsideAt: null });
    // Olmaması gereken durum (kuyrukta ama damgalı) bile silinmez: koşul queuePosition null.
    const queued = await outside({ outsideAt: ago(OUTSIDE_TTL_MS + HOUR), status: "approved", queuePosition: 1 });

    expect(await runMediaRetention(NOW)).toMatchObject({ purged: 0 });
    for (const post of [fresh, noStamp, queued]) {
      expect(await db.post.findUnique({ where: { id: post.id } })).not.toBeNull();
    }
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("çocuk satırlar da gider, SlotRun kalır ama bağı kopar", async () => {
    const post = await outside({ outsideAt: ago(OUTSIDE_TTL_MS + HOUR) });
    await db.approvalAudit.create({ data: { postId: post.id, action: "rejected", ip: "1.1.1.1" } });
    const run = await db.slotRun.create({
      data: { clientId, slotAt: ago(5 * 24 * HOUR), outcome: "failed", postId: post.id },
    });

    await runMediaRetention(NOW);
    expect(await db.post.findUnique({ where: { id: post.id } })).toBeNull();
    expect(await db.approvalAudit.count({ where: { postId: post.id } })).toBe(0);
    expect((await db.slotRun.findUniqueOrThrow({ where: { id: run.id } })).postId).toBeNull();
  });
});

describe("kuyruk dışı sayacı (outsideAt) — portal veri katmanı", () => {
  async function scoped() {
    const user = await createClientUser(clientId);
    return getClientScopedDb({ clientId, clientUserId: user.id });
  }

  it("red ve kuyruktan çıkarma sayacı başlatır; geri alma ve sona atma durdurur", async () => {
    const s = await scoped();
    const a = await createPortalPost(agencyId, clientId, { status: "pending" });
    const b = await createPortalPost(agencyId, clientId, { status: "approved" });
    const stamp = async (id: string) => (await db.post.findUniqueOrThrow({ where: { id } })).outsideAt;

    expect(await s.posts.decide(a.id, "reject", "1.1.1.1", null)).not.toBeNull();
    expect(await stamp(a.id)).toBeInstanceOf(Date);
    expect(await s.posts.restoreRejected(a.id, { approve: false, position: null, ip: "1.1.1.1" })).toBe(true);
    expect(await stamp(a.id)).toBeNull();

    expect(await s.posts.removeFromQueue(b.id)).toBe(true);
    expect(await stamp(b.id)).toBeInstanceOf(Date);
    expect(await s.posts.moveToEnd(b.id)).toBe(true);
    expect(await stamp(b.id)).toBeNull();
  });

  it("geri alınıp yeniden çıkarılan video eski sayaçla silinmez", async () => {
    const s = await scoped();
    const post = await outside({ outsideAt: ago(OUTSIDE_TTL_MS + HOUR), status: "approved" });
    // Müşteri geri aldı, sonra yeniden çıkardı: sayaç şimdiden başlar.
    expect(await s.posts.moveToEnd(post.id)).toBe(true);
    expect(await s.posts.removeFromQueue(post.id)).toBe(true);

    expect(await runMediaRetention(NOW)).toMatchObject({ purged: 0 });
    expect(await db.post.findUnique({ where: { id: post.id } })).not.toBeNull();
  });
});

describe("hata yolları", () => {
  it("R2 yapılandırılmamışsa hiçbir şey silinmez ve anahtar düşürülmez", async () => {
    vi.mocked(r2Configured).mockReturnValue(false);
    const pub = await published({ publishedAt: ago(5 * 24 * HOUR) });
    const out = await outside({ outsideAt: ago(5 * 24 * HOUR) });
    expect(await runMediaRetention(NOW)).toMatchObject({ skipped: "r2_not_configured" });
    expect((await db.post.findUniqueOrThrow({ where: { id: pub.id } })).videoKey).not.toBeNull();
    expect(await db.post.findUnique({ where: { id: out.id } })).not.toBeNull();
  });

  it("R2 silmesi başarısızsa iş yine tamamlanır, uyarı gider", async () => {
    vi.mocked(deleteObject).mockResolvedValue(false);
    const pub = await published({ publishedAt: ago(5 * 24 * HOUR) });
    const stats = await runMediaRetention(NOW);
    expect(stats).toMatchObject({ archived: 1, failed: 1 });
    expect((await db.post.findUniqueOrThrow({ where: { id: pub.id } })).videoKey).toBeNull();
    expect(sendAlert).toHaveBeenCalledWith("cron:media-retention:failed", expect.any(String), expect.anything());
  });

  it("beklenmeyen hata throw ETMEZ, uyarıya döner", async () => {
    vi.mocked(r2Configured).mockImplementation(() => {
      throw new Error("beklenmedik");
    });
    await expect(runMediaRetention(NOW)).resolves.toMatchObject({ error: true });
    expect(sendAlert).toHaveBeenCalledWith("cron:media-retention:crash", expect.any(String), expect.anything());
  });
});

describe("retentionDue", () => {
  it("saatin ilk 5 dakikası", () => {
    expect(retentionDue(new Date("2026-09-28T12:00:00Z"))).toBe(true);
    expect(retentionDue(new Date("2026-09-28T12:04:59Z"))).toBe(true);
    expect(retentionDue(new Date("2026-09-28T12:05:00Z"))).toBe(false);
    expect(retentionDue(new Date("2026-09-28T12:55:00Z"))).toBe(false);
  });
});
