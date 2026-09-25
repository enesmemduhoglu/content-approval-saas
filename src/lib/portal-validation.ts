import { ALLOWED_VIDEO_TYPES, MAX_VIDEO_BYTES, validateVideoUpload } from "@/lib/validation";

/**
 * Video kuyruğu (V3) — portal isteklerinin doğrulaması.
 *
 * `validation.ts`'e eklenmedi: o dosya V2/V4 ile paralel değişebilecek ortak
 * bir yüzey; portalın kuralları kendi dosyasında durursa birleştirme çakışması
 * doğmaz. Video tipi/boyutu için yine `validation.ts` tek kaynak.
 */

export type FieldError = { error: string; field: string };

// ─── Ayarlar ────────────────────────────────────────────────────────────────

export const MAX_SLOTS = 6;
const SLOT_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type PublishSettingsInput = {
  slots: string[];
  timezone: string;
  requireApproval: boolean;
  paused: boolean;
  notifyEmail: string | null;
};

/**
 * IANA saat dilimi mi? `Intl` kendi veritabanına sorulur: elle tutulan bir
 * liste tick'in kullandığı çalışma zamanıyla ayrışabilirdi — liste kabul edip
 * `Intl` reddederse slot hesabı canlıda patlardı.
 */
export function isValidTimezone(value: string): boolean {
  if (!value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function validatePublishSettings(
  body: unknown
): { ok: true; value: PublishSettingsInput } | ({ ok: false } & FieldError) {
  const input = (body ?? {}) as Record<string, unknown>;

  const { slots } = input;
  if (!Array.isArray(slots) || slots.length < 1 || slots.length > MAX_SLOTS) {
    return { ok: false, field: "slots", error: `1 ile ${MAX_SLOTS} arasında yayın saati seç` };
  }
  for (const slot of slots) {
    if (typeof slot !== "string" || !SLOT_RE.test(slot)) {
      return { ok: false, field: "slots", error: `Geçersiz saat: ${String(slot)} (SS:DD olmalı)` };
    }
  }
  if (new Set(slots).size !== slots.length) {
    return { ok: false, field: "slots", error: "Aynı saat iki kez seçilemez" };
  }
  // "HH:MM" sıfır dolgulu olduğu için metin sıralaması saat sıralamasıdır.
  // İstemciden sıralı gelmesini şart koşmak yerine burada sıralanıyor: kural
  // "saklanan dizi sıralı" — tick ve e-postalar buna güvenebilsin.
  const sorted = [...(slots as string[])].sort();

  const { timezone } = input;
  if (typeof timezone !== "string" || !isValidTimezone(timezone)) {
    return { ok: false, field: "timezone", error: "Geçersiz saat dilimi" };
  }
  if (typeof input.requireApproval !== "boolean") {
    return { ok: false, field: "requireApproval", error: "Onay ayarı açık ya da kapalı olmalı" };
  }
  if (typeof input.paused !== "boolean") {
    return { ok: false, field: "paused", error: "Duraklatma ayarı açık ya da kapalı olmalı" };
  }
  let notifyEmail: string | null = null;
  if (input.notifyEmail !== undefined && input.notifyEmail !== null && input.notifyEmail !== "") {
    if (
      typeof input.notifyEmail !== "string" ||
      input.notifyEmail.length > 254 ||
      !EMAIL_RE.test(input.notifyEmail.trim())
    ) {
      return { ok: false, field: "notifyEmail", error: "Geçerli bir e-posta adresi gir" };
    }
    notifyEmail = input.notifyEmail.trim();
  }

  return {
    ok: true,
    value: {
      slots: sorted,
      timezone,
      requireApproval: input.requireApproval,
      paused: input.paused,
      notifyEmail,
    },
  };
}

// ─── Yükleme ────────────────────────────────────────────────────────────────

/** Tek istekte başlatılabilecek dosya sayısı — toplu yükleme (20 video) tek istekte sığsın. */
export const MAX_FILES_PER_UPLOAD = 20;
export const FRAME_COUNT = 6;
/** Tarayıcının çıkardığı JPEG kare için üst sınır; daha büyüğü kareye benzemiyor. */
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;

export type UploadFileInput = { contentType: string; size: number; ext: string };

export function validateUploadFiles(
  body: unknown
): { ok: true; files: UploadFileInput[] } | ({ ok: false } & FieldError) {
  const files = (body as { files?: unknown } | null)?.files;
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, field: "files", error: "En az bir video seç" };
  }
  if (files.length > MAX_FILES_PER_UPLOAD) {
    return {
      ok: false,
      field: "files",
      error: `Tek seferde en fazla ${MAX_FILES_PER_UPLOAD} video yüklenebilir`,
    };
  }
  const out: UploadFileInput[] = [];
  for (const file of files) {
    const { contentType, size } = (file ?? {}) as { contentType?: unknown; size?: unknown };
    const error = validateVideoUpload(contentType, size);
    if (error) return { ok: false, field: "files", error };
    out.push({
      contentType: contentType as string,
      size: size as number,
      ext: ALLOWED_VIDEO_TYPES[contentType as string],
    });
  }
  return { ok: true, files: out };
}

