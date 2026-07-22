import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  checkRateLimit,
  getClientIp,
  isRateLimited,
  resetRateLimiter,
} from "./rate-limit";

beforeEach(() => {
  resetRateLimiter();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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

describe("checkRateLimit (Upstash)", () => {
  function stubUpstash(counterValue: number, ok = true) {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://fake.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "fake-token");
    const fetchMock = vi.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 500,
      json: async () => [{ result: counterValue }, { result: 1 }],
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("env yoksa in-memory sayaca düşer", async () => {
    const now = Date.now();
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      expect(await checkRateLimit("1.2.3.4", now)).toBe(false);
    }
    expect(await checkRateLimit("1.2.3.4", now)).toBe(true);
  });

  it("Upstash sayacı limitin altındaysa izin verir", async () => {
    const fetchMock = stubUpstash(3);
    expect(await checkRateLimit("1.2.3.4")).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/pipeline");
    expect(init.headers.Authorization).toBe("Bearer fake-token");
  });

  it("Upstash sayacı limiti aşınca reddeder", async () => {
    stubUpstash(RATE_LIMIT_MAX + 1);
    expect(await checkRateLimit("1.2.3.4")).toBe(true);
  });

  it("Vercel KV_REST_API_* env adlarını da tanır", async () => {
    vi.stubEnv("KV_REST_API_URL", "https://kv.upstash.io");
    vi.stubEnv("KV_REST_API_TOKEN", "kv-token");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ result: RATE_LIMIT_MAX + 1 }, { result: 1 }],
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await checkRateLimit("1.2.3.4")).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("kv.upstash.io");
    expect(init.headers.Authorization).toBe("Bearer kv-token");
  });

  it("Upstash hata verirse istek patlatılmaz, in-memory fallback çalışır", async () => {
    stubUpstash(0, false);
    expect(await checkRateLimit("1.2.3.4")).toBe(false);
    const now = Date.now();
    for (let i = 0; i < RATE_LIMIT_MAX; i++) isRateLimited("9.9.9.9", now);
    stubUpstash(0, false);
    expect(await checkRateLimit("9.9.9.9", now)).toBe(true);
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
