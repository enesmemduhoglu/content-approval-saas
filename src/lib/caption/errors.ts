/**
 * Caption hattının (transkript → üretim → doğrulama) dış hata tipi.
 *
 * Neden ayrı bir sınıf: orkestrasyon (`run.ts`) her hatada iki soruya cevap
 * vermek zorunda — (1) portalda kullanıcıya ne yazılacak, (2) QStash işi tekrar
 * denemeli mi. Bu iki bilgi hatanın DOĞDUĞU yerde biliniyor (fal'ın 503'ü
 * geçicidir, Claude'un reddi kalıcıdır); yukarıda mesaj metnine bakarak tahmin
 * etmek hem kırılgan hem de SDK mesajlarının içindeki ayrıntıyı (istek kimliği,
 * URL) `captionError`a taşıma riski taşırdı.
 *
 * `publicReason` DB'ye ve portala gider: kısa, Türkçe, sır içermez.
 * `detail` yalnızca operatör uyarısına gider; yine de anahtar/URL taşımaz —
 * imzalı URL'lerin sorgu dizisi geçici bir kimlik bilgisidir.
 */
export type CaptionStep = "config" | "storage" | "transcribe" | "generate";

export class CaptionStepError extends Error {
  readonly step: CaptionStep;
  readonly retryable: boolean;
  readonly publicReason: string;
  readonly detail: string | undefined;

  constructor(opts: {
    step: CaptionStep;
    retryable: boolean;
    publicReason: string;
    detail?: string;
  }) {
    super(opts.publicReason);
    this.name = "CaptionStepError";
    this.step = opts.step;
    this.retryable = opts.retryable;
    this.publicReason = opts.publicReason;
    this.detail = opts.detail;
  }
}

/**
 * Modelin döndürdüğü metin JSON olarak çözülemedi ya da kesildi. Dış hata
 * DEĞİL, içerik hatası: `run.ts` bunu doğrulamadan geçmeyen çıktıyla aynı
 * kefeye koyar ve bir kez yeniden üretir.
 */
export class InvalidModelOutputError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidModelOutputError";
  }
}

/** HTTP durum kodundan "tekrar denemeye değer mi" kararı — iki servis için ortak. */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true; // bağlantı kopması, zaman aşımı
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** Uyarı gövdesine giden metinden imzalı URL'leri ve olası anahtarları ayıklar. */
export function safeDetail(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/(key|token|secret|authorization)[=:]\s*\S+/gi, "$1=<gizli>")
    .slice(0, 300);
}
