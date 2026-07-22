export const CAPTION_MAX_LENGTH = 2000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateCaption(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "Caption boş olamaz";
  }
  if (value.length > CAPTION_MAX_LENGTH) {
    return `Caption en fazla ${CAPTION_MAX_LENGTH} karakter olabilir`;
  }
  return null;
}

export function validateClientName(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "Müşteri adı boş olamaz";
  }
  if (value.length > 200) {
    return "Müşteri adı en fazla 200 karakter olabilir";
  }
  return null;
}

export function validateClientEmail(value: unknown): string | null {
  if (typeof value !== "string" || !EMAIL_RE.test(value.trim())) {
    return "Geçerli bir e-posta adresi gir";
  }
  return null;
}
