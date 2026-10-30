import { describe, expect, it } from "vitest";
import {
  FOLLOW_UP_DEFERRED_SEC,
  FOLLOW_UP_PUBLISHING_SEC,
  WAKE_HORIZON_MS,
  desiredWakeTimes,
  followUpDecision,
  parseWakeKind,
} from "@/lib/queue-wake";

// Saf fonksiyonlar — DB'ye dokunmaz, saat sabit.
const NOW = new Date("2026-11-02T06:00:00Z"); // Pazartesi, İstanbul 09:00
const IST = "Europe/Istanbul";
const iso = (dates: Date[]) => dates.map((d) => d.toISOString());

describe("desiredWakeTimes", () => {
  it("iki müşterinin aynı slotu tek uyandırmaya iner, farklı saatler sıralı döner", () => {
    const times = desiredWakeTimes(
      [
        { slots: ["20:00", "10:00"], timezone: IST, days: [1] },
        { slots: ["10:00"], timezone: IST, days: [1] },
      ],
      NOW
    );
    expect(iso(times)).toEqual(["2026-11-02T07:00:00.000Z", "2026-11-02T17:00:00.000Z"]);
  });

  it("ufuk 6 gün: içindeki son slot dahil, sonrası ve geçmiş hariç", () => {
    const times = desiredWakeTimes([{ slots: ["09:00", "09:01"], timezone: IST }], NOW);
    // 09:00 (= NOW) dahil; 6 gün sonraki 09:00 tam ufukta, 09:01 ufkun dışında.
    expect(times[0].toISOString()).toBe("2026-11-02T06:00:00.000Z");
    expect(times.at(-1)!.getTime()).toBe(NOW.getTime() + WAKE_HORIZON_MS);
    expect(times.every((t) => t >= NOW)).toBe(true);
    expect(times.some((t) => t.getTime() > NOW.getTime() + WAKE_HORIZON_MS)).toBe(false);
    // 7 gün × 2 slot − son günün 09:01'i
    expect(times).toHaveLength(13);
  });

  it("şimdiden önceki slot kurulmaz", () => {
    const at0859 = desiredWakeTimes([{ slots: ["08:59"], timezone: IST, days: [1] }], NOW);
    expect(at0859).toEqual([]);
  });

  it("days filtresi: yalnızca Pazartesi ve Çarşamba", () => {
    const times = desiredWakeTimes([{ slots: ["19:00"], timezone: IST, days: [1, 3] }], NOW);
    expect(iso(times)).toEqual(["2026-11-02T16:00:00.000Z", "2026-11-04T16:00:00.000Z"]);
  });

  it("DST: Berlin'de saat geri alınan gün 09:00 yeni ofsetle, ne kaybolur ne iki kez üretilir", () => {
    // 2026-10-25 03:00 CEST → 02:00 CET.
    const now = new Date("2026-10-23T12:00:00Z");
    const times = desiredWakeTimes([{ slots: ["09:00", "02:30"], timezone: "Europe/Berlin" }], now);
    const on = (day: string) => iso(times).filter((t) => t.startsWith(day));
    expect(on("2026-10-24")).toContain("2026-10-24T07:00:00.000Z"); // CEST, UTC+2
    expect(on("2026-10-25")).toContain("2026-10-25T08:00:00.000Z"); // CET, UTC+1
    // 02:30 o gün iki kez yaşanıyor; uyandırma bir kez.
    const ambiguous = times.filter((t) => {
      const local = t.toLocaleString("en-GB", { timeZone: "Europe/Berlin" });
      return local.startsWith("25/10/2026") && local.includes("02:30");
    });
    expect(ambiguous).toHaveLength(1);
  });

  it("duraklatılmış müşteri de uyandırma alır (SlotRun(paused) yazılsın)", () => {
    // `desiredWakeTimes` `paused`a hiç bakmaz — tipte bile yok; sözleşmeyi sabitle.
    const paused = { slots: ["19:00"], timezone: IST, days: [1], paused: true };
    expect(desiredWakeTimes([paused], NOW)).toHaveLength(1);
  });

  it("slotsuz ayar ya da boş liste boş sonuç", () => {
    expect(desiredWakeTimes([], NOW)).toEqual([]);
    expect(desiredWakeTimes([{ slots: [], timezone: IST }], NOW)).toEqual([]);
  });

  it("saniyeye yuvarlar (notBefore saniye) ve ms farkı ayrı uyandırma doğurmaz", () => {
    const now = new Date("2026-11-02T05:59:59.500Z");
    const times = desiredWakeTimes([{ slots: ["09:00"], timezone: IST, days: [1] }], now);
    expect(times).toHaveLength(1);
    expect(times[0].getTime() % 1000).toBe(0);
  });
});

describe("followUpDecision", () => {
  const min = (m: number) => new Date(NOW.getTime() - m * 60_000);

  it("ertelenen slot → 60 sn", () => {
    expect(followUpDecision({ deferred: 1 }, [], NOW)).toBe(FOLLOW_UP_DEFERRED_SEC);
  });

  it("5 dk önce açılmış container → 120 sn", () => {
    expect(followUpDecision({ deferred: 0 }, [min(5)], NOW)).toBe(FOLLOW_UP_PUBLISHING_SEC);
  });

  it("31 dk önce açılmış container → takip yok (günlük cron'a kalır)", () => {
    expect(followUpDecision({ deferred: 0 }, [min(31)], NOW)).toBeNull();
  });

  it("biri taze biri eski container → taze olan takip ister", () => {
    expect(followUpDecision({ deferred: 0 }, [min(45), min(2)], NOW)).toBe(FOLLOW_UP_PUBLISHING_SEC);
  });

  it("ikisi birden → kısa olan", () => {
    expect(followUpDecision({ deferred: 2 }, [min(1)], NOW)).toBe(FOLLOW_UP_DEFERRED_SEC);
  });

  it("hiçbiri → takip yok", () => {
    expect(followUpDecision({ deferred: 0 }, [], NOW)).toBeNull();
  });
});

describe("parseWakeKind", () => {
  it("follow gövdesini tanır", () => {
    expect(parseWakeKind(JSON.stringify({ kind: "follow" }))).toBe("follow");
  });

  it("slot, boş, bozuk ya da tanınmayan gövde → slot", () => {
    expect(parseWakeKind(JSON.stringify({ kind: "slot" }))).toBe("slot");
    expect(parseWakeKind("")).toBe("slot");
    expect(parseWakeKind("{bozuk")).toBe("slot");
    expect(parseWakeKind(JSON.stringify({ kind: "baska" }))).toBe("slot");
    expect(parseWakeKind("null")).toBe("slot");
  });
});
