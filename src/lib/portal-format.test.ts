import { describe, expect, it } from "vitest";
import {
  dayCountLabel,
  historyGroup,
  maskEmail,
  presetFor,
  runwaySummary,
  scheduleSummary,
  shortDateTime,
  slotDayLabel,
  slotLabel,
  slotWeekdayLabel,
  timezoneLabel,
  weekdayDateTime,
} from "./portal-format";
import { queueRunway } from "./portal-schedule";

const TZ = "Europe/Istanbul";
// 2026-09-25 Cuma, İstanbul 14:00 (UTC+3).
const NOW = new Date("2026-09-25T11:00:00Z");

describe("slotLabel — müşterinin saat diliminde", () => {
  it("bugün / yarın / sonrası", () => {
    expect(slotLabel(new Date("2026-09-25T16:00:00Z"), TZ, NOW)).toBe("Bugün · 19:00");
    expect(slotLabel(new Date("2026-09-26T16:00:00Z"), TZ, NOW)).toBe("Yarın · 19:00");
    expect(slotDayLabel(new Date("2026-09-27T16:00:00Z"), TZ, NOW)).toBe("Paz 27 Eyl");
  });

  it("gün sınırı UTC'ye göre değil İstanbul'a göre: 22:00 UTC ertesi günün 01:00'i", () => {
    // UTC'de hâlâ 25 Eylül ama İstanbul'da 26'sı → "Yarın".
    expect(slotLabel(new Date("2026-09-25T22:00:00Z"), TZ, NOW)).toBe("Yarın · 01:00");
  });
});

describe("historyGroup — hafta Pazartesi başlar", () => {
  it("bu hafta, geçen hafta, daha eskisi ay adıyla", () => {
    expect(historyGroup(new Date("2026-09-22T16:00:00Z"), TZ, NOW)).toBe("BU HAFTA"); // Salı
    expect(historyGroup(new Date("2026-09-20T16:00:00Z"), TZ, NOW)).toBe("GEÇEN HAFTA"); // Pazar
    expect(historyGroup(new Date("2026-08-30T16:00:00Z"), TZ, NOW)).toBe("AĞUSTOS 2026");
  });
});

describe("küçük biçimler", () => {
  it("shortDateTime", () => {
    expect(shortDateTime(new Date("2026-09-25T16:00:00Z"), TZ)).toBe("25 Eyl · 19:00");
  });

  it("maskEmail yalnızca ilk harfi ve alan adını gösterir", () => {
    expect(maskEmail("furkan@gmail.com")).toBe("f••••@gmail.com");
    expect(maskEmail(" x@y.co ")).toBe("x••••@y.co");
    expect(maskEmail("bozuk")).toBe("bozuk");
  });

  it("timezoneLabel", () => {
    expect(timezoneLabel("Europe/Istanbul")).toBe("Türkiye saati");
    expect(timezoneLabel("America/New_York")).toBe("America/New York");
  });
});

describe("yayın günleri (V8)", () => {
  it("slotWeekdayLabel: bugün/yarın, hafta içinde tam gün adı, daha uzaksa tarihle", () => {
    expect(slotWeekdayLabel(new Date("2026-09-25T16:00:00Z"), TZ, NOW)).toBe("Bugün");
    expect(slotWeekdayLabel(new Date("2026-09-26T16:00:00Z"), TZ, NOW)).toBe("Yarın");
    expect(slotWeekdayLabel(new Date("2026-10-01T16:00:00Z"), TZ, NOW)).toBe("Perşembe");
    expect(slotWeekdayLabel(new Date("2026-10-02T16:00:00Z"), TZ, NOW)).toBe("Cuma 2 Eki");
  });

  it("slotWeekdayLabel gün sınırını müşterinin saat diliminde okur", () => {
    // UTC Pazar 21:30 = İstanbul Pazartesi 00:30.
    expect(slotWeekdayLabel(new Date("2026-09-27T21:30:00Z"), TZ, NOW)).toBe("Pazartesi");
  });

  it("weekdayDateTime", () => {
    expect(weekdayDateTime(new Date("2026-10-01T16:00:00Z"), TZ)).toBe("Perşembe · 1 Eki · 19:00");
  });

  it("özet metni ve hazır seçimler", () => {
    expect(scheduleSummary([1, 4, 5], ["19:00"])).toBe("Haftada 3 video · Pzt, Per, Cum · 19:00");
    expect(scheduleSummary([1, 2, 3, 4, 5, 6, 7], ["09:30", "19:00"])).toBe("Her gün 2 video · 09:30, 19:00");
    expect(scheduleSummary([1, 2, 3, 4, 5], ["19:00", "21:00"])).toBe("Haftada 10 video · Hafta içi · 19:00, 21:00");
    expect(scheduleSummary([6, 7], ["19:00"])).toBe("Haftada 2 video · Hafta sonu · 19:00");
    expect(presetFor([1, 3])).toBeNull();
    expect(dayCountLabel([1])).toBe("Haftada 1 gün");
    expect(dayCountLabel([1, 2, 3, 4, 5, 6, 7])).toBe("Her gün");
  });
});

