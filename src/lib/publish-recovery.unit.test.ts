import { Prisma, type PublishStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  INTERRUPTED_AFTER_MS,
  interruptedDetail,
  isInterruptedPublish,
  orphanSlotRunAction,
} from "@/lib/publish-recovery";

/**
 * Kurtarma ağının karar mantığı — DB'siz. Sorgu ve yazmalar
 * `publish-post.test.ts` / `queue-db.test.ts`te gerçek Postgres'e karşı.
 */

const NOW = new Date("2026-11-01T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("isInterruptedPublish", () => {
  const post = (over: Partial<{ publishStatus: PublishStatus; igContainerId: string | null; updatedAt: Date }>) => ({
    publishStatus: "publishing" as PublishStatus,
    igContainerId: null,
    updatedAt: ago(11 * MIN),
    ...over,
  });

  it("publishing + container boş + 11 dk sessiz → takılı", () => {
    expect(isInterruptedPublish(post({}), NOW)).toBe(true);
  });

  it("eşik: 9 dk 59 sn → değil, tam 10 dk → takılı", () => {
    expect(isInterruptedPublish(post({ updatedAt: ago(INTERRUPTED_AFTER_MS - 1000) }), NOW)).toBe(false);
    expect(isInterruptedPublish(post({ updatedAt: ago(INTERRUPTED_AFTER_MS) }), NOW)).toBe(true);
  });

  it("container açılmışsa resumePublish'in işi → değil", () => {
    expect(isInterruptedPublish(post({ igContainerId: "17900000000000000" }), NOW)).toBe(false);
  });

  it("publishing olmayan hiçbir durum takılı sayılmaz", () => {
    for (const publishStatus of ["idle", "failed", "published", "scheduled", "skipped", "duplicate"] as PublishStatus[]) {
      expect(isInterruptedPublish(post({ publishStatus, updatedAt: ago(5 * HOUR) }), NOW)).toBe(false);
    }
  });
});

describe("orphanSlotRunAction", () => {
  const OLDER = 2 * HOUR;
  const run = (createdAt: Date, outcome: "published" | null = null) => ({ outcome, createdAt });

  it("sonuçsuz, 3 saatlik, postu yok → kapat", () => {
    expect(orphanSlotRunAction(run(ago(3 * HOUR)), null, NOW, OLDER)).toBe("close");
  });

  it("sonuçsuz, 3 saatlik, postu idle ya da failed → kapat", () => {
    expect(orphanSlotRunAction(run(ago(3 * HOUR)), { publishStatus: "idle" }, NOW, OLDER)).toBe("close");
    expect(orphanSlotRunAction(run(ago(3 * HOUR)), { publishStatus: "failed" }, NOW, OLDER)).toBe("close");
  });

  it("postu hâlâ publishing → bekle (sonucu sonuç kancası yazacak)", () => {
    expect(orphanSlotRunAction(run(ago(3 * HOUR)), { publishStatus: "publishing" }, NOW, OLDER)).toBe("keep");
  });

  it("eşik: 30 dakikalık → bekle, tam eşik → kapat", () => {
    expect(orphanSlotRunAction(run(ago(30 * MIN)), null, NOW, OLDER)).toBe("keep");
    expect(orphanSlotRunAction(run(ago(OLDER)), null, NOW, OLDER)).toBe("close");
  });

  it("sonucu yazılmış satıra dokunulmaz", () => {
    expect(orphanSlotRunAction(run(ago(5 * HOUR), "published"), null, NOW, OLDER)).toBe("keep");
  });
});

describe("interruptedDetail", () => {
  it("bağlantı kopması → veritabanı metni", () => {
    const error = new Prisma.PrismaClientKnownRequestError("x", { code: "P1017", clientVersion: "6.5.0" });
    expect(interruptedDetail(error)).toMatch(/^Veritabanı bağlantısı koptu/);
  });

  it("bilinmeyen hata → genel metin, hata sınıfının adıyla", () => {
    expect(interruptedDetail(new TypeError("y"))).toMatch(/^Beklenmeyen hata \(TypeError\)/);
  });

  it("ham hata metni sızmaz: bağlantı adresi ve token dönüşte yok", () => {
    const leaky = new Error(
      "connect postgresql://kullanici:gizli-sifre@ep-x.neon.tech/neondb failed; url?access_token=EAAGsirli"
    );
    const detail = interruptedDetail(leaky);
    expect(detail).not.toContain("gizli-sifre");
    expect(detail).not.toContain("EAAGsirli");
    expect(detail).not.toContain("postgresql://");
  });
});
