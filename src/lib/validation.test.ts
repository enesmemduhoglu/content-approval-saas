import { describe, expect, it } from "vitest";
import {
  CAPTION_MAX_LENGTH,
  MAX_IMAGES_PER_POST,
  MAX_PUBLISH_AHEAD_DAYS,
  validateCaption,
  validateClientEmail,
  validateClientName,
  validateImageUrls,
  validateInstagramAccessToken,
  validateInstagramTokenExpiry,
  validateInstagramUserId,
  validatePublishAt,
} from "./validation";

describe("validateImageUrls", () => {
  const ok = "https://raw.githubusercontent.com/enesmemduhoglu/furi/main/dizi/a/1.jpg";

  it("izinli host'tan https URL'leri kabul eder", () => {
    expect(validateImageUrls([ok])).toBeNull();
    expect(validateImageUrls([ok, ok])).toBeNull();
  });

  it("boş listeyi reddeder", () => {
    expect(validateImageUrls([])).not.toBeNull();
    expect(validateImageUrls(undefined)).not.toBeNull();
    expect(validateImageUrls("tek-url")).not.toBeNull();
  });

  it("http ve diğer şemaları reddeder", () => {
    expect(validateImageUrls(["http://raw.githubusercontent.com/a/1.jpg"])).not.toBeNull();
    expect(validateImageUrls(["file:///etc/passwd"])).not.toBeNull();
    expect(validateImageUrls(["javascript:alert(1)"])).not.toBeNull();
  });

  it("allowlist dışı host'ları reddeder", () => {
    expect(validateImageUrls(["https://evil.example.com/1.jpg"])).not.toBeNull();
    // Alt alan adı ya da benzer isim de geçmez
    expect(
      validateImageUrls(["https://raw.githubusercontent.com.evil.com/1.jpg"])
    ).not.toBeNull();
  });

  it("bozuk URL'leri reddeder", () => {
    expect(validateImageUrls(["bu bir url değil"])).not.toBeNull();
    expect(validateImageUrls([""])).not.toBeNull();
    expect(validateImageUrls([123])).not.toBeNull();
  });

  it(`${MAX_IMAGES_PER_POST} sınırını aşan listeyi reddeder`, () => {
    expect(validateImageUrls(Array.from({ length: MAX_IMAGES_PER_POST }, () => ok))).toBeNull();
    expect(
      validateImageUrls(Array.from({ length: MAX_IMAGES_PER_POST + 1 }, () => ok))
    ).not.toBeNull();
  });
});

describe("validateCaption", () => {
  it("boş caption'ı reddeder", () => {
    expect(validateCaption("")).not.toBeNull();
    expect(validateCaption("   ")).not.toBeNull();
    expect(validateCaption(undefined)).not.toBeNull();
    expect(validateCaption(null)).not.toBeNull();
  });

  it("çok uzun caption'ı reddeder", () => {
    expect(validateCaption("a".repeat(CAPTION_MAX_LENGTH + 1))).not.toBeNull();
  });

  it("geçerli caption'ı kabul eder", () => {
    expect(validateCaption("Yeni koleksiyon yayında! 🎉")).toBeNull();
    expect(validateCaption("a".repeat(CAPTION_MAX_LENGTH))).toBeNull();
  });
});

describe("validateClientName", () => {
  it("boş adı reddeder", () => {
    expect(validateClientName("")).not.toBeNull();
    expect(validateClientName("  ")).not.toBeNull();
  });

  it("geçerli adı kabul eder", () => {
    expect(validateClientName("Kahve Dükkanı")).toBeNull();
  });
});

describe("validateClientEmail", () => {
  it("geçersiz e-postaları reddeder", () => {
    expect(validateClientEmail("degil")).not.toBeNull();
    expect(validateClientEmail("a@b")).not.toBeNull();
    expect(validateClientEmail("")).not.toBeNull();
    expect(validateClientEmail(undefined)).not.toBeNull();
  });

  it("geçerli e-postayı kabul eder", () => {
    expect(validateClientEmail("musteri@ornek.com")).toBeNull();
  });
});

describe("validateInstagramAccessToken", () => {
  const ok = "IGAAtest0000000000000000000000000000token";

  it("boş, kısa ve boşluklu token'ı reddeder", () => {
    expect(validateInstagramAccessToken("")).not.toBeNull();
    expect(validateInstagramAccessToken("   ")).not.toBeNull();
    expect(validateInstagramAccessToken("IGAAkisa")).not.toBeNull();
    expect(validateInstagramAccessToken(`${ok.slice(0, 20)} ${ok.slice(20)}`)).not.toBeNull();
    expect(validateInstagramAccessToken(undefined)).not.toBeNull();
  });

  it("501 karakterlik token'ı reddeder", () => {
    expect(validateInstagramAccessToken("a".repeat(501))).not.toBeNull();
  });

  it("makul uzunlukta token'ı kabul eder", () => {
    expect(validateInstagramAccessToken(ok)).toBeNull();
    expect(validateInstagramAccessToken(`  ${ok}  `)).toBeNull();
  });
});

describe("validateInstagramUserId", () => {
  it("rakam dışı içeriği reddeder", () => {
    expect(validateInstagramUserId("abc")).not.toBeNull();
    expect(validateInstagramUserId("1784140000000000a")).not.toBeNull();
    expect(validateInstagramUserId("")).not.toBeNull();
  });

  it("IG hesap kimliğini kabul eder", () => {
    expect(validateInstagramUserId("17841400000000000")).toBeNull();
  });
});

describe("validateInstagramTokenExpiry", () => {
  it("boş ve anlamsız tarihi reddeder", () => {
    expect(validateInstagramTokenExpiry("")).not.toBeNull();
    expect(validateInstagramTokenExpiry("yarin")).not.toBeNull();
  });

  it("geçmiş tarihi reddeder", () => {
    expect(validateInstagramTokenExpiry("2020-01-01")).not.toBeNull();
  });

  it("gelecekteki tarihi kabul eder", () => {
    expect(validateInstagramTokenExpiry("2099-10-15")).toBeNull();
  });
});

describe("validatePublishAt", () => {
  it("boş/undefined/null'ı kabul eder — zamanlama yok demek", () => {
    expect(validatePublishAt(undefined)).toBeNull();
    expect(validatePublishAt(null)).toBeNull();
    expect(validatePublishAt("")).toBeNull();
  });

  it("string olmayanı ve anlamsız tarihi reddeder", () => {
    expect(validatePublishAt(123)).not.toBeNull();
    expect(validatePublishAt("yarin")).not.toBeNull();
  });

  it("geçmiş tarihi reddeder", () => {
    expect(validatePublishAt("2020-01-01T09:00:00+03:00")).not.toBeNull();
  });

  it(`${MAX_PUBLISH_AHEAD_DAYS} günden uzağı reddeder`, () => {
    const cokUzak = new Date(
      Date.now() + (MAX_PUBLISH_AHEAD_DAYS + 5) * 24 * 60 * 60 * 1000
    ).toISOString();
    expect(validatePublishAt(cokUzak)).not.toBeNull();
  });

  it("makul gelecekteki tarihi kabul eder", () => {
    const yarin = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    expect(validatePublishAt(yarin)).toBeNull();
  });
});