describe("runwaySummary — kuyruk kaç gün yeter", () => {
  // NOW: Cuma 25 Eyl 14:00 İstanbul.
  const end = (days: number, lastAt: string) => ({
    count: days * 2,
    lastAt: new Date(lastAt),
    days,
    emptyFrom: new Date(lastAt),
  });
  const next = new Date("2026-09-25T16:00:00Z");

  it("yeterli: gün sayısı, son yayının tarihi, hepsini onaylarsan", () => {
    expect(
      runwaySummary(
        {
          approved: end(10, "2026-10-07T16:00:00Z"),
          ifAllApproved: end(12, "2026-10-09T16:00:00Z"),
          nextSlotAt: next,
        },
        TZ,
        NOW
      )
    ).toEqual({
      headline: "10 gün yeter",
      sub: "Son yayın Çar 7 Eki · 19:00",
      extra: "Hepsini onaylarsan 12 gün",
      level: "ok",
    });
  });

  it("az kaldı (≤ 2 gün): 'yarın' cümle içinde küçük harf, extra yoksa alan da yok", () => {
    const out = runwaySummary(
      { approved: end(2, "2026-09-26T16:00:00Z"), ifAllApproved: null, nextSlotAt: next },
      TZ,
      NOW
    );
    expect(out).toStrictEqual({
      headline: "2 gün yeter",
      sub: "Son yayın yarın · 19:00",
      level: "low",
    });
    expect(
      runwaySummary(
        { approved: end(1, "2026-09-25T16:00:00Z"), ifAllApproved: null, nextSlotAt: next },
        TZ,
        NOW
      )?.sub
    ).toBe("Son yayın bugün · 19:00");
    // Sınır: 3 gün artık uyarı değil.
    expect(
      runwaySummary(
        { approved: end(3, "2026-09-27T16:00:00Z"), ifAllApproved: null, nextSlotAt: next },
        TZ,
        NOW
      )?.level
    ).toBe("ok");
  });

  it("takvime giren yok: sıradaki slot boş geçer; onay bekleyenler varsa extra", () => {
    expect(
      runwaySummary(
        { approved: null, ifAllApproved: end(5, "2026-09-29T16:00:00Z"), nextSlotAt: next },
        TZ,
        NOW
      )
    ).toEqual({
      headline: "Yayınlanacak video yok",
      sub: "Sıradaki slot boş geçer · Bugün 19:00",
      extra: "Hepsini onaylarsan 5 gün",
      level: "empty",
    });
  });

  it("gösterge gizliyse (null) metin de yok", () => {
    expect(runwaySummary(null, TZ, NOW)).toBeNull();
  });

  it("queueRunway ile uçtan uca: 20 onaylı, günde 2 slot, 10:00'da bakınca", () => {
    const now = new Date("2026-09-25T07:00:00Z");
    const queue = Array.from({ length: 20 }, (_, i) => ({
      id: `v${i}`,
      queuePosition: i + 1,
      captionStatus: "ready" as const,
      status: "approved" as const,
      publishStatus: "idle" as const,
    }));
    const settings = { slots: ["12:00", "19:00"], timezone: TZ, days: [], requireApproval: true, paused: false };
    expect(runwaySummary(queueRunway(queue, settings, now), TZ, now)).toEqual({
      headline: "10 gün yeter",
      sub: "Son yayın Paz 4 Eki · 19:00",
      level: "ok",
    });
  });
});
