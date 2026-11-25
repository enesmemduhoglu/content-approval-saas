import { describe, expect, it } from "vitest";
import {
  compareAds,
  counterOnSave,
  dueAdSlots,
  needsReroll,
  pickNextAd,
  projectNextAd,
  rollGap,
  videosUntilAd,
  type AdItem,
  type AdSettings,
} from "@/lib/ads";
import type { QueueItem } from "@/lib/queue";
import { adRatioOk, validateAdCaption } from "@/lib/portal-validation";

// Saf fonksiyonlar — DB'ye dokunmaz, saat sabit.
const IST = "Europe/Istanbul";
// 2026-11-02 Pazartesi. İstanbul UTC+3: yerel 21:00 = 18:00Z.
const at = (iso: string) => new Date(iso);

function settings(over: Partial<AdSettings & { slots: string[] }> = {}) {
  return {
    slots: ["19:00"],
    timezone: IST,
    days: [1, 2, 3, 4, 5, 6, 7],
    paused: false,
    adsEnabled: true,
    adSlot: "21:00",
    adMinGap: 5,
    adMaxGap: 10,
    adNextAfter: 3,
    adCountFrom: null,
    ...over,
  };
}

function ad(id: string, over: Partial<AdItem> = {}): AdItem {
  return {
    id,
    status: "pending",
    publishStatus: "idle",
    createdAt: at("2026-11-01T10:00:00Z"),
    sourceName: `${id}.jpg`,
    adPosition: null,
    ...over,
  };
}

function video(id: string, position: number): QueueItem {
  return { id, queuePosition: position, captionStatus: "ready", status: "pending", publishStatus: "idle" };
}

describe("rollGap", () => {
  it("rand'ın iki ucunda aralığın iki ucunu verir, hep [min, max] içinde kalır", () => {
    expect(rollGap(5, 10, () => 0)).toBe(5);
    expect(rollGap(5, 10, () => 0.999)).toBe(10);
    expect(rollGap(5, 10, () => 1)).toBe(10); // rand 1 dönse bile taşmaz
    for (let i = 0; i < 200; i += 1) {
      const n = rollGap(5, 10);
      expect(n).toBeGreaterThanOrEqual(5);
      expect(n).toBeLessThanOrEqual(10);
    }
  });

  it("sabit modda (min = max) rand ne olursa olsun N", () => {
    expect(rollGap(5, 5, () => 0)).toBe(5);
    expect(rollGap(5, 5, () => 0.7)).toBe(5);
  });

  it("bozuk satır (min > max, 0) patlamaz", () => {
    expect(rollGap(10, 5, () => 0)).toBe(5);
    expect(rollGap(0, 0, () => 0.5)).toBe(1);
  });
});

describe("videosUntilAd / needsReroll", () => {
  it("hedefe ulaşınca 0, aşınca da 0", () => {
    expect(videosUntilAd(0, { adNextAfter: 3, adMinGap: 5 })).toBe(3);
    expect(videosUntilAd(3, { adNextAfter: 3, adMinGap: 5 })).toBe(0);
    expect(videosUntilAd(9, { adNextAfter: 3, adMinGap: 5 })).toBe(0);
  });

  it("hedef boşsa alt sınır kullanılır", () => {
    expect(videosUntilAd(0, { adNextAfter: null, adMinGap: 5 })).toBe(5);
  });

  it("hedef yeni aralığın dışındaysa yeniden çekilir", () => {
    expect(needsReroll(8, 5, 10)).toBe(false);
    expect(needsReroll(8, 3, 3)).toBe(true);
    expect(needsReroll(null, 5, 10)).toBe(true);
  });
});

