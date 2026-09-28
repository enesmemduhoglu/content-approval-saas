import { describe, expect, it } from "vitest";
import { instagramHealth, isInstagramBlocked, PORTAL_IG_WARNING_DAYS } from "./portal-instagram";

const now = new Date("2026-09-28T09:00:00Z");
const inDays = (days: number) => new Date(now.getTime() + days * 86_400_000);
const connected = (expiry: Date | null) => ({
  instagramUserId: "17841",
  instagramAccessToken: "sifreli",
  instagramTokenExpiry: expiry,
});

describe("instagramHealth — tick'in kapısıyla aynı kurallar", () => {
  it("hesap ya da token yoksa 'missing' → yayın durdu", () => {
    for (const client of [
      { instagramUserId: null, instagramAccessToken: "t", instagramTokenExpiry: null },
      { instagramUserId: "1", instagramAccessToken: null, instagramTokenExpiry: inDays(30) },
    ]) {
      const health = instagramHealth(client, now);
      expect(health).toEqual({ state: "missing" });
      expect(isInstagramBlocked(health)).toBe(true);
    }
  });

  it("süresi dolmuş (tam şu an dahil) → 'expired', yayın durdu", () => {
    expect(instagramHealth(connected(now), now)).toEqual({ state: "expired" });
    expect(instagramHealth(connected(inDays(-1)), now)).toEqual({ state: "expired" });
    expect(isInstagramBlocked({ state: "expired" })).toBe(true);
  });

  it(`${PORTAL_IG_WARNING_DAYS} gün ve altı → 'expiring' (yayın sürüyor, uyarı var)`, () => {
    const expiry = inDays(PORTAL_IG_WARNING_DAYS);
    const health = instagramHealth(connected(expiry), now);
    expect(health).toEqual({ state: "expiring", expiresAt: expiry, daysLeft: PORTAL_IG_WARNING_DAYS });
    expect(isInstagramBlocked(health)).toBe(false);
    // Yarım gün yukarı yuvarlanır (instagram-token.daysUntilExpiry).
    expect(instagramHealth(connected(inDays(0.5)), now)).toMatchObject({ state: "expiring", daysLeft: 1 });
  });

  it("uzak bitiş ya da bilinmeyen bitiş → 'ok'", () => {
    expect(instagramHealth(connected(inDays(PORTAL_IG_WARNING_DAYS + 1)), now)).toEqual({ state: "ok" });
    expect(instagramHealth(connected(null), now)).toEqual({ state: "ok" });
  });
});
