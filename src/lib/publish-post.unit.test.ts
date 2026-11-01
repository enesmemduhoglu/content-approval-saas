import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Asla throw etmez" sözünün sarmalayıcısı — Postgres'e gidilmez. DB katmanı
 * 2026-11-01'deki hatayla (P1017) patlatılır; gerçek DB'de kısmi kopmanın
 * senaryoları `publish-post.test.ts`te.
 */
vi.mock("@/lib/db", () => ({
  db: { post: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() } },
}));
vi.mock("@/lib/alerts", () => ({ sendAlert: vi.fn(async () => undefined) }));

import { db } from "@/lib/db";
import { sendAlert } from "@/lib/alerts";
import { publishApprovedPost, resumePublish } from "@/lib/publish-post";

const RAW = "Invalid `prisma.post.findUnique()` invocation:\n\nServer has closed the connection.";
const connectionLost = () =>
  new Prisma.PrismaClientKnownRequestError(RAW, { code: "P1017", clientVersion: "6.5.0" });

const findUnique = vi.mocked(db.post.findUnique);
const alert = vi.mocked(sendAlert);

beforeEach(() => {
  findUnique.mockReset();
  alert.mockReset();
  alert.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("neverThrows sarmalayıcısı", () => {
  it("publishApprovedPost: DB koparsa resolve eder, sonuç 'publishing' (kurtarma ağına bırakılır)", async () => {
    findUnique.mockRejectedValue(connectionLost());
    await expect(publishApprovedPost("post-1")).resolves.toMatchObject({ publishStatus: "publishing" });
  });

  it("resumePublish: DB koparsa resolve eder, sonuç 'publishing'", async () => {
    findUnique.mockRejectedValue(connectionLost());
    await expect(resumePublish("post-1")).resolves.toMatchObject({ publishStatus: "publishing" });
  });

  it("operatöre tek uyarı: sabit anahtar, postId ve sırsız metin — ham Prisma metni yok", async () => {
    findUnique.mockRejectedValue(connectionLost());
    await publishApprovedPost("post-1");

    expect(alert).toHaveBeenCalledTimes(1);
    const [key, , payload] = alert.mock.calls[0];
    expect(key).toBe("publish:interrupted");
    expect(payload).toMatchObject({
      postId: "post-1",
      detail: expect.stringMatching(/^Veritabanı bağlantısı koptu/),
    });
    expect(JSON.stringify(payload)).not.toContain("prisma.post.findUnique");
  });

  it("uyarının kendisi reject etse bile sarmalayıcı resolve eder", async () => {
    findUnique.mockRejectedValue(connectionLost());
    alert.mockRejectedValue(new Error("Resend de düştü"));
    await expect(publishApprovedPost("post-1")).resolves.toMatchObject({ publishStatus: "publishing" });
  });
});
