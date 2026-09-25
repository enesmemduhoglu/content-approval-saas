import { ALLOWED_VIDEO_TYPES, validateVideoUpload } from "@/lib/validation";

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
