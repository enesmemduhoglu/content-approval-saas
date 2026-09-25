import { describe, expect, it } from "vitest";
import {
  dayCountLabel,
  historyGroup,
  maskEmail,
  presetFor,
  scheduleSummary,
  shortDateTime,
  slotDayLabel,
  slotLabel,
  slotWeekdayLabel,
  timezoneLabel,
  weekdayDateTime,
} from "./portal-format";

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
