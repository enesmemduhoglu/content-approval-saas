import { describe, expect, it } from "vitest";
import { estimatePublishTimes, queueRunway } from "./portal-schedule";
import type { QueueItem } from "./queue";

// Saf — DB yok. `queue.test.ts`teki desen: anlar açık UTC ile yazılıyor ki
// test makinenin saat dilimine bağlı olmasın; `item` oradaki yardımcının
// aynısı (test dosyasını import etmek onun testlerini de buraya taşırdı).
// Takvim: 25 Eylül 2026 Cuma. İstanbul = UTC+3, DST yok.
const utc = (iso: string) => new Date(iso);
const TZ = "Europe/Istanbul";

function item(overrides: Partial<QueueItem> & { id: string }): QueueItem {
  return {
    queuePosition: 1,
    captionStatus: "ready",
    status: "approved",
    publishStatus: "idle",
    ...overrides,
  };
}

/** `n` video, sırayla; `pick(i)` i. videonun alanlarını değiştirir. */
function queueOf(n: number, pick: (i: number) => Partial<QueueItem> = () => ({})): QueueItem[] {
  return Array.from({ length: n }, (_, i) =>
    item({ id: `v${String(i + 1).padStart(2, "0")}`, queuePosition: i + 1, ...pick(i) })
  );
}

const TWICE = {
  slots: ["12:00", "19:00"],
  timezone: TZ,
  days: [] as number[],
  paused: false,
};

describe("queueRunway — gün sayısı (bugün dahil, yerel takvim günü)", () => {
  it("günde 2 slot + 20 hazır video, şu an 10:00 → 10 gün; son yayın 10. günün 19:00'u", () => {
    const now = utc("2026-09-25T07:00:00Z"); // Cuma 10:00
    const runway = queueRunway(queueOf(20), TWICE, now);
    expect(runway).toEqual({
      runway: {
        count: 20,
        lastAt: utc("2026-10-04T16:00:00Z"), // Paz 4 Eki 19:00
        days: 10,
        emptyFrom: utc("2026-10-05T09:00:00Z"), // ertesi gün 12:00
      },
      nextSlotAt: utc("2026-09-25T09:00:00Z"),
    });
  });

  it("bugünün 12:00'si geçmişse (13:00) aynı 20 video bir gün daha uzağa yeter → 11 gün", () => {
    const now = utc("2026-09-25T10:00:00Z"); // Cuma 13:00
    const runway = queueRunway(queueOf(20), TWICE, now);
    // Bugün yalnız 19:00 → 1, sonraki 9 gün → 18, 11. gün 12:00 → 20.
    expect(runway?.runway).toEqual({
      count: 20,
      lastAt: utc("2026-10-05T09:00:00Z"),
      days: 11,
      emptyFrom: utc("2026-10-05T16:00:00Z"),
    });
    expect(runway?.nextSlotAt).toEqual(utc("2026-09-25T16:00:00Z"));
  });

  it("bugünün slotları bittiyse (20:00) ilk yayın yarın, bugün yine sayılır → 11 gün", () => {
    const now = utc("2026-09-25T17:00:00Z"); // Cuma 20:00
    const runway = queueRunway(queueOf(20), TWICE, now);
    expect(runway?.runway?.lastAt).toEqual(utc("2026-10-05T16:00:00Z"));
    expect(runway?.runway?.days).toBe(11);
    expect(runway?.nextSlotAt).toEqual(utc("2026-09-26T09:00:00Z"));
  });

  it("slot anındaki video tick'e ait sayılır — tam 12:00'de bakınca o slot takvimde yok", () => {
    const now = utc("2026-09-25T09:00:00Z"); // tam 12:00
    const runway = queueRunway(queueOf(1), TWICE, now);
    expect(runway?.runway?.lastAt).toEqual(utc("2026-09-25T16:00:00Z"));
    expect(runway?.runway?.days).toBe(1);
  });

  it("yalnız hafta içi: hafta sonu atlanır ama takvim günü olarak sayılır", () => {
    const settings = { ...TWICE, slots: ["19:00"], days: [1, 2, 3, 4, 5] };
    const now = utc("2026-09-25T07:00:00Z"); // Cuma 10:00
    // 6 video: Cum 25, Pzt 28, Sal 29, Çar 30, Per 1, Cum 2.
    const runway = queueRunway(queueOf(6), settings, now);
    expect(runway?.runway).toEqual({
      count: 6,
      lastAt: utc("2026-10-02T16:00:00Z"),
      days: 8, // 25 Eyl – 2 Eki, aradaki hafta sonu dahil
      emptyFrom: utc("2026-10-05T16:00:00Z"), // Cmt/Paz değil, Pazartesi
    });
  });
});

