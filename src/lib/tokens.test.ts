import { describe, expect, it } from "vitest";
import {
  APPROVAL_LINK_TTL_DAYS,
  approvalLinkExpiry,
  generateApprovalToken,
  isExpired,
} from "./tokens";

describe("generateApprovalToken", () => {
  it("URL-safe, tireleri olmayan 32 karakterlik token üretir", () => {
    const token = generateApprovalToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("her çağrıda farklı token üretir", () => {
    const tokens = new Set(Array.from({ length: 100 }, generateApprovalToken));
    expect(tokens.size).toBe(100);
  });
});

describe("approvalLinkExpiry", () => {
  it("verilen tarihten tam 7 gün sonrasını döner", () => {
    const from = new Date("2026-07-22T12:00:00Z");
    const expiry = approvalLinkExpiry(from);
    expect(expiry.getTime() - from.getTime()).toBe(
      APPROVAL_LINK_TTL_DAYS * 24 * 60 * 60 * 1000
    );
  });
});

describe("isExpired", () => {
  it("geçmiş tarih için true döner", () => {
    expect(isExpired(new Date("2026-01-01"), new Date("2026-07-22"))).toBe(true);
  });

  it("gelecek tarih için false döner", () => {
    expect(isExpired(new Date("2026-12-31"), new Date("2026-07-22"))).toBe(false);
  });
});