// ─── Çok parçalı yükleme (V7b) ─────────────────────────────────────────────

/**
 * Bu boyuttan büyük video çok parçalı yüklenir. Altında tek PUT kalıyor:
 * 16 MB telefonda birkaç saniyelik bir yükleme — kopsa bile baştan göndermek
 * ucuz, parça başına ek istek (imza + ETag toplama) ise boşa karmaşa. Eşik
 * ≥ 2 parça demek; tek parçalık bir çok parçalı yükleme hiçbir şey kazandırmaz.
 */
export const MULTIPART_THRESHOLD_BYTES = 16 * 1024 * 1024;
/**
 * Parça boyutu. S3/R2 alt sınırı 5 MB (son parça hariç). 8 MB: 150 MB ≈ 19
 * parça; kopan bir parça telefonda en fazla birkaç saniyelik iş kaybettirir,
 * parça sayısı da imza isteğini küçük tutar.
 */
export const MULTIPART_PART_SIZE = 8 * 1024 * 1024;
/**
 * Kabul edilen en büyük parça numarası. S3 protokolü 10000'e izin veriyor ama
 * video sınırı (300 MB) 8 MB'lık parçalarla 38 parçaya sığıyor; sınırı
 * burada tutmak, sızmış bir oturumun binlerce parça imzalatıp R2'ye
 * tamamlanmamış (görünmez) veri yığmasını keser.
 */
export const MAX_PART_NUMBER = Math.ceil(MAX_VIDEO_BYTES / MULTIPART_PART_SIZE);
/** Tek imza isteğinde en fazla bu kadar parça — yanıt küçük, URL'ler taze kalsın. */
export const MAX_PARTS_PER_SIGN = 20;

const isPartNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_PART_NUMBER;

export function validatePartNumbers(
  body: unknown
): { ok: true; partNumbers: number[]; includeFrames: boolean } | ({ ok: false } & FieldError) {
  const input = (body ?? {}) as { partNumbers?: unknown; includeFrames?: unknown };
  const { partNumbers } = input;
  if (!Array.isArray(partNumbers) || partNumbers.length === 0) {
    return { ok: false, field: "partNumbers", error: "En az bir parça numarası gerekli" };
  }
  if (partNumbers.length > MAX_PARTS_PER_SIGN) {
    return {
      ok: false,
      field: "partNumbers",
      error: `Tek istekte en fazla ${MAX_PARTS_PER_SIGN} parça imzalanır`,
    };
  }
  if (!partNumbers.every(isPartNumber)) {
    return { ok: false, field: "partNumbers", error: `Parça numarası 1–${MAX_PART_NUMBER} arası tam sayı olmalı` };
  }
  if (new Set(partNumbers).size !== partNumbers.length) {
    return { ok: false, field: "partNumbers", error: "Aynı parça iki kez istenemez" };
  }
  if (input.includeFrames !== undefined && typeof input.includeFrames !== "boolean") {
    return { ok: false, field: "includeFrames", error: "includeFrames açık ya da kapalı olmalı" };
  }
  return { ok: true, partNumbers, includeFrames: input.includeFrames === true };
}

