import { CAPTION_MAX_LENGTH } from "@/lib/validation";

/**
 * Video kuyruğu (V2) — Claude çıktısının kod tarafında doğrulanması.
 *
 * Model talimata çoğu zaman uyar ama "çoğu zaman" yayına giden metin için
 * yetmez: 2000 karakteri aşan caption panelden kaydedilemez (`validation.ts`),
 * 30'dan fazla hashtag'i Instagram reddeder, boş alt text erişilebilirliği
 * sessizce öldürür. Kurallar burada tek yerde; `run.ts` geçmeyen çıktıyı bir
 * kez yeniden ürettirir, yine geçmezse post `failed` olur.
 */

export const MIN_HASHTAGS = 10;
export const MAX_HASHTAGS = 15;

export type CaptionDraft = { aciklama: string; hashtagler: string[]; altText: string };

export type DraftValidation =
  | { ok: true; draft: CaptionDraft; caption: string }
  | { ok: false; problems: string[] };

/** Boşluksuz, `#` ile başlayan, içinde ikinci bir `#` olmayan tek etiket. */
const HASHTAG_RE = /^#[^\s#]+$/u;

/**
 * `Post.caption`a yazılacak son metin. Hashtag'ler tek satırda, açıklamadan
 * boş bir satırla ayrılmış — sayfada yayınlanmış caption'ların düzeni bu ve
 * portalda düzenlerken iki parçayı gözle ayırmak kolay.
 */
export function composeCaption(draft: Pick<CaptionDraft, "aciklama" | "hashtagler">): string {
  return `${draft.aciklama.trim()}\n\n${draft.hashtagler.map((h) => h.trim()).join(" ")}`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Ham model çıktısını (`JSON.parse` sonucu, yani `unknown`) doğrular. Şema
 * kısıtlı çıktı (structured outputs) biçimi garanti eder ama sayı ve uzunluk
 * sınırlarını değil — o yüzden tipler de burada yeniden kontrol ediliyor.
 *
 * Kurallar düzeltilmez, reddedilir: eksik `#`i sessizce eklemek ya da
 * fazla etiketi kırpmak modelin talimatı neden kaçırdığını gizlerdi; yeniden
 * üretimde sorunlar modele geri söyleniyor.
 */
export function validateDraft(raw: unknown): DraftValidation {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, problems: ["Çıktı bir nesne değil"] };
  }
  const obj = raw as Record<string, unknown>;
  const problems: string[] = [];

  const aciklama = typeof obj.aciklama === "string" ? obj.aciklama.trim() : null;
  const altText = typeof obj.altText === "string" ? obj.altText.trim() : null;
  const hashtagler = isStringArray(obj.hashtagler) ? obj.hashtagler.map((h) => h.trim()) : null;

  if (!aciklama) problems.push("Açıklama boş");
  if (!altText) problems.push("Alt text boş");

  if (!hashtagler) {
    problems.push("Hashtag listesi yok");
  } else {
    if (hashtagler.length < MIN_HASHTAGS || hashtagler.length > MAX_HASHTAGS) {
      problems.push(
        `Hashtag sayısı ${hashtagler.length}; ${MIN_HASHTAGS}–${MAX_HASHTAGS} arası olmalı`
      );
    }
    const invalid = hashtagler.filter((h) => !HASHTAG_RE.test(h));
    if (invalid.length > 0) {
      problems.push(
        `Geçersiz hashtag (# ile başlamalı, boşluk içermemeli): ${invalid
          .map((h) => JSON.stringify(h))
          .join(", ")}`
      );
    }
    // Instagram etiketleri büyük/küçük harf ayırmadan eşler; "#İngilizce" ile
    // "#ingilizce" aynı etikettir. Türkçe küçültme: "İ" → "i", "I" → "ı".
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const h of hashtagler) {
      const key = h.toLocaleLowerCase("tr");
      if (seen.has(key)) dupes.add(h);
      seen.add(key);
    }
    if (dupes.size > 0) problems.push(`Tekrarlanan hashtag: ${[...dupes].join(", ")}`);
  }

  if (aciklama && hashtagler) {
    const length = composeCaption({ aciklama, hashtagler }).length;
    if (length > CAPTION_MAX_LENGTH) {
      problems.push(
        `Açıklama + hashtag'ler ${length} karakter; en fazla ${CAPTION_MAX_LENGTH} olmalı`
      );
    }
  }

  if (problems.length > 0 || !aciklama || !altText || !hashtagler) {
    return { ok: false, problems };
  }
  const draft = { aciklama, hashtagler, altText };
  return { ok: true, draft, caption: composeCaption(draft) };
}
