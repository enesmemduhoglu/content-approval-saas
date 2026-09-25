import { describe, expect, it } from "vitest";
import { historyGroup, maskEmail, shortDateTime, slotDayLabel, slotLabel, timezoneLabel } from "./portal-format";

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
