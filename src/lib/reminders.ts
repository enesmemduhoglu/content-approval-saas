/**
 * "Bu bekleyen posta ne yapmalı?" sorusunun TEK yeri (F3).
 *
 * Neden var: post `pending`'de sonsuza kadar durabiliyordu. Müşteri postu
 * görmediyse ya da unuttuysa kimse dürtmüyor, ajans da ancak panele bakarsa
 * fark ediyordu. Onay linki 7 günde ölünce iş sessizce tamamen tıkanıyordu.
 *
 * `instagram-token.ts` ile aynı desen: karar SAF bir yüklem, ne DB'ye ne ağa
 * dokunur; cron yalnızca kararı uygular. Böylece bütün kenar durumlar tek
 * dosyada ve testte toplanır.
 *
 * ─── İki ayrı olay, iki ayrı muhatap ────────────────────────────────────────
 * • `client_reminder`  — link HÂLÂ GEÇERLİ ve post N gündür bekliyor.
 *   Muhatap müşteri: yapabileceği bir şey var (linke tıkla, karar ver).
 * • `agency_expiry_notice` — link ÖLMÜŞ ama post hâlâ bekliyor.
 *   Muhatap ajans: müşteriye hatırlatmanın anlamı yok, elindeki link çalışmıyor;
 *   yenilemesi gereken ajans (F1'deki "Yeni link gönder").
 *
 * ─── Her ikisi de TEK SEFERLİK ──────────────────────────────────────────────
 * Cron her gece koşuyor. Gönderim damgaları (`reminderSentAt`,
 * `expiryNoticeSentAt`) dolu olduğunda karar `none`'a düşer — yoksa müşteri
 * her sabah aynı maili alırdı ve hatırlatma özelliği spam'e dönüşüp
 * kapatılırdı. Tek koruma bu alanlar; başka guard yok.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Post kaç gündür beklediğinde müşteriye hatırlatma gider.
 *
 * 2 gün nereden: onay linki 7 gün geçerli. Daha erken hatırlatmak (aynı gün,
 * ertesi sabah) dürtme değil rahatsızlık olur — müşteri postu görmüş ve
 * düşünüyor olabilir. Daha geç hatırlatmak (5-6 gün) ise linkin ölmesine çok
 * az zaman bırakır, yani hatırlatmanın işe yarama ihtimalini düşürür.
 */
export const REMINDER_AFTER_DAYS = 2;

export type ReminderAction = "client_reminder" | "agency_expiry_notice" | "none";

/** Karar için gereken post alanları — caption, görsel vb. hiç okunmaz. */
export type ReminderCandidate = {
  status: string;
  createdAt: Date;
  reminderSentAt: Date | null;
  expiryNoticeSentAt: Date | null;
  /** Onay linkinin bitişi; link hiç yoksa `null`. */
  linkExpiresAt: Date | null;
};

/** Postun kaç gündür beklediği (tam gün, aşağı yuvarlanmış). */
export function daysPending(createdAt: Date, now: Date = new Date()): number {
  return Math.floor((now.getTime() - createdAt.getTime()) / DAY_MS);
}

export function reminderDecision(
  post: ReminderCandidate,
  now: Date = new Date()
): ReminderAction {
  // Karar verilmiş postun hatırlatılacak bir şeyi yok.
  if (post.status !== "pending") return "none";

  // Linki hiç olmayan post (teorik: eski/bozuk veri) müşteriye gönderilemez;
  // ajansın haberi olması gereken bir durum, "süresi dolmuş" ile aynı sepet.
  const linkDead =
    post.linkExpiresAt === null || post.linkExpiresAt.getTime() <= now.getTime();

  if (linkDead) {
    return post.expiryNoticeSentAt === null ? "agency_expiry_notice" : "none";
  }

  if (post.reminderSentAt !== null) return "none";
  return daysPending(post.createdAt, now) >= REMINDER_AFTER_DAYS
    ? "client_reminder"
    : "none";
}
