import { describe, expect, it } from "vitest";
import {
  CAPTION_MAX_LENGTH,
  validateCaption,
  validateClientEmail,
  validateClientName,
} from "./validation";

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
