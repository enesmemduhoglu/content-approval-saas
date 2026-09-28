/**
 * Portal — `publishError`ın müşteriye okunur hâli (2026-09-28 analizi).
 *
 * `publishError` ajans paneli için teşhis metni: `IGError.report()`
 * ("Media upload has failed · type=OAuthException · code=2207026 ·
 * fbtrace_id=…") ya da `publish-post`un kendi cümleleri. Portal bunu olduğu
 * gibi gösteriyordu; müşteri ne olduğunu da ne yapacağını da anlamıyordu.
 * Burada hata BİLİNEN bir türe eşlenir; ham metin "Teknik ayrıntı"da kalır
 * (ajansa iletirken lazım).
 *
 * Kodlar Meta Graph API'nin Instagram içerik yayınlama hatalarından. Tanımadığımız
 * her şey `unknown`: yanlış bir teşhis koymaktansa "tekrar dene, olmazsa haber ver".
 */

export type PublishErrorKind =
  | "auth"
  | "limit"
  | "restricted"
  | "format"
  | "fetch"
  | "temporary"
  | "server"
  | "unknown";

export type PublishErrorView = {
  kind: PublishErrorKind;
  /** Kısa başlık — kuyruk kartında tek başına da anlaşılır olmalı. */
  title: string;
  body: string;
  /** "Ne yapmalı" satırı. */
  todo: string;
  /** Aynı dosyayla tekrar denemek büyük ihtimalle yine başarısız olur. */
  retryUseless: boolean;
  /** Ham metin; boşsa ayrıntı gösterilmez. */
  raw: string;
};

const TEXT: Record<PublishErrorKind, Omit<PublishErrorView, "kind" | "raw">> = {
  auth: {
    title: "Instagram bağlantısı geçersiz",
    body: "Instagram erişim izni iptal edilmiş ya da süresi dolmuş. Ajansına haber verdik.",
    todo: "Bağlantı yenilenince “Tekrar dene”ye bas. O zamana kadar video sırasında bekler.",
    retryUseless: false,
  },
  limit: {
    title: "Instagram şu an yoğun",
    body: "Instagram kısa süreliğine yeni gönderi kabul etmedi. Videoda bir sorun yok.",
    todo: "“Tekrar dene”ye bas; video sıradaki yayın saatinde yeniden gönderilir.",
    retryUseless: false,
  },
  restricted: {
    title: "Instagram hesabı geçici olarak kısıtlı",
    body: "Instagram bu hesaptan yayını bir süreliğine durdurdu. Videoda bir sorun yok.",
    todo: "Birkaç saat bekleyip “Tekrar dene”ye bas. Sürerse ajansına haber ver.",
    retryUseless: false,
  },
  format: {
    title: "Instagram videoyu kabul etmedi",
    body: "Videonun biçimi Instagram’ın Reels kurallarına uymuyor (kare hızı, ses ya da çözünürlük).",
    todo: "Videoyu telefonda yeniden dışa aktar (1080p, 30 fps) ve yeniden yükle.",
    retryUseless: true,
  },
  fetch: {
    title: "Instagram videoyu indiremedi",
    body: "Instagram videoyu bizden alırken sorun yaşadı. Genelde geçicidir.",
    todo: "“Tekrar dene”ye bas; video sıradaki yayın saatinde yeniden gönderilir.",
    retryUseless: false,
  },
  temporary: {
    title: "Instagram’a ulaşılamadı",
    body: "Instagram o an yanıt vermedi ya da videoyu zamanında işleyemedi. Videoda bir sorun yok.",
    todo: "“Tekrar dene”ye bas; video sıradaki yayın saatinde yeniden gönderilir.",
    retryUseless: false,
  },
  server: {
    title: "Yayın sunucuda takıldı",
    body: "Sorun bizim tarafımızda, videoda değil. Ajansına haber verdik.",
    todo: "Düzeltilince “Tekrar dene”ye bas.",
    retryUseless: false,
  },
  unknown: {
    title: "Instagram’a yayınlanamadı",
    body: "Instagram yayını kabul etmedi.",
    todo: "“Tekrar dene”ye bas. Yine olursa ajansına “Teknik ayrıntı”yı ilet.",
    retryUseless: false,
  },
};

const AUTH_CODES = new Set([190, 102, 10, 200]);
const LIMIT_CODES = new Set([4, 17, 32, 341, 613, 80002, 2207042]);
const FORMAT_CODES = new Set([
  352, 36000, 36001, 36003, 36004, 2207004, 2207005, 2207009, 2207010, 2207023, 2207026, 2207053,
]);
const FETCH_CODES = new Set([9004, 2207003, 2207020, 2207052]);
const TEMPORARY_CODES = new Set([1, 2, 2207001]);

/** Metindeki Meta hata kodları: `code=…`, `error_subcode=…`, "error code …". */
export function errorCodes(raw: string): number[] {
  const codes: number[] = [];
  for (const match of raw.matchAll(/(?:\bcode=|error_subcode=|error code )(-?\d+)/gi)) {
    codes.push(Number(match[1]));
  }
  return codes;
}

export function classifyPublishError(raw: string): PublishErrorKind {
  const codes = errorCodes(raw);
  // Alt kod ana koddan daha özgül (ör. code=9 + subcode=2207051): önce onlar.
  if (codes.includes(2207051)) return "restricted";
  if (codes.includes(2207050)) return "restricted";
  if (codes.some((c) => FORMAT_CODES.has(c))) return "format";
  if (codes.some((c) => FETCH_CODES.has(c))) return "fetch";
  if (codes.some((c) => LIMIT_CODES.has(c))) return "limit";
  if (codes.some((c) => AUTH_CODES.has(c))) return "auth";
  if (codes.some((c) => TEMPORARY_CODES.has(c))) return "temporary";

  // `publish-post`un ve `instagram.ts`in kendi cümleleri (kodsuz).
  // Türkçe küçültme "I"yı "ı" yapar ("ENCRYPTION" → "encryptıon"): İngilizce
  // anahtar kelime ham metinde aranır.
  if (raw.includes("ENCRYPTION_KEY")) return "server";
  const text = raw.toLocaleLowerCase("tr");
  if (text.includes("token") || text.includes("bağlı değil") || text.includes("erişim izni")) return "auth";
  if (
    text.includes("ulaşılamadı") ||
    text.includes("hazır olmadı") ||
    text.includes("ömrü doldu") ||
    /http 5\d\d/.test(text)
  ) {
    return "temporary";
  }
  return "unknown";
}

/** `raw` boşsa (eski kayıt) yine de anlamlı bir görünüm döner. */
export function explainPublishError(raw: string | null | undefined): PublishErrorView {
  const text = (raw ?? "").trim();
  const kind = text ? classifyPublishError(text) : "unknown";
  return { kind, ...TEXT[kind], raw: text };
}
