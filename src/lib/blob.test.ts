import { describe, expect, it } from "vitest";
import { MAX_IMAGE_BYTES, validateImage } from "./blob";

describe("validateImage", () => {
  it("desteklenmeyen tipi reddeder", () => {
    expect(validateImage({ type: "image/gif", size: 100 })).not.toBeNull();
    expect(validateImage({ type: "application/pdf", size: 100 })).not.toBeNull();
  });

  it("10MB üzerini reddeder", () => {
    expect(validateImage({ type: "image/png", size: MAX_IMAGE_BYTES + 1 })).not.toBeNull();
  });

  it("boş dosyayı reddeder", () => {
    expect(validateImage({ type: "image/png", size: 0 })).not.toBeNull();
  });

  it("geçerli jpeg/png/webp'yi kabul eder", () => {
    expect(validateImage({ type: "image/jpeg", size: 1024 })).toBeNull();
    expect(validateImage({ type: "image/png", size: 1024 })).toBeNull();
    expect(validateImage({ type: "image/webp", size: MAX_IMAGE_BYTES })).toBeNull();
  });
});
