import { describe, expect, it } from "vitest";
import {
  CAPTION_MAX_LENGTH,
  MAX_IMAGES_PER_POST,
  MAX_PUBLISH_AHEAD_DAYS,
  validateCaption,
  validateClientEmail,
  validateClientName,
  MAX_VIDEO_BYTES,
  validateImageUrls,
  validateInstagramAccessToken,
  validateInstagramTokenExpiry,
  validateInstagramUserId,
  validatePostMedia,
  validatePublishAt,
  validateVideoUpload,
  validateVideoUrl,
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

describe("validateVideoUrl", () => {
  const blob = "https://abc123.public.blob.vercel-storage.com/videos/a.mp4";
  const raw = "https://raw.githubusercontent.com/enesmemduhoglu/furi/main/reels/a/v.mp4";

  it("Blob ve raw.githubusercontent host'larini kabul eder", () => {
    expect(validateVideoUrl(blob)).toBeNull();
    expect(validateVideoUrl(raw)).toBeNull();
    expect(validateVideoUrl(blob.replace(".mp4", ".mov"))).toBeNull();
  });

  it("dizi degil tek string bekler", () => {
    expect(validateVideoUrl([blob])).not.toBeNull();
    expect(validateVideoUrl(undefined)).not.toBeNull();
    expect(validateVideoUrl("")).not.toBeNull();
  });

  it("http ve diger semalari reddeder", () => {
    expect(validateVideoUrl("http://abc.public.blob.vercel-storage.com/v.mp4")).not.toBeNull();
    expect(validateVideoUrl("file:///tmp/a.mp4")).not.toBeNull();
  });

  it("allowlist disi host'lari reddeder", () => {
    expect(validateVideoUrl("https://evil.example.com/a.mp4")).not.toBeNull();
    // Sonek kontrolu benzer isimle kandirilamaz
    expect(
      validateVideoUrl("https://public.blob.vercel-storage.com.evil.com/a.mp4")
    ).not.toBeNull();
  });

  it("mp4/mov disi uzantilari reddeder", () => {
    expect(validateVideoUrl(blob.replace(".mp4", ".exe"))).not.toBeNull();
    expect(validateVideoUrl(blob.replace(".mp4", ""))).not.toBeNull();
  });
});

describe("validatePostMedia", () => {
  const image = "https://raw.githubusercontent.com/enesmemduhoglu/furi/main/dizi/a/1.jpg";
  const video = "https://abc123.public.blob.vercel-storage.com/videos/a.mp4";

  it("yalnizca gorsel gecerli", () => {
    expect(validatePostMedia([image], undefined)).toBeNull();
  });

  it("yalnizca video gecerli", () => {
    expect(validatePostMedia(undefined, video)).toBeNull();
  });

  it("ikisi birden reddedilir", () => {
    // Sema bu kisiti ifade edemiyor; kapi burasi. Gecseydi hangisinin
    // yayinlanacagi publish-post.ts'in dallanma sirasina kalirdi.
    expect(validatePostMedia([image], video)).not.toBeNull();
  });

  it("ikisi de yoksa reddedilir", () => {
    expect(validatePostMedia(undefined, undefined)).not.toBeNull();
    expect(validatePostMedia(null, null)).not.toBeNull();
  });

  it("secilen dalin kendi dogrulamasini uygular", () => {
    expect(validatePostMedia(undefined, "https://evil.example.com/a.mp4")).not.toBeNull();
    expect(validatePostMedia(["https://evil.example.com/1.jpg"], undefined)).not.toBeNull();
  });
});

describe("validateVideoUpload", () => {
  it("mp4 ve mov kabul eder", () => {
    expect(validateVideoUpload("video/mp4", 1024)).toBeNull();
    expect(validateVideoUpload("video/quicktime", 1024)).toBeNull();
  });

  it("baska tipleri reddeder", () => {
    expect(validateVideoUpload("image/jpeg", 1024)).not.toBeNull();
    expect(validateVideoUpload("application/octet-stream", 1024)).not.toBeNull();
    expect(validateVideoUpload(undefined, 1024)).not.toBeNull();
  });

  it("gecersiz boyutlari reddeder", () => {
    expect(validateVideoUpload("video/mp4", 0)).not.toBeNull();
    expect(validateVideoUpload("video/mp4", -1)).not.toBeNull();
    expect(validateVideoUpload("video/mp4", 1.5)).not.toBeNull();
    expect(validateVideoUpload("video/mp4", "1024")).not.toBeNull();
  });

  it("tavani asan boyutu reddeder", () => {
    expect(validateVideoUpload("video/mp4", MAX_VIDEO_BYTES)).toBeNull();
    expect(validateVideoUpload("video/mp4", MAX_VIDEO_BYTES + 1)).not.toBeNull();
  });
});
