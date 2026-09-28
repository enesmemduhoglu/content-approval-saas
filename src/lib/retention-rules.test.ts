import { describe, expect, it } from "vitest";
import {
  OUTSIDE_TTL_MS,
  PUBLISHED_VIDEO_TTL_MS,
  calendarDaysUntil,
  deletionLabel,
  outsideDeletesAt,
  videoArchivesAt,
  videoStaysLabel,
} from "@/lib/retention-rules";

const IST = "Europe/Istanbul";

describe("saklama süreleri", () => {
  it("kuyruk dışı 3 gün, yayınlanan video 2 gün", () => {
    expect(OUTSIDE_TTL_MS).toBe(3 * 86_400_000);
    expect(PUBLISHED_VIDEO_TTL_MS).toBe(2 * 86_400_000);
  });

  it("outsideDeletesAt: kuyruk dışında değilse null", () => {
    expect(outsideDeletesAt(null)).toBeNull();
    expect(outsideDeletesAt(new Date("2026-09-28T12:00:00Z"))).toEqual(new Date("2026-10-01T12:00:00Z"));
  });

  it("videoArchivesAt: publishedAt yoksa updatedAt'e düşer (duplicate)", () => {
    const updated = new Date("2026-09-28T10:00:00Z");
    expect(videoArchivesAt(new Date("2026-09-27T16:00:00Z"), updated)).toEqual(new Date("2026-09-29T16:00:00Z"));
    expect(videoArchivesAt(null, updated)).toEqual(new Date("2026-09-30T10:00:00Z"));
  });
});

describe("calendarDaysUntil", () => {
  it("Pazartesi 15:00 reddedilen video: Pzt 3, Sal 2, Çar yarın, Per bugün", () => {
    const rejected = new Date("2026-09-28T12:00:00Z"); // Pzt 15:00 İstanbul
    const deletesAt = outsideDeletesAt(rejected)!;
    expect(calendarDaysUntil(deletesAt, rejected, IST)).toBe(3);
    expect(calendarDaysUntil(deletesAt, new Date("2026-09-29T06:00:00Z"), IST)).toBe(2);
    expect(calendarDaysUntil(deletesAt, new Date("2026-09-30T20:00:00Z"), IST)).toBe(1);
    expect(calendarDaysUntil(deletesAt, new Date("2026-10-01T05:00:00Z"), IST)).toBe(0);
  });

  it("takvim günü müşterinin saat diliminde: UTC'de aynı gün, İstanbul'da ertesi gün", () => {
    // 22:30 UTC = 01:30 İstanbul (ertesi gün). UTC'ye göre sayılsaydı 1 gün çıkardı.
    const now = new Date("2026-09-28T22:30:00Z");
    const at = new Date("2026-09-29T20:00:00Z"); // 23:00 İstanbul, 29 Eyl
    expect(calendarDaysUntil(at, now, IST)).toBe(0);
    expect(calendarDaysUntil(at, now, "UTC")).toBe(1);
  });

  it("geçmiş an 0'a sabitlenir (temizlik henüz koşmadıysa 'bugün')", () => {
    expect(calendarDaysUntil(new Date("2026-09-20T00:00:00Z"), new Date("2026-09-28T00:00:00Z"), IST)).toBe(0);
  });
});

describe("metinler", () => {
  it("deletionLabel", () => {
    expect(deletionLabel(3)).toBe("3 gün sonra silinecek");
    expect(deletionLabel(2)).toBe("2 gün sonra silinecek");
    expect(deletionLabel(1)).toBe("Yarın silinecek");
    expect(deletionLabel(0)).toBe("Bugün silinecek");
  });

  it("videoStaysLabel", () => {
    expect(videoStaysLabel(2)).toBe("Video 2 gün daha burada");
    expect(videoStaysLabel(1)).toBe("Video 1 gün daha burada");
    expect(videoStaysLabel(0)).toBe("Video bugün kaldırılacak");
  });
});