describe("queueRunway — hangi video sayılır (K33: onay yok)", () => {
  const now = utc("2026-09-25T07:00:00Z"); // Cuma 10:00

  it("bekleyen (onaysız) video da sayılır — sırası gelince tick onu da yayınlar", () => {
    const queue = queueOf(10, (i) => (i % 2 === 1 ? { status: "pending" } : {}));
    const runway = queueRunway(queue, TWICE, now);
    expect(runway?.runway?.count).toBe(10);
    expect(runway?.runway?.days).toBe(5);
  });

  it("reddedilmiş (K33 öncesi) ve caption'ı hazır olmayan video takvime girmez", () => {
    const queue = queueOf(4, (i) =>
      i === 0 ? { status: "rejected" } : i === 1 ? { captionStatus: "generating" } : {}
    );
    const runway = queueRunway(queue, TWICE, now);
    expect(runway?.runway?.count).toBe(2);
  });

  it("yayını patlamış (failed) video sayılmaz — onu 'tekrar dene' kurtarır", () => {
    const queue = queueOf(4, (i) => (i === 3 ? { status: "pending", publishStatus: "failed" } : {}));
    expect(queueRunway(queue, TWICE, now)?.runway?.count).toBe(3);
  });
});

describe("queueRunway — gösterge gizlenir ya da boş", () => {
  const now = utc("2026-09-25T07:00:00Z");

  it("ayar yok / duraklatılmış / geçerli slot yok → null", () => {
    expect(queueRunway(queueOf(5), null, now)).toBeNull();
    expect(queueRunway(queueOf(5), { ...TWICE, paused: true }, now)).toBeNull();
    expect(queueRunway(queueOf(5), { ...TWICE, slots: [] }, now)).toBeNull();
    expect(queueRunway(queueOf(5), { ...TWICE, slots: ["bozuk", "25:00"] }, now)).toBeNull();
  });

  it("boş kuyruk → null DEĞİL: runway null, sıradaki slot bilgisi var", () => {
    expect(queueRunway([], TWICE, now)).toEqual({
      runway: null,
      nextSlotAt: utc("2026-09-25T09:00:00Z"),
    });
  });

  it("kuyruktan çıkarılmış (queuePosition null) video sayılmaz", () => {
    const runway = queueRunway([item({ id: "x", queuePosition: null, status: "pending" })], TWICE, now);
    expect(runway?.runway).toBeNull();
  });
});

describe("queueRunway — Europe/Istanbul gece yarısı dönümü", () => {
  const one = queueOf(1);

  it("İstanbul 01:10 (UTC hâlâ dün): bugünkü 19:00 yayını → 1 gün (UTC günüyle 2 çıkardı)", () => {
    const now = utc("2026-09-25T22:10:00Z"); // yerel Cmt 26 Eyl 01:10
    const runway = queueRunway(one, { ...TWICE, slots: ["19:00"] }, now);
    expect(runway?.runway?.lastAt).toEqual(utc("2026-09-26T16:00:00Z"));
    expect(runway?.runway?.days).toBe(1);
  });

  it("İstanbul 23:50, slot 00:30: yayın yerel yarın (UTC bugün) → 2 gün (UTC günüyle 1 çıkardı)", () => {
    const now = utc("2026-09-25T20:50:00Z"); // yerel Cuma 23:50
    const runway = queueRunway(one, { ...TWICE, slots: ["00:30"] }, now);
    expect(runway?.runway?.lastAt).toEqual(utc("2026-09-25T21:30:00Z")); // yerel Cmt 00:30
    expect(runway?.runway?.days).toBe(2);
    expect(runway?.runway?.emptyFrom).toEqual(utc("2026-09-26T21:30:00Z"));
  });
});

describe("estimatePublishTimes — kart rozetindeki tahmini saat", () => {
  const now = utc("2026-09-25T07:00:00Z"); // Cuma 10:00

  it("bekleyen (onaysız) videoya da saat verir; caption'ı hazırlanan videoya vermez", () => {
    const queue = queueOf(3, (i) => {
      if (i === 0) return { status: "pending" };
      if (i === 1) return { status: "pending", captionStatus: "generating" };
      return {};
    });
    const etas = estimatePublishTimes(queue, TWICE, now);
    expect(etas.get("v01")).toEqual(utc("2026-09-25T09:00:00Z")); // bugün 12:00
    expect(etas.has("v02")).toBe(false);
    expect(etas.get("v03")).toEqual(utc("2026-09-25T16:00:00Z")); // bugün 19:00
  });

  it("ayar yoksa tahmin yok — tick ayarsız müşteriyi taramıyor", () => {
    expect(estimatePublishTimes(queueOf(2), null, now).size).toBe(0);
  });
});
