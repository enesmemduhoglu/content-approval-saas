import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SecretCryptoError,
  decryptSecret,
  encryptSecret,
  encryptionConfigured,
  isEncrypted,
  tryDecryptSecret,
} from "./crypto";

const KEY = Buffer.alloc(32, 7).toString("base64");
const BASKA_KEY = Buffer.alloc(32, 9).toString("base64");
const TOKEN = "IGAAxyz-gercek-gibi-uzun-bir-instagram-tokeni-1234567890";

beforeEach(() => {
  vi.stubEnv("ENCRYPTION_KEY", KEY);
  vi.stubEnv("NODE_ENV", "test");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("encrypt/decrypt turu", () => {
  it("şifreleyip çözünce aynı değer geri gelir", () => {
    const encrypted = encryptSecret(TOKEN);
    expect(encrypted).not.toContain(TOKEN);
    expect(isEncrypted(encrypted)).toBe(true);
    expect(decryptSecret(encrypted)).toBe(TOKEN);
  });

  it("aynı girdi her seferinde FARKLI şifreli metin üretir (rastgele IV)", () => {
    const a = encryptSecret(TOKEN);
    const b = encryptSecret(TOKEN);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(decryptSecret(b));
  });

  it("Türkçe karakterler ve uzun değerler bozulmadan döner", () => {
    const zor = "şğüöçİ-" + "x".repeat(500);
    expect(decryptSecret(encryptSecret(zor))).toBe(zor);
  });
});

describe("geçiş yolu (düz metin uyumluluğu)", () => {
  it("önek yoksa değer olduğu gibi döner — mevcut kayıtlar çalışmaya devam eder", () => {
    expect(decryptSecret(TOKEN)).toBe(TOKEN);
    expect(isEncrypted(TOKEN)).toBe(false);
  });

  it("düz metin değer şifreli sayılmaz", () => {
    expect(isEncrypted("enc:v0:baska")).toBe(false);
  });
});

describe("bütünlük ve anahtar hataları", () => {
  it("kurcalanmış şifreli metin SESSİZCE yanlış token üretmez", () => {
    const encrypted = encryptSecret(TOKEN);
    // Son karakteri değiştir — GCM auth tag'i bunu yakalamalı.
    const bozuk =
      encrypted.slice(0, -2) + (encrypted.endsWith("A=") ? "B=" : "A=");
    expect(() => decryptSecret(bozuk)).toThrow(SecretCryptoError);
  });

  it("yanlış anahtarla çözülemez", () => {
    const encrypted = encryptSecret(TOKEN);
    vi.stubEnv("ENCRYPTION_KEY", BASKA_KEY);
    expect(() => decryptSecret(encrypted)).toThrow(SecretCryptoError);
  });

  it("şifreli kayıt varken anahtar yoksa hata verir, düz metin döndürmez", () => {
    const encrypted = encryptSecret(TOKEN);
    vi.stubEnv("ENCRYPTION_KEY", "");
    expect(() => decryptSecret(encrypted)).toThrow(SecretCryptoError);
  });

  it("çok kısa şifreli değer reddedilir", () => {
    expect(() => decryptSecret("enc:v1:AAAA")).toThrow(SecretCryptoError);
  });

  it("yanlış uzunlukta anahtar 'yok' sayılmaz, HATA sayılır", () => {
    vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(16, 1).toString("base64"));
    expect(() => encryptSecret(TOKEN)).toThrow(SecretCryptoError);
  });
});

describe("anahtar yokken davranış", () => {
  it("production'da yazma PATLAR — sessizce düz metin yazılmaz", () => {
    vi.stubEnv("ENCRYPTION_KEY", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => encryptSecret(TOKEN)).toThrow(SecretCryptoError);
  });

  it("geliştirmede düz metne düşer ama yüksek sesle uyarır", () => {
    vi.stubEnv("ENCRYPTION_KEY", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(encryptSecret(TOKEN)).toBe(TOKEN);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("DÜZ METİN")
    );
  });

  it("encryptionConfigured anahtarın varlığını doğru bildirir", () => {
    expect(encryptionConfigured()).toBe(true);
    vi.stubEnv("ENCRYPTION_KEY", "");
    expect(encryptionConfigured()).toBe(false);
  });
});

/**
 * `scripts/token-sifrele.mjs` plain Node betiği olduğu için bu modülü içe
 * aktaramıyor ve şifreleme biçimini KOPYALIYOR. Sessizce ayrışmasınlar diye
 * betiğin ürettiği baytları burada elle kuruyoruz: biçim değişirse bu test
 * kırılır ve betiğin de güncellenmesi gerektiği görünür olur.
 */
describe("token-sifrele.mjs ile biçim uyumu", () => {
  it("betiğin ürettiği baytlar uygulamada çözülebilir", async () => {
    const { createCipheriv, randomBytes } = await import("node:crypto");
    const key = Buffer.from(KEY, "base64");

    // --- betikteki `sifrele()` ile birebir aynı adımlar ---
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(TOKEN, "utf8"), cipher.final()]);
    const betikCiktisi =
      "enc:v1:" + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");

    expect(decryptSecret(betikCiktisi)).toBe(TOKEN);
  });

  it("uygulamanın ürettiği değer betiğin beklediği yapıda (önek + 12B IV + 16B tag)", () => {
    const encrypted = encryptSecret(TOKEN);
    expect(encrypted.startsWith("enc:v1:")).toBe(true);
    const payload = Buffer.from(encrypted.slice("enc:v1:".length), "base64");
    // IV(12) + tag(16) + en az 1 bayt şifreli metin
    expect(payload.length).toBe(12 + 16 + Buffer.byteLength(TOKEN, "utf8"));
  });
});

describe("tryDecryptSecret", () => {
  it("çözebilirse değeri döner", () => {
    expect(tryDecryptSecret(encryptSecret(TOKEN))).toBe(TOKEN);
  });

  it("çözemezse null döner, throw etmez (kozmetik alanlar için)", () => {
    const encrypted = encryptSecret(TOKEN);
    vi.stubEnv("ENCRYPTION_KEY", BASKA_KEY);
    expect(tryDecryptSecret(encrypted)).toBeNull();
  });
});