describe("dueAdSlots", () => {
  it("pencere içindeki reklam saati döner, pencere dışı dönmez", () => {
    const s = settings();
    expect(dueAdSlots(s, at("2026-11-02T18:30:00Z"), []).map(String)).toEqual([
      String(at("2026-11-02T18:00:00Z")),
    ]);
    // 1 saatten geç: satır yazılmaz, reklam ertesi gün çıkar.
    expect(dueAdSlots(s, at("2026-11-02T19:01:00Z"), [])).toEqual([]);
    // Saatinden önce.
    expect(dueAdSlots(s, at("2026-11-02T17:59:00Z"), [])).toEqual([]);
  });

  it("zaten işlenmiş reklam saati dönmez", () => {
    expect(dueAdSlots(settings(), at("2026-11-02T18:10:00Z"), [at("2026-11-02T18:00:00Z")])).toEqual([]);
  });

  it("seçili olmayan günde reklam saati yok (video günleriyle aynı küme)", () => {
    expect(dueAdSlots(settings({ days: [2] }), at("2026-11-02T18:10:00Z"), [])).toEqual([]);
  });

  it("DST'li bölgede yerel saate oturur", () => {
    // Berlin 2026-03-29'da ileri alınıyor: o gün 21:00 = 19:00Z (önceki gün 20:00Z).
    const s = settings({ timezone: "Europe/Berlin" });
    expect(dueAdSlots(s, at("2026-03-29T19:10:00Z"), []).map((d) => d.toISOString())).toEqual([
      "2026-03-29T19:00:00.000Z",
    ]);
  });

  it("geçersiz reklam saati hiçbir şey üretmez", () => {
    expect(dueAdSlots(settings({ adSlot: "25:00" }), at("2026-11-02T18:10:00Z"), [])).toEqual([]);
  });
});

describe("pickNextAd", () => {
  it("yükleme sırası: önce createdAt, sonra dosya adı sayısal", () => {
    const sameMs = at("2026-11-01T10:00:00Z");
    const pool = [
      ad("c", { sourceName: "10.jpg", createdAt: sameMs }),
      ad("a", { sourceName: "2.jpg", createdAt: sameMs }),
      ad("b", { sourceName: "01.jpg", createdAt: at("2026-11-01T11:00:00Z") }),
    ];
    expect(pickNextAd(pool)?.id).toBe("a");
  });

  it("failed, published, publishing ve draft atlanır", () => {
    const pool = [
      ad("1", { publishStatus: "failed" }),
      ad("2", { publishStatus: "published", status: "approved" }),
      ad("3", { publishStatus: "publishing", status: "approved" }),
      ad("4", { status: "draft" }),
      ad("5", { sourceName: "9.jpg" }),
    ];
    expect(pickNextAd(pool)?.id).toBe("5");
    expect(pickNextAd(pool.slice(0, 4))).toBeNull();
  });
});

describe("projectNextAd", () => {
  const now = at("2026-11-02T06:00:00Z"); // Pazartesi 09:00
  const queue = [video("v1", 1), video("v2", 2), video("v3", 3)];

  it("hedefe 2 video kaldıysa 2. videonun gününün reklam saati", () => {
    const p = projectNextAd({ settings: settings(), queue, publishedSince: 1, poolSize: 5, now });
    // v1 Pzt 19:00, v2 Sal 19:00 → reklam Sal 21:00.
    expect(p).toEqual({ videosLeft: 2, at: at("2026-11-03T18:00:00Z") });
  });

  it("hedefe ulaşılmışsa sıradaki reklam saati", () => {
    const p = projectNextAd({ settings: settings(), queue, publishedSince: 3, poolSize: 5, now });
    expect(p).toEqual({ videosLeft: 0, at: at("2026-11-02T18:00:00Z") });
  });

  it("reklam saati video saatinden önceyse ertesi güne kayar", () => {
    const p = projectNextAd({
      settings: settings({ adSlot: "12:00", adNextAfter: 1 }),
      queue,
      publishedSince: 0,
      poolSize: 5,
      now,
    });
    // v1 Pzt 19:00 → Pzt 12:00 geçmiş, reklam Sal 12:00.
    expect(p?.at?.toISOString()).toBe("2026-11-03T09:00:00.000Z");
  });

  it("kuyrukta yeterli video yoksa tarih yok", () => {
    const p = projectNextAd({
      settings: settings({ adNextAfter: 5 }),
      queue,
      publishedSince: 0,
      poolSize: 5,
      now,
    });
    expect(p).toEqual({ videosLeft: 5, at: null });
  });

  it("kapalı, duraklatılmış ya da havuz boşsa null", () => {
    const base = { queue, publishedSince: 0, now };
    expect(projectNextAd({ ...base, settings: settings({ adsEnabled: false }), poolSize: 5 })).toBeNull();
    expect(projectNextAd({ ...base, settings: settings({ paused: true }), poolSize: 5 })).toBeNull();
    expect(projectNextAd({ ...base, settings: settings(), poolSize: 0 })).toBeNull();
  });
});