/**
 * ETag biçimi bilerek gevşek (bugün R2'de tırnaklı 32 hane hex): biçimi
 * sıkı tutmak R2 bir gün başka bir biçim döndürdüğünde bütün büyük
 * yüklemeleri kırardı. Asıl doğrulamayı R2 yapıyor — tutmayan ETag'e
 * `InvalidPart` döner (gerçek bucket'ta denendi). Buradaki kapı yalnızca
 * gövdeye keyfi metin taşınmasını kesiyor.
 */
const ETAG_RE = /^"?[A-Za-z0-9-]{1,128}"?$/;

/**
 * `complete` gövdesindeki parça listesi. Liste 1..N kesintisiz olmalı: istemci
 * parçaları 1'den başlayarak sırayla bölüyor, yani bir boşluk "o parça hiç
 * yüklenmedi" demek. R2 boşluklu listeyi birleştirirdi — ortası eksik bir
 * video olarak. Onu kuyruğa sokmak yerine burada 400.
 *
 * `uploadId` gövdeden OKUNMAZ; kaynağı her zaman `Post.uploadId`.
 */
export function validateCompleteParts(
  value: unknown
): { ok: true; parts: { partNumber: number; etag: string }[] } | ({ ok: false } & FieldError) {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, field: "parts", error: "Yüklenen parçaların listesi gerekli" };
  }
  if (value.length > MAX_PART_NUMBER) {
    return { ok: false, field: "parts", error: "Parça sayısı sınırı aştı" };
  }
  const parts: { partNumber: number; etag: string }[] = [];
  for (const item of value) {
    const { partNumber, etag } = (item ?? {}) as { partNumber?: unknown; etag?: unknown };
    if (!isPartNumber(partNumber)) {
      return { ok: false, field: "parts", error: "Geçersiz parça numarası" };
    }
    if (typeof etag !== "string" || !ETAG_RE.test(etag)) {
      return { ok: false, field: "parts", error: `${partNumber}. parçanın ETag'i geçersiz` };
    }
    parts.push({ partNumber, etag });
  }
  parts.sort((a, b) => a.partNumber - b.partNumber);
  for (const [index, part] of parts.entries()) {
    if (part.partNumber !== index + 1) {
      return {
        ok: false,
        field: "parts",
        error:
          part.partNumber === index
            ? `${part.partNumber}. parça iki kez gönderildi`
            : `${index + 1}. parça eksik — yükleme tamamlanmamış`,
      };
    }
  }
  return { ok: true, parts };
}

// ─── Diğer ──────────────────────────────────────────────────────────────────

export const REGENERATE_NOTE_MAX = 500;

export function validateRegenerateNote(value: unknown): { ok: true; note?: string } | ({ ok: false } & FieldError) {
  if (value === undefined || value === null || value === "") return { ok: true };
  if (typeof value !== "string") return { ok: false, field: "note", error: "Not metin olmalı" };
  const note = value.trim();
  if (note.length > REGENERATE_NOTE_MAX) {
    return { ok: false, field: "note", error: `Not en fazla ${REGENERATE_NOTE_MAX} karakter olabilir` };
  }
  return note ? { ok: true, note } : { ok: true };
}

export function validateMoveTarget(
  body: unknown
): { ok: true; beforeId?: string; afterId?: string } | ({ ok: false } & FieldError) {
  const { beforeId, afterId } = (body ?? {}) as { beforeId?: unknown; afterId?: unknown };
  const isId = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);
  if (beforeId !== undefined && beforeId !== null && !isId(beforeId)) {
    return { ok: false, field: "beforeId", error: "Geçersiz hedef" };
  }
  if (afterId !== undefined && afterId !== null && !isId(afterId)) {
    return { ok: false, field: "afterId", error: "Geçersiz hedef" };
  }
  if (!beforeId && !afterId) {
    return { ok: false, field: "beforeId", error: "Taşımak için bir komşu video gerekli" };
  }
  return {
    ok: true,
    beforeId: (beforeId as string | undefined) || undefined,
    afterId: (afterId as string | undefined) || undefined,
  };
}
