import { beforeEach, describe, expect, it } from "vitest";
import {
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  getClientIp,
  isRateLimited,
  resetRateLimiter,
} from "./rate-limit";

beforeEach(() => {
  resetRateLimiter();
});

describe("isRateLimited", () => {
  it("ilk 10 isteğe izin verir, 11. isteği reddeder", () => {
    const now = Date.now();
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      expect(isRateLimited("1.2.3.4", now)).toBe(false);
    }
    expect(isRateLimited("1.2.3.4", now)).toBe(true);
  });

  it("pencere dolduktan sonra sayaç sıfırlanır", () => {
    const now = Date.now();
    for (let i = 0; i <= RATE_LIMIT_MAX; i++) isRateLimited("1.2.3.4", now);
    expect(isRateLimited("1.2.3.4", now + RATE_LIMIT_WINDOW_MS)).toBe(false);
  });

  it("IP'ler birbirinden bağımsız sayılır", () => {
    const now = Date.now();
    for (let i = 0; i <= RATE_LIMIT_MAX; i++) isRateLimited("1.2.3.4", now);
    expect(isRateLimited("5.6.7.8", now)).toBe(false);
  });
});

describe("getClientIp", () => {
  it("x-forwarded-for'un ilk değerini döner", () => {
    const headers = new Headers({ "x-forwarded-for": "9.8.7.6, 10.0.0.1" });
    expect(getClientIp(headers)).toBe("9.8.7.6");
  });

  it("header yoksa 'unknown' döner — asla boş değer dönmez (TENSION 4)", () => {
    expect(getClientIp(new Headers())).toBe("unknown");
  });

  it("header boş string ise 'unknown' döner", () => {
    expect(getClientIp(new Headers({ "x-forwarded-for": "" }))).toBe("unknown");
  });
});
