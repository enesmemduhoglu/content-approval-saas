import { describe, expect, it } from "vitest";
import {
  IG_TOKEN_REFRESH_DAYS,
  IG_TOKEN_WARNING_DAYS,
  daysUntilExpiry,
  instagramTokenAlerts,
  instagramTokenRefreshDecision,
  isInstagramTokenExpired,
  type TokenAlertClient,
  type TokenRefreshClient,
} from "./instagram-token";

const NOW = new Date("2026-08-16T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** NOW'a göre `days` gün sonrası (negatif = geçmiş). */
function inDays(days: number): Date {
  return new Date(NOW.getTime() + days * DAY_MS);
}

function client(overrides: Partial<TokenAlertClient> = {}): TokenAlertClient {
  return {
    id: "client-1",
    name: "Müşteri A",
    instagramConnected: true,
    instagramTokenExpiry: inDays(30),
    ...overrides,
  };
}

describe("isInstagramTokenExpired", () => {
  it("geçmiş tarih için true döner", () => {
    expect(isInstagramTokenExpired(inDays(-1), NOW)).toBe(true);
  });

  it("tam olarak şu an dolan token'ı dolmuş sayar", () => {
    expect(isInstagramTokenExpired(new Date(NOW), NOW)).toBe(true);
  });

  it("gelecek tarih için false döner", () => {
    expect(isInstagramTokenExpired(inDays(1), NOW)).toBe(false);
  });

  it("tarih bilinmiyorsa (null/undefined) dolmuş saymaz", () => {
    expect(isInstagramTokenExpired(null, NOW)).toBe(false);
    expect(isInstagramTokenExpired(undefined, NOW)).toBe(false);
  });
});

describe("daysUntilExpiry", () => {
  it("yarım günleri yukarı yuvarlar (3 gün 5 saat → 4)", () => {
    expect(daysUntilExpiry(new Date(NOW.getTime() + 3 * DAY_MS + 5 * 3600_000), NOW)).toBe(4);
  });

  it("süresi dolmuşsa negatif döner", () => {
    expect(daysUntilExpiry(inDays(-2), NOW)).toBe(-2);
  });
});

describe("instagramTokenRefreshDecision", () => {
  function refreshClient(overrides: Partial<TokenRefreshClient> = {}): TokenRefreshClient {
    return {
      instagramUserId: "17841400000000000",
      instagramAccessToken: "IGAA-test-token",
      instagramTokenExpiry: inDays(30),
      ...overrides,
    };
  }

  it("yenileme penceresi uyarı eşiğinden GENİŞ — cron uyarı çıkmadan iş görür", () => {
    expect(IG_TOKEN_REFRESH_DAYS).toBeGreaterThan(IG_TOKEN_WARNING_DAYS);
  });

  it("pencerenin dışındaki token'a dokunmaz", () => {
    expect(
      instagramTokenRefreshDecision(
        refreshClient({ instagramTokenExpiry: inDays(IG_TOKEN_REFRESH_DAYS + 1) }),
        NOW
      )
    ).toBe("skip");
  });

  it("sınır durumu: tam 20 gün kala yeniler", () => {
    expect(
      instagramTokenRefreshDecision(
        refreshClient({ instagramTokenExpiry: inDays(IG_TOKEN_REFRESH_DAYS) }),
        NOW
      )
    ).toBe("refresh");
  });

  it("uyarı eşiğine düşmüş token da yenilenir", () => {
    expect(
      instagramTokenRefreshDecision(
        refreshClient({ instagramTokenExpiry: inDays(IG_TOKEN_WARNING_DAYS) }),
        NOW
      )
    ).toBe("refresh");
  });

  it("son bir saat kalmışsa hâlâ yenilenir", () => {
    expect(
      instagramTokenRefreshDecision(
        refreshClient({ instagramTokenExpiry: new Date(NOW.getTime() + 3600_000) }),
        NOW
      )
    ).toBe("refresh");
  });

  it("süresi ZATEN dolmuş token yenilenmez — ayrı işaretlenir", () => {
    expect(
      instagramTokenRefreshDecision(refreshClient({ instagramTokenExpiry: inDays(-1) }), NOW)
    ).toBe("expired");
  });

  it("sınır durumu: tam şu an dolan token yenilenemez sayılır", () => {
    expect(
      instagramTokenRefreshDecision(refreshClient({ instagramTokenExpiry: new Date(NOW) }), NOW)
    ).toBe("expired");
  });

  it("Instagram bağlı olmayan müşteriyi atlar", () => {
    expect(
      instagramTokenRefreshDecision(refreshClient({ instagramAccessToken: null }), NOW)
    ).toBe("skip");
    expect(instagramTokenRefreshDecision(refreshClient({ instagramUserId: null }), NOW)).toBe(
      "skip"
    );
  });

  it("bitiş tarihi bilinmiyorsa atlar (uyarı şeridiyle aynı davranış)", () => {
    expect(
      instagramTokenRefreshDecision(refreshClient({ instagramTokenExpiry: null }), NOW)
    ).toBe("skip");
  });
});

describe("instagramTokenAlerts", () => {
  it("eşiğin dışındaki müşteri için uyarı çıkarmaz", () => {
    expect(instagramTokenAlerts([client({ instagramTokenExpiry: inDays(60) })], NOW)).toEqual([]);
  });

  it("eşiğin bir gün ötesinde (11 gün) hâlâ uyarı çıkarmaz", () => {
    const alerts = instagramTokenAlerts(
      [client({ instagramTokenExpiry: inDays(IG_TOKEN_WARNING_DAYS + 1) })],
      NOW
    );
    expect(alerts).toEqual([]);
  });

  it("sınır durumu: tam 10 gün kala uyarı çıkar", () => {
    const alerts = instagramTokenAlerts(
      [client({ instagramTokenExpiry: inDays(IG_TOKEN_WARNING_DAYS) })],
      NOW
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ daysLeft: 10, expired: false, clientName: "Müşteri A" });
  });

  it("süresi dolmuş token'ı `expired` olarak işaretler", () => {
    const alerts = instagramTokenAlerts([client({ instagramTokenExpiry: inDays(-3) })], NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ daysLeft: -3, expired: true });
  });

  it("Instagram bağlı olmayan müşteri için uyarı ÇIKMAZ", () => {
    const alerts = instagramTokenAlerts(
      [client({ instagramConnected: false, instagramTokenExpiry: inDays(-3) })],
      NOW
    );
    expect(alerts).toEqual([]);
  });

  it("instagramTokenExpiry null ise uyarı çıkmaz", () => {
    expect(instagramTokenAlerts([client({ instagramTokenExpiry: null })], NOW)).toEqual([]);
  });

  it("en acilden başlayarak sıralar — dolmuş olan en üstte", () => {
    const alerts = instagramTokenAlerts(
      [
        client({ id: "a", name: "Yakın", instagramTokenExpiry: inDays(9) }),
        client({ id: "b", name: "Dolmuş", instagramTokenExpiry: inDays(-1) }),
        client({ id: "c", name: "Çok yakın", instagramTokenExpiry: inDays(2) }),
        client({ id: "d", name: "Uzak", instagramTokenExpiry: inDays(45) }),
      ],
      NOW
    );
    expect(alerts.map((alert) => alert.clientName)).toEqual(["Dolmuş", "Çok yakın", "Yakın"]);
  });

  it("uyarı yalnızca ad ve gün sayısı taşır — token alanı sızmaz", () => {
    const alerts = instagramTokenAlerts([client({ instagramTokenExpiry: inDays(1) })], NOW);
    expect(Object.keys(alerts[0]).sort()).toEqual(["clientId", "clientName", "daysLeft", "expired"]);
  });
});
