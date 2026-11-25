import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/storage-r2", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage-r2")>()),
  r2Configured: () => true,
  signDisplayUrl: vi.fn(async (key: string) => `https://r2.test/${key}`),
}));

import {
  adProjectionText,
  toAdCards,
  toAdSettingsView,
  AD_SETTINGS_DEFAULTS,
  DEFAULT_AD_CAPTION,
} from "@/lib/portal-ads";
import { validateAdCaption } from "@/lib/portal-validation";
import type { PublishSettings } from "@prisma/client";

const IST = "Europe/Istanbul";
const CLIENT = "c1";
let n = 0;
function row(over: Record<string, unknown> = {}) {
  n += 1;
  return {
    id: `a${n}`,
    caption: "",
    status: "pending" as const,
    publishStatus: "idle" as const,
    publishError: null,
    igPermalink: null,
    publishedAt: null as Date | null,
    imageKey: `clients/${CLIENT}/ads/a${n}.jpg`,
    sourceName: `${String(n).padStart(2, "0")}.jpg`,
    createdAt: new Date("2026-11-01T10:00:00Z"),
    adPosition: null as number | null,
    ...over,
  };
}

describe("toAdCards", () => {
  it("havuz yükleme sırasıyla; ilk uygun 'next', hata alan havuzda kalır, yayınlananlar ayrı", async () => {
    const failed = row({ sourceName: "01.jpg", publishStatus: "failed" });
    const first = row({ sourceName: "02.jpg" });
    const second = row({ sourceName: "10.jpg" });
    const old = row({ publishStatus: "published", publishedAt: new Date("2026-11-01T18:00:00Z") });
    const fresh = row({ publishStatus: "published", publishedAt: new Date("2026-11-10T18:00:00Z") });

    const { pool, published } = await toAdCards([second, old, first, fresh, failed], CLIENT);
    expect(pool.map((c) => [c.id, c.state])).toEqual([
      [failed.id, "failed"],
      [first.id, "next"],
      [second.id, "queued"],
    ]);
    expect(published.map((c) => c.id)).toEqual([fresh.id, old.id]);
    expect(pool[1].coverUrl).toBe(`https://r2.test/${first.imageKey}`);
  });

  it("başka müşterinin önekindeki anahtar imzalanmaz", async () => {
    const { pool } = await toAdCards([row({ imageKey: "clients/baska/ads/x.jpg" })], CLIENT);
    expect(pool[0].coverUrl).toBeNull();
  });
});

describe("adProjectionText", () => {
  const now = new Date("2026-11-02T06:00:00Z"); // Pazartesi 09:00
  it("video sayısı + gün/saat", () => {
    expect(adProjectionText({ videosLeft: 3, at: new Date("2026-11-05T18:00:00Z") }, IST, now)).toBe(
      "3 video sonra · Perşembe · 21:00"
    );
  });
  it("hedefe ulaşılmışsa yalnızca zaman", () => {
    expect(adProjectionText({ videosLeft: 0, at: new Date("2026-11-02T18:00:00Z") }, IST, now)).toBe(
      "Bugün · 21:00"
    );
  });
  it("tarih bilinmiyorsa yalnızca video sayısı", () => {
    expect(adProjectionText({ videosLeft: 4, at: null }, IST, now)).toBe("4 video sonra");
  });
});

describe("toAdSettingsView", () => {
  it("ayar yoksa varsayılanlar (kapalı)", () => {
    expect(toAdSettingsView(null)).toEqual(AD_SETTINGS_DEFAULTS);
  });
});

describe("varsayılan reklam metni (V12c)", () => {
  it("kayıtlı metin yoksa alan dolu gelir; kaydedilmiş metin aynen kalır", () => {
    expect(AD_SETTINGS_DEFAULTS.adCaption).toBe(DEFAULT_AD_CAPTION);
    const row = { adsEnabled: false, adSlot: "21:00", adMinGap: 5, adMaxGap: 10 } as PublishSettings;
    expect(toAdSettingsView({ ...row, adCaption: null }).adCaption).toBe(DEFAULT_AD_CAPTION);
    expect(toAdSettingsView({ ...row, adCaption: "Kendi metnim" }).adCaption).toBe("Kendi metnim");
  });

  it("varsayılan metin reklam doğrulamasından geçer (≤ 2000 karakter, ≤ 30 hashtag)", () => {
    expect(validateAdCaption(DEFAULT_AD_CAPTION, { required: true })).toEqual({
      ok: true,
      caption: DEFAULT_AD_CAPTION,
    });
    expect(DEFAULT_AD_CAPTION).toContain("%50");
    expect(DEFAULT_AD_CAPTION).toContain('"DERS"');
  });
});
