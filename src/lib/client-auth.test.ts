import { afterEach, describe, expect, it } from "vitest";
import {
  CLIENT_SESSION_TTL_SECONDS,
  clientSessionRenewAt,
  generateLoginCode,
  hashLoginCode,
  shouldRenewClientSession,
  signClientSession,
  verifyClientSession,
} from "@/lib/client-auth";

const session = { clientUserId: "user-1", clientId: "client-1" };

afterEach(() => {
  process.env.AUTH_SECRET = "test-secret";
});

describe("portal oturum çerezi (HMAC)", () => {
  it("imzalanan çerez doğrulanır", () => {
    const { value } = signClientSession(session);
    expect(verifyClientSession(value)).toEqual(session);
  });

  it("gövdesi değiştirilmiş çerez reddedilir (başka müşteriye geçiş denemesi)", () => {
    const { value } = signClientSession(session);
    const [v, , sig] = value.split(".");
    const forged = Buffer.from(
      JSON.stringify({ u: "user-1", c: "client-2", exp: Math.floor(Date.now() / 1000) + 3600 })
    ).toString("base64url");
    expect(verifyClientSession(`${v}.${forged}.${sig}`)).toBeNull();
  });

  it("süresi dolan çerez reddedilir (30 gün)", () => {
    const issued = new Date("2026-01-01T00:00:00Z");
    const { value, expiresAt } = signClientSession(session, issued);
    expect(expiresAt.getTime() - issued.getTime()).toBe(CLIENT_SESSION_TTL_SECONDS * 1000);
    expect(verifyClientSession(value, new Date(expiresAt.getTime() - 1000))).toEqual(session);
    expect(verifyClientSession(value, expiresAt)).toBeNull();
  });

  it("farklı AUTH_SECRET ile imzalanmış çerez geçmez", () => {
    const { value } = signClientSession(session);
    process.env.AUTH_SECRET = "baska-sir";
    expect(verifyClientSession(value)).toBeNull();
  });

  it("AUTH_SECRET yoksa imza atılmaz, doğrulama da geçmez (kapalı başarısızlık)", () => {
    const { value } = signClientSession(session);
    delete process.env.AUTH_SECRET;
    expect(() => signClientSession(session)).toThrow();
    expect(verifyClientSession(value)).toBeNull();
  });

  it("bozuk biçimler null", () => {
    for (const bad of ["", "abc", "v1.a", "v2.a.b", "v1.!!.??", null, undefined]) {
      expect(verifyClientSession(bad)).toBeNull();
    }
  });

  it("imza AUTH_SECRET'in kendisiyle değil türetilmiş anahtarla atılır", async () => {
    const { createHmac } = await import("node:crypto");
    const { value } = signClientSession(session);
    const [, payload, sig] = value.split(".");
    const naive = createHmac("sha256", "test-secret").update(`v1.${payload}`).digest("base64url");
    expect(sig).not.toBe(naive);
  });
});

describe("kaydırmalı oturum eşiği (K25)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = new Date("2026-09-26T12:00:00Z");

  it("kalan 15 günün altındaysa yenilenir, üstündeyse yenilenmez", () => {
    expect(shouldRenewClientSession(new Date(now.getTime() + 16 * DAY), now)).toBe(false);
    expect(shouldRenewClientSession(new Date(now.getTime() + 14 * DAY), now)).toBe(true);
    expect(shouldRenewClientSession(new Date(now.getTime() + 1000), now)).toBe(true);
  });

  it("yenileme anı = bitiş − 15 gün", () => {
    const exp = new Date(now.getTime() + 30 * DAY);
    expect(clientSessionRenewAt(exp).getTime()).toBe(now.getTime() + 15 * DAY);
  });
});

describe("giriş kodu", () => {
  it("her zaman 6 hane (baştaki sıfırlar korunur)", () => {
    for (let i = 0; i < 200; i++) expect(generateLoginCode()).toMatch(/^\d{6}$/);
  });

  it("hash satıra bağlı: aynı kod farklı token'da farklı hash", () => {
    expect(hashLoginCode("a", "123456")).not.toBe(hashLoginCode("b", "123456"));
    expect(hashLoginCode("a", "123456")).toBe(hashLoginCode("a", "123456"));
  });

  it("AUTH_SECRET yoksa hash üretilmez (kapalı başarısızlık)", () => {
    delete process.env.AUTH_SECRET;
    expect(() => hashLoginCode("a", "123456")).toThrow();
  });
});
