import { describe, expect, it } from "vitest";
import {
  STORAGE_QUOTA_BYTES,
  TYPICAL_POST_BYTES,
  averagePostBytes,
  formatStorage,
  storageView,
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
  it("bugünkü kullanım: 1,4 GB / 10 GB, ~115 video", () => {
    const view = storageView(bugun);
    expect(view.usedLabel).toBe("1,4 GB");
    expect(view.quotaLabel).toBe("10 GB");
    expect(view.level).toBe("ok");
    expect(view.percent).toBe(14);
    expect(view.videosLeft).toBe(Math.floor((STORAGE_QUOTA_BYTES - bugun.totalBytes) / averagePostBytes(bugun)));
    expect(view.line).toBe(`Yaklaşık ${view.videosLeft} video daha sığar`);
  });

  it("boş depolamada sabit ortalamayla sayar", () => {
    const view = storageView({ totalBytes: 0, videoBytes: 0, videoCount: 0, frameBytes: 0 });
    expect(view.usedLabel).toBe("0 MB");
    expect(view.videosLeft).toBe(Math.floor(STORAGE_QUOTA_BYTES / TYPICAL_POST_BYTES));
  });

  it("%80 ve üstü: yer azalıyor", () => {
    const view = storageView({ ...bugun, totalBytes: 8.6 * GB });
    expect(view.level).toBe("warn");
    expect(view.line).toMatch(/^Yer azalıyor · yaklaşık \d+ video daha sığar$/);
  });

  it("%79,9: henüz uyarı yok", () => {
    expect(storageView({ ...bugun, totalBytes: 7.99 * GB }).level).toBe("ok");
  });

  it("bir video bile sığmıyorsa kota dolmadan 'doldu'", () => {
    const view = storageView({ ...bugun, totalBytes: 9.97 * GB });
    expect(view.videosLeft).toBe(0);
    expect(view.level).toBe("full");
    expect(view.line).toBe("Yer doldu. Kuyruk dışındaki videoları silebilirsin.");
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
