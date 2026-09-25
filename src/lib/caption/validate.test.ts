import { describe, expect, it } from "vitest";
import { composeCaption, MAX_HASHTAGS, MIN_HASHTAGS, validateDraft } from "./validate";
import { CAPTION_MAX_LENGTH } from "@/lib/validation";

function tags(n: number, prefix = "#etiket"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    aciklama: "Gramer kitabına göre böyle söylenir.\n\nKaydet, lazım olur.",
    hashtagler: tags(12),
    altText: "Dikey video: bir el kâğıda cümle yazıyor.",
    ...overrides,
  };
}

describe("composeCaption", () => {
  it("açıklama ile hashtag satırını boş bir satırla birleştirir", () => {
    expect(composeCaption({ aciklama: "  Merhaba  ", hashtagler: ["#a", "#b"] })).toBe(
      "Merhaba\n\n#a #b"
    );
  });
});

describe("validateDraft", () => {
  it("geçerli taslağı kabul eder ve son caption'ı üretir", () => {
    const res = validateDraft(draft());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.caption).toBe(composeCaption(res.draft));
    expect(res.caption.endsWith(tags(12).join(" "))).toBe(true);
  });

  it(`${MIN_HASHTAGS} ve ${MAX_HASHTAGS} hashtag sınırlarını kabul eder`, () => {
    expect(validateDraft(draft({ hashtagler: tags(MIN_HASHTAGS) })).ok).toBe(true);
    expect(validateDraft(draft({ hashtagler: tags(MAX_HASHTAGS) })).ok).toBe(true);
  });

  it("sınırın bir altını ve bir üstünü reddeder", () => {
    expect(validateDraft(draft({ hashtagler: tags(MIN_HASHTAGS - 1) })).ok).toBe(false);
    expect(validateDraft(draft({ hashtagler: tags(MAX_HASHTAGS + 1) })).ok).toBe(false);
  });

  it("# ile başlamayan, boşluk ya da ikinci # içeren etiketi reddeder", () => {
    for (const bad of ["ingilizce", "#ingilizce öğren", "#a#b", "#"]) {
      const res = validateDraft(draft({ hashtagler: [...tags(11), bad] }));
      expect(res.ok, bad).toBe(false);
    }
  });

  it("büyük/küçük harf farkıyla (Türkçe İ dahil) tekrar eden etiketi reddeder", () => {
    const res = validateDraft(draft({ hashtagler: [...tags(10), "#İngilizce", "#ingilizce"] }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.problems.join(" ")).toContain("Tekrarlanan");
  });

  it("boş ya da yalnızca boşluktan oluşan alanları reddeder", () => {
    expect(validateDraft(draft({ aciklama: "   " })).ok).toBe(false);
    expect(validateDraft(draft({ altText: "" })).ok).toBe(false);
    expect(validateDraft(draft({ hashtagler: undefined })).ok).toBe(false);
    expect(validateDraft(null).ok).toBe(false);
    expect(validateDraft("metin").ok).toBe(false);
  });

  it("toplam uzunluk tam sınırdaysa kabul eder, bir fazlasında reddeder", () => {
    const hashtagler = tags(12);
    const tail = `\n\n${hashtagler.join(" ")}`.length;
    const tam = "a".repeat(CAPTION_MAX_LENGTH - tail);
    const ok = validateDraft(draft({ aciklama: tam, hashtagler }));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.caption.length).toBe(CAPTION_MAX_LENGTH);

    const fazla = validateDraft(draft({ aciklama: `${tam}a`, hashtagler }));
    expect(fazla.ok).toBe(false);
    if (!fazla.ok) expect(fazla.problems.join(" ")).toContain(String(CAPTION_MAX_LENGTH));
  });

  it("birden çok sorunu birlikte raporlar", () => {
    const res = validateDraft({ aciklama: "", hashtagler: ["yanlis"], altText: "" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.problems.length).toBeGreaterThanOrEqual(3);
  });
});