describe("counterOnSave", () => {
  const now = at("2026-11-02T10:00:00Z");
  const rand = () => 0;

  it("kapalıdan açığa: sayaç şimdi başlar, hedef çekilir", () => {
    expect(
      counterOnSave({ adsEnabled: false, adNextAfter: null }, { adsEnabled: true, adMinGap: 4, adMaxGap: 9 }, now, rand)
    ).toEqual({ adCountFrom: now, adNextAfter: 4 });
  });

  it("açıkken hedef yeni aralıktaysa hiçbir şey değişmez", () => {
    expect(
      counterOnSave({ adsEnabled: true, adNextAfter: 7 }, { adsEnabled: true, adMinGap: 5, adMaxGap: 10 }, now)
    ).toEqual({});
  });

  it("açıkken aralık değişip hedef dışarıda kaldıysa yalnızca hedef çekilir (sayaç korunur)", () => {
    expect(
      counterOnSave({ adsEnabled: true, adNextAfter: 8 }, { adsEnabled: true, adMinGap: 3, adMaxGap: 3 }, now)
    ).toEqual({ adNextAfter: 3 });
  });

  it("kapatmak sayaca dokunmaz", () => {
    expect(
      counterOnSave({ adsEnabled: true, adNextAfter: 8 }, { adsEnabled: false, adMinGap: 5, adMaxGap: 10 }, now)
    ).toEqual({});
  });
});

describe("adRatioOk / validateAdCaption", () => {
  it("4:5 dikey ve 1.91:1 yatay uçlar dahil, ötesi hariç", () => {
    expect(adRatioOk(2160, 2700)).toBe(true);
    expect(adRatioOk(1080, 1080)).toBe(true);
    expect(adRatioOk(1910, 1000)).toBe(true);
    expect(adRatioOk(1080, 1920)).toBe(false); // 9:16 hikâye
    expect(adRatioOk(2000, 1000)).toBe(false);
    expect(adRatioOk(0, 100)).toBe(false);
  });

  it("boş metin yalnızca zorunlu değilken geçer", () => {
    expect(validateAdCaption("  ", { required: false })).toEqual({ ok: true, caption: "" });
    expect(validateAdCaption(undefined, { required: true }).ok).toBe(false);
    expect(validateAdCaption(42, { required: false }).ok).toBe(false);
  });
});

describe("compareAds / pickNextAd — portalda verilen sıra (V12c)", () => {
  it("adPosition önce gelir, konumsuzlar sona (yükleme sırasıyla)", () => {
    const early = at("2026-11-01T09:00:00Z");
    const pool = [
      ad("eski", { createdAt: early }), // konumsuz ama en eski
      ad("b", { adPosition: 2048 }),
      ad("a", { adPosition: 1024 }),
      ad("yeni", { createdAt: at("2026-11-01T12:00:00Z") }),
    ];
    expect([...pool].sort(compareAds).map((x) => x.id)).toEqual(["a", "b", "eski", "yeni"]);
  });

  it("eşit konumda yükleme sırası yedeği", () => {
    const pool = [ad("2", { adPosition: 5, sourceName: "10.jpg" }), ad("1", { adPosition: 5, sourceName: "2.jpg" })];
    expect([...pool].sort(compareAds).map((x) => x.id)).toEqual(["1", "2"]);
  });

  it("taşınmış reklam sıradaki olur", () => {
    const pool = [ad("01", { adPosition: 1024 }), ad("02", { adPosition: 2048 }), ad("50", { adPosition: 512 })];
    expect(pickNextAd(pool)?.id).toBe("50");
  });
});
