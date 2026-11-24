import { describe, expect, it } from "vitest";
import {
  STORAGE_QUOTA_BYTES,
  TYPICAL_POST_BYTES,
  averagePostBytes,
  formatStorage,
  storageView,
  uploadBlockedReason,
} from "@/lib/storage-usage";

const GB = 1000 ** 3;
const MB = 1000 ** 2;

/** 19 video × ~73,7 MB + kareler: 29 Eyl'deki gerçek tablo. */
const bugun = { totalBytes: 1_403_500_000, videoBytes: 1_400_430_000, videoCount: 19, frameBytes: 3_070_000 };

describe("formatStorage", () => {
  it("GB bir ondalık, Türkçe virgülle; 1 GB altı MB", () => {
    expect(formatStorage(1.4 * GB)).toBe("1,4 GB");
    expect(formatStorage(10 * GB)).toBe("10,0 GB");
    expect(formatStorage(940 * MB)).toBe("940 MB");
    expect(formatStorage(0)).toBe("0 MB");
  });
});

describe("averagePostBytes", () => {
  it("üç videodan az örnekte sabit ortalama", () => {
    expect(averagePostBytes({ totalBytes: 26 * MB, videoBytes: 26 * MB, videoCount: 1, frameBytes: 0 })).toBe(
      TYPICAL_POST_BYTES
    );
  });

  it("yeterli örnekte video + kare / video sayısı", () => {
    expect(averagePostBytes(bugun)).toBeCloseTo((1_400_430_000 + 3_070_000) / 19);
  });
});

describe("storageView", () => {
  it("bugünkü kullanım: 1,4 GB / 9 GB, ~102 video", () => {
    const view = storageView(bugun);
    expect(view.usedLabel).toBe("1,4 GB");
    expect(view.quotaLabel).toBe("9 GB");
    expect(view.level).toBe("ok");
    expect(view.percent).toBe(15.6);
    expect(view.videosLeft).toBe(Math.floor((STORAGE_QUOTA_BYTES - bugun.totalBytes) / averagePostBytes(bugun)));
    expect(view.line).toBe(`Yaklaşık ${view.videosLeft} video daha sığar`);
  });

  it("boş depolamada sabit ortalamayla sayar", () => {
    const view = storageView({ totalBytes: 0, videoBytes: 0, videoCount: 0, frameBytes: 0 });
    expect(view.usedLabel).toBe("0 MB");
    expect(view.videosLeft).toBe(Math.floor(STORAGE_QUOTA_BYTES / TYPICAL_POST_BYTES));
  });

  it("%80 ve üstü: yer azalıyor", () => {
    const view = storageView({ ...bugun, totalBytes: 7.3 * GB });
    expect(view.level).toBe("warn");
    expect(view.line).toMatch(/^Yer azalıyor · yaklaşık \d+ video daha sığar$/);
  });

  it("%79,9: henüz uyarı yok", () => {
    expect(storageView({ ...bugun, totalBytes: 7.19 * GB }).level).toBe("ok");
  });

  it("bir video bile sığmıyorsa kota dolmadan 'doldu'", () => {
    const view = storageView({ ...bugun, totalBytes: 8.97 * GB });
    expect(view.videosLeft).toBe(0);
    expect(view.level).toBe("full");
    expect(view.line).toBe("Yer doldu, yeni video yüklenemez. Kuyruk dışındaki videoları silebilirsin.");
  });

  it("kota aşılınca çubuk %100'de durur, kalan 0", () => {
    const view = storageView({ ...bugun, totalBytes: 12 * GB });
    expect(view.percent).toBe(100);
    expect(view.videosLeft).toBe(0);
    expect(view.level).toBe("full");
  });

  it("aşağı yuvarlar: tam sığmayan video sayılmaz", () => {
    const view = storageView({ totalBytes: STORAGE_QUOTA_BYTES - 150 * MB - 1, videoBytes: 0, videoCount: 0, frameBytes: 0 });
    expect(view.videosLeft).toBe(2);
  });
});

describe("uploadBlockedReason — depolama tavanı (K35)", () => {
  it("kota 9 GB: ücretsiz katmanın 1 GB altı", () => {
    expect(STORAGE_QUOTA_BYTES).toBe(9 * GB);
  });

  it("sığan seçim geçer — tam sınıra kadar dahil", () => {
    expect(uploadBlockedReason(1 * GB, 50 * 150 * MB)).toBeNull();
    expect(uploadBlockedReason(STORAGE_QUOTA_BYTES - 150 * MB, 150 * MB)).toBeNull();
  });

  it("bir bayt aşan seçim reddedilir, boş yeri ve seçimi söyler", () => {
    expect(uploadBlockedReason(STORAGE_QUOTA_BYTES - 150 * MB, 150 * MB + 1)).toBe(
      "Seçtiğin videolar depolamaya sığmıyor: 150 MB boş yer var, seçim 150 MB. Daha az video seç."
    );
    expect(uploadBlockedReason(8 * GB, 2 * GB)).toBe(
      "Seçtiğin videolar depolamaya sığmıyor: 1,0 GB boş yer var, seçim 2,0 GB. Daha az video seç."
    );
  });

  it("doluysa — ya da aşılmışsa — 'doldu' der", () => {
    const full = "Depolama alanı doldu (9 GB). Yeni video yüklemek için kuyruk dışındaki videoları silebilirsin.";
    expect(uploadBlockedReason(STORAGE_QUOTA_BYTES, 1)).toBe(full);
    expect(uploadBlockedReason(9.5 * GB, 10 * MB)).toBe(full);
  });
});
