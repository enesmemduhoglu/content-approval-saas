import { describe, expect, it } from "vitest";
import {
  CAPTION_MAX_LENGTH,
  MAX_IMAGES_PER_POST,
  validateCaption,
  validateClientEmail,
  validateClientName,
  validateImageUrls,
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
