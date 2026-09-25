import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/storage-r2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage-r2")>();
  return {
    ...actual,
    r2Configured: vi.fn(() => true),
    deleteObject: vi.fn(async () => true),
    abortMultipartUpload: vi.fn(async () => undefined),
  };
});
vi.mock("@/lib/alerts", () => ({ sendAlert: vi.fn(async () => undefined) }));
// Cron'un geri kalanı (hatırlatma, kuyruk özeti) bu dosyanın konusu değil.
vi.mock("@/lib/queue-digest", () => ({ runQueueDigest: vi.fn(async () => ({ clients: 0 })) }));

import { db } from "@/lib/db";
import { sendAlert } from "@/lib/alerts";
import { abortMultipartUpload, deleteObject, r2Configured } from "@/lib/storage-r2";
import { cleanupStaleDrafts, STALE_DRAFT_MS } from "@/lib/draft-cleanup";
import { GET as pendingRemindersCron } from "@/app/api/cron/pending-reminders/route";
import { createAgency, createClient, resetDb } from "@tests/helpers/db";
import { createPortalPost } from "@tests/helpers/portal";

const NOW = new Date("2026-09-26T09:00:00Z");
const old = new Date(NOW.getTime() - STALE_DRAFT_MS - 60_000);
const fresh = new Date(NOW.getTime() - STALE_DRAFT_MS + 60 * 60_000);

let agencyId: string;
let clientId: string;

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  vi.mocked(r2Configured).mockReturnValue(true);
  vi.mocked(abortMultipartUpload).mockResolvedValue(undefined);
  const agency = await createAgency();
  agencyId = agency.id;
  clientId = (await createClient(agency.id)).id;
});

async function draft(opts: { createdAt: Date; uploadId?: string | null; status?: "draft" | "pending" }) {
  const post = await createPortalPost(agencyId, clientId, {
    status: opts.status ?? "draft",
    queuePosition: opts.status === "pending" ? 1 : null,
    frameKeys: [],
  });
  return db.post.update({
    where: { id: post.id },
    data: { createdAt: opts.createdAt, uploadId: opts.uploadId ?? null },
  });
}

describe("cleanupStaleDrafts", () => {
  it("24 saatten eski taslak: çok parçalı yükleme iptal, nesneler silinir, satır silinir", async () => {
    const stale = await draft({ createdAt: old, uploadId: "r2-id" });
    const stats = await cleanupStaleDrafts(NOW);

    expect(abortMultipartUpload).toHaveBeenCalledWith(stale.videoKey, "r2-id");
    const deleted = vi.mocked(deleteObject).mock.calls.map(([key]) => key);
    expect(deleted).toContain(stale.videoKey);
    expect(deleted).toContain(`clients/${clientId}/frames/${stale.id}/0.jpg`);
    expect(deleted).toHaveLength(7);
    expect(await db.post.findUnique({ where: { id: stale.id } })).toBeNull();
    expect(stats).toMatchObject({ checked: 1, deleted: 1, aborted: 1, failed: 0 });
  });

  it("tek PUT taslağında (uploadId yok) iptal çağrılmaz ama nesneler ve satır gider", async () => {
    const stale = await draft({ createdAt: old });
    await cleanupStaleDrafts(NOW);
    expect(abortMultipartUpload).not.toHaveBeenCalled();
    expect(deleteObject).toHaveBeenCalledWith(stale.videoKey);
    expect(await db.post.findUnique({ where: { id: stale.id } })).toBeNull();
  });

  it("taze taslağa, tamamlanmış videoya ve ajans postuna dokunmaz", async () => {
    const young = await draft({ createdAt: fresh, uploadId: "taze" });
    const completed = await draft({ createdAt: old, status: "pending" });
    const agencyDraft = await draft({ createdAt: old, uploadId: "ajans" });
    await db.post.update({ where: { id: agencyDraft.id }, data: { source: "agency" } });

    const stats = await cleanupStaleDrafts(NOW);
    expect(stats.checked).toBe(0);
    expect(abortMultipartUpload).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
    for (const id of [young.id, completed.id, agencyDraft.id]) {
      expect(await db.post.findUnique({ where: { id } })).not.toBeNull();
    }
  });

  it("iptal başarısızsa taslak SİLİNMEZ (kimlik kaybolmasın), uyarı gider, diğerleri sürer", async () => {
    const failing = await draft({ createdAt: old, uploadId: "patlayan" });
    const ok = await draft({ createdAt: old, uploadId: "saglam" });
    vi.mocked(abortMultipartUpload).mockImplementation(async (_key, uploadId) => {
      if (uploadId === "patlayan") throw new Error("R2 500");
    });

    const stats = await cleanupStaleDrafts(NOW);
    expect(stats).toMatchObject({ checked: 2, deleted: 1, failed: 1 });
    expect(await db.post.findUnique({ where: { id: failing.id } })).not.toBeNull();
    expect(await db.post.findUnique({ where: { id: ok.id } })).toBeNull();
    expect(sendAlert).toHaveBeenCalledWith("cron:draft-cleanup:failed", expect.any(String), expect.anything());
  });

  it("R2 yapılandırılmamışsa hiçbir şey silinmez", async () => {
    vi.mocked(r2Configured).mockReturnValue(false);
    const stale = await draft({ createdAt: old, uploadId: "r2-id" });
    expect(await cleanupStaleDrafts(NOW)).toMatchObject({ skipped: "r2_not_configured" });
    expect(await db.post.findUnique({ where: { id: stale.id } })).not.toBeNull();
  });

  it("beklenmeyen hata throw ETMEZ, uyarıya döner", async () => {
    vi.mocked(r2Configured).mockImplementation(() => {
      throw new Error("beklenmedik");
    });
    await expect(cleanupStaleDrafts(NOW)).resolves.toMatchObject({ error: true });
    expect(sendAlert).toHaveBeenCalledWith("cron:draft-cleanup:crash", expect.any(String), expect.anything());
  });
});

describe("günlük cron'a bağlı", () => {
  it("pending-reminders koşusu eski taslakları temizler ve sayıları yanıtta döner", async () => {
    const previous = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "c".repeat(40);
    try {
      const stale = await draft({ createdAt: new Date(Date.now() - STALE_DRAFT_MS - 60_000), uploadId: "r2-id" });
      const res = await pendingRemindersCron(
        new Request("http://localhost/api/cron/pending-reminders", {
          headers: { authorization: `Bearer ${"c".repeat(40)}` },
        })
      );
      expect(res.status).toBe(200);
      expect((await res.json()).draftCleanup).toMatchObject({ deleted: 1, aborted: 1 });
      expect(abortMultipartUpload).toHaveBeenCalledWith(stale.videoKey, "r2-id");
    } finally {
      if (previous === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previous;
    }
  });
});
