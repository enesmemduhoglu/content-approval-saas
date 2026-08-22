/**
 * F7 — ajans başına kaba kötüye kullanım tavanları.
 *
 * Bu bir faturalama/plan sistemi DEĞİL: tek `Plan` tablosu yok, katman yok,
 * ödeme entegrasyonu yok. Tek amaç, ücretsiz katmanda çalışan bu MVP'de
 * (Vercel Blob, Resend) tek bir kötü niyetli/bozuk hesabın kotayı tüketip
 * TÜM ajansları etkilemesini engellemek.
 *
 * Sayılar şu an prod'daki gerçek kullanımdan (1 ajans, 1 müşteri, 12 post)
 * kasıtlı olarak büyük tutuldu — amaç meşru kullanımı boğmak değil, "birisi
 * scripti döngüye soktu" senaryosunu durdurmak. Env ile ezilebilir olması,
 * sayıyı koda gömmeden operasyonel olarak ayarlanabilmesi için.
 */

const DEFAULT_MAX_PENDING_INVITES = 20;
const DEFAULT_MAX_CLIENTS = 50;
const DEFAULT_MAX_POSTS = 2000;
const DEFAULT_MAX_POSTS_PER_DAY = 100;

/** Günlük tavanın baktığı pencere. Takvim günü değil, kayan 24 saat. */
export const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  // Bozuk bir env değeri (boş, negatif, sayı olmayan) sessizce yutulmaz ama
  // isteği de düşürmez — güvenli varsayılana dönülür. Kota bir güvenlik
  // supabı; onu yapılandırırken hatalı env yüzünden tüm ajansı kilitlemek
  // asıl amaçtan (kötüye kullanımı durdurmak) daha kötü bir sonuç olurdu.
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`[quota] ${name} geçersiz ("${raw}") — varsayılan ${fallback} kullanılıyor`);
    return fallback;
  }
  return Math.floor(parsed);
}

/**
 * F6 — ajans başına azami AÇIK (kabul edilmemiş, süresi dolmamış) davet.
 * `QUOTA_MAX_PENDING_INVITES` ile ezilebilir.
 *
 * Davet butonu, keyfi bir adrese ajansın markasıyla mail attırabilen tek
 * yüzey: kötüye kullanılırsa hem Resend kotasını hem de gönderen alan adının
 * itibarını yakar. Tavan 20, gerçek bir ekibin (2-3 kişi) kat kat üstünde ama
 * toplu göndermeye yetmeyecek kadar dar. `checkRateLimit` ile birlikte
 * çalışıyor: rate limit HIZI, bu tavan TOPLAMI bağlıyor — kota.ts'teki
 * "günlük pencere + ömür boyu tavan" ikilisinin aynısı.
 */
export function maxPendingInvitesPerAgency(): number {
  return envNumber("QUOTA_MAX_PENDING_INVITES", DEFAULT_MAX_PENDING_INVITES);
}

/** Ajans başına azami müşteri sayısı. `QUOTA_MAX_CLIENTS` ile ezilebilir. */
export function maxClientsPerAgency(): number {
  return envNumber("QUOTA_MAX_CLIENTS", DEFAULT_MAX_CLIENTS);
}

/**
 * Ajans başına azami TOPLAM post sayısı (ömür boyu).
 * `QUOTA_MAX_POSTS` ile ezilebilir.
 *
 * Bu tavan depolamayı sınırlar: her post 10 görsele kadar taşıyabildiği için
 * toplam post sayısı Blob'da birikecek dosyaların üst sınırını da belirler.
 */
export function maxPostsPerAgency(): number {
  return envNumber("QUOTA_MAX_POSTS", DEFAULT_MAX_POSTS);
}

/**
 * Ajans başına, kayan 24 saatte azami post sayısı.
 * `QUOTA_MAX_POSTS_PER_DAY` ile ezilebilir.
 *
 * ─── Neden ömür boyu tavan TEK BAŞINA yetmiyor ─────────────────────────────
 * `maxPostsPerAgency()` bir HIZ sınırı değil, bir tavan: kaçak bir script
 * o tavanın tamamını tek seferde tüketebilir. 2000 post × 10 görsel × 10 MB
 * teorik olarak yüzlerce GB Blob demek ve ömür boyu tavan bunu engellemez —
 * yalnızca bir kez olmasına izin verip ajansı kalıcı olarak kilitler. Yani
 * korumak istediğimiz şey (kota tükenmesi) yine gerçekleşir, üstüne meşru
 * kullanıcı da kilitlenmiş olur.
 *
 * Asıl tehdit hız olduğu için asıl kontrol de hız tabanlı. İkisi birlikte:
 * günlük pencere kaçak scripti saatler içinde durdurur, ömür boyu tavan da
 * yavaş ama sürekli birikmeye karşı depolama tarafını bağlar.
 *
 * Varsayılan 100/gün: furi rutini şu an günde ~2 post üretiyor, yani meşru
 * kullanımın kat kat üstünde; ama kaçak bir döngünün dakikalar içinde binlerce
 * kayıt açmasını engelleyecek kadar dar.
 */
export function maxPostsPerDay(): number {
  return envNumber("QUOTA_MAX_POSTS_PER_DAY", DEFAULT_MAX_POSTS_PER_DAY);
}
