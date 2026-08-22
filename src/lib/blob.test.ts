import { describe, expect, it } from "vitest";
import { MAX_IMAGE_BYTES, detectImageTypeFromBytes, validateImage } from "./blob";

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

describe("detectImageTypeFromBytes", () => {
  it("JPEG imzasını (FF D8 FF) tanır", () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(detectImageTypeFromBytes(bytes)).toBe("image/jpeg");
  });

  it("PNG imzasını (89 50 4E 47 0D 0A 1A 0A) tanır", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    expect(detectImageTypeFromBytes(bytes)).toBe("image/png");
  });

  it("WebP imzasını (RIFF....WEBP) tanır", () => {
    const bytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x00, 0x00, 0x00, 0x00, // dosya boyutu (önemsiz)
      0x57, 0x45, 0x42, 0x50, // WEBP
    ]);
    expect(detectImageTypeFromBytes(bytes)).toBe("image/webp");
  });

  it("RIFF olup WEBP olmayan konteynerları (ör. AVI/WAV) reddeder", () => {
    const bytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x00, 0x00, 0x00, 0x00,
      0x41, 0x56, 0x49, 0x20, // AVI
    ]);
    expect(detectImageTypeFromBytes(bytes)).toBeNull();
  });

  it("tanınmayan/rastgele baytları reddeder", () => {
    expect(detectImageTypeFromBytes(new Uint8Array([0x00, 0x01, 0x02]))).toBeNull();
    expect(detectImageTypeFromBytes(new Uint8Array())).toBeNull();
  });

  it("bir PDF'in gerçek imzasını (%PDF) görsel olarak tanımaz", () => {
    const pdfBytes = new TextEncoder().encode("%PDF-1.4\n...");
    expect(detectImageTypeFromBytes(pdfBytes)).toBeNull();
  });
});
