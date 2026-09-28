import { describe, expect, it } from "vitest";
import { queueRunway } from "./portal-schedule";
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
  requireApproval: true,
  paused: false,
};

describe("queueRunway — gün sayısı (bugün dahil, yerel takvim günü)", () => {
  it("günde 2 slot + 20 onaylı, şu an 10:00 → 10 gün; son yayın 10. günün 19:00'u", () => {
    const now = utc("2026-09-25T07:00:00Z"); // Cuma 10:00
    const runway = queueRunway(queueOf(20), TWICE, now);
    expect(runway).toEqual({
      approved: {
        count: 20,
        lastAt: utc("2026-10-04T16:00:00Z"), // Paz 4 Eki 19:00
        days: 10,
        emptyFrom: utc("2026-10-05T09:00:00Z"), // ertesi gün 12:00
      },
      ifAllApproved: null, // hepsi zaten onaylı
      nextSlotAt: utc("2026-09-25T09:00:00Z"),
    });
  });

  it("bugünün 12:00'si geçmişse (13:00) aynı 20 video bir gün daha uzağa yeter → 11 gün", () => {
    const now = utc("2026-09-25T10:00:00Z"); // Cuma 13:00
    const runway = queueRunway(queueOf(20), TWICE, now);
    // Bugün yalnız 19:00 → 1, sonraki 9 gün → 18, 11. gün 12:00 → 20.
    expect(runway?.approved).toEqual({
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
    expect(runway?.approved?.lastAt).toEqual(utc("2026-10-05T16:00:00Z"));
    expect(runway?.approved?.days).toBe(11);
    expect(runway?.nextSlotAt).toEqual(utc("2026-09-26T09:00:00Z"));
  });

  it("slot anındaki video tick'e ait sayılır — tam 12:00'de bakınca o slot takvimde yok", () => {
    const now = utc("2026-09-25T09:00:00Z"); // tam 12:00
    const runway = queueRunway(queueOf(1), TWICE, now);
    expect(runway?.approved?.lastAt).toEqual(utc("2026-09-25T16:00:00Z"));
    expect(runway?.approved?.days).toBe(1);
  });

  it("yalnız hafta içi: hafta sonu atlanır ama takvim günü olarak sayılır", () => {
    const settings = { ...TWICE, slots: ["19:00"], days: [1, 2, 3, 4, 5] };
    const now = utc("2026-09-25T07:00:00Z"); // Cuma 10:00
    // 6 video: Cum 25, Pzt 28, Sal 29, Çar 30, Per 1, Cum 2.
    const runway = queueRunway(queueOf(6), settings, now);
    expect(runway?.approved).toEqual({
      count: 6,
      lastAt: utc("2026-10-02T16:00:00Z"),
      days: 8, // 25 Eyl – 2 Eki, aradaki hafta sonu dahil
      emptyFrom: utc("2026-10-05T16:00:00Z"), // Cmt/Paz değil, Pazartesi
    });
  });
});

describe("queueRunway — onay modu", () => {
  const now = utc("2026-09-25T07:00:00Z"); // Cuma 10:00

  it("onay açık, karışık kuyruk (6 onaylı, 4 onaysız) → approved 3 gün, ifAllApproved 5 gün", () => {
    // Onaysızlar araya serpiştirilmiş; biri caption'ı henüz hazır değil.
    const queue = queueOf(10, (i) => {
      if (i === 1 || i === 4 || i === 7) return { status: "pending" };
      if (i === 9) return { status: "pending", captionStatus: "generating" };
      return {};
    });
    const runway = queueRunway(queue, TWICE, now);
    expect(runway?.approved).toEqual({
      count: 6,
      lastAt: utc("2026-09-27T16:00:00Z"),
      days: 3,
      emptyFrom: utc("2026-09-28T09:00:00Z"),
    });
    expect(runway?.ifAllApproved).toEqual({
      count: 10,
      lastAt: utc("2026-09-29T16:00:00Z"),
      days: 5,
      emptyFrom: utc("2026-09-30T09:00:00Z"),
    });
  });

  it("yayını patlamış (failed) video 'hepsini onaylarsan'a da girmez — onu 'tekrar dene' kurtarır", () => {
    const queue = queueOf(4, (i) => (i === 3 ? { status: "pending", publishStatus: "failed" } : {}));
    const runway = queueRunway(queue, TWICE, now);
    expect(runway?.approved?.count).toBe(3);
    // Onaylansa da takvim aynı kalır → gösterilmez.
    expect(runway?.ifAllApproved).toBeNull();
  });

  it("caption'ı üretilemeyen video 'hepsini onaylarsan'a girmez; hazırlanmakta olan girer", () => {
    const queue = queueOf(4, (i) => {
      if (i === 1) return { status: "pending", captionStatus: "failed" };
      if (i === 2) return { status: "pending", captionStatus: "generating" };
      return {};
    });
    const runway = queueRunway(queue, TWICE, now);
    expect(runway?.approved?.count).toBe(2);
    // failed olan önce caption düzeltmesi ister → 4 değil 3.
    expect(runway?.ifAllApproved?.count).toBe(3);
  });

  it("onay açık, hiç onaylı yok → approved null, ifAllApproved dolu", () => {
    const runway = queueRunway(queueOf(4, () => ({ status: "pending" })), TWICE, now);
    expect(runway?.approved).toBeNull();
    expect(runway?.ifAllApproved?.count).toBe(4);
    expect(runway?.ifAllApproved?.days).toBe(2);
  });

  it("onay kapalı: bekleyenler de sayılır, ifAllApproved hep null", () => {
    const queue = queueOf(10, (i) => (i % 2 === 1 ? { status: "pending" } : {}));
    const runway = queueRunway(queue, { ...TWICE, requireApproval: false }, now);
    expect(runway?.approved?.count).toBe(10);
    expect(runway?.approved?.days).toBe(5);
    expect(runway?.ifAllApproved).toBeNull();
  });

  it("onay kapalıyken reddedilmiş/caption'ı hazır olmayan video takvime girmez", () => {
    const queue = queueOf(4, (i) =>
      i === 0 ? { status: "rejected" } : i === 1 ? { captionStatus: "generating" } : {}
    );
    const runway = queueRunway(queue, { ...TWICE, requireApproval: false }, now);
    expect(runway?.approved?.count).toBe(2);
    expect(runway?.ifAllApproved).toBeNull();
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

  it("boş kuyruk → null DEĞİL: approved null, sıradaki slot bilgisi var", () => {
    expect(queueRunway([], TWICE, now)).toEqual({
      approved: null,
      ifAllApproved: null,
      nextSlotAt: utc("2026-09-25T09:00:00Z"),
    });
  });

  it("kuyruktan çıkarılmış (queuePosition null) video hiçbir senaryoda sayılmaz", () => {
    const runway = queueRunway([item({ id: "x", queuePosition: null, status: "pending" })], TWICE, now);
    expect(runway?.approved).toBeNull();
    expect(runway?.ifAllApproved).toBeNull();
  });
});

describe("queueRunway — Europe/Istanbul gece yarısı dönümü", () => {
  const one = queueOf(1);

  it("İstanbul 01:10 (UTC hâlâ dün): bugünkü 19:00 yayını → 1 gün (UTC günüyle 2 çıkardı)", () => {
    const now = utc("2026-09-25T22:10:00Z"); // yerel Cmt 26 Eyl 01:10
    const runway = queueRunway(one, { ...TWICE, slots: ["19:00"] }, now);
    expect(runway?.approved?.lastAt).toEqual(utc("2026-09-26T16:00:00Z"));
    expect(runway?.approved?.days).toBe(1);
  });

  it("İstanbul 23:50, slot 00:30: yayın yerel yarın (UTC bugün) → 2 gün (UTC günüyle 1 çıkardı)", () => {
    const now = utc("2026-09-25T20:50:00Z"); // yerel Cuma 23:50
    const runway = queueRunway(one, { ...TWICE, slots: ["00:30"] }, now);
    expect(runway?.approved?.lastAt).toEqual(utc("2026-09-25T21:30:00Z")); // yerel Cmt 00:30
    expect(runway?.approved?.days).toBe(2);
    expect(runway?.approved?.emptyFrom).toEqual(utc("2026-09-26T21:30:00Z"));
  });
});
