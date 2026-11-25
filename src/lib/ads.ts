import type { PostStatus, PublishStatus } from "@prisma/client";
import {
  SLOT_WINDOW_MS,
  parseSlot,
  projectSchedule,
  slotInstants,
  type QueueItem,
  type QueueSettings,
} from "@/lib/queue";

/**
 * V12 — reklam görselleri (K36), saf kurallar. `queue.ts` ile aynı desen:
 * karar burada, tick (`api/queue/tick`) yalnızca uygular; portalın "sıradaki
 * reklam" tahmini de aynı fonksiyonlardan geçer ki ekranda yazan ile tick'in
 * yaptığı ayrışmasın.
 *
 * Model: reklam video slotunu ALMAZ. Kendi saatinde (`adSlot`, video ile aynı
 * yayın günleri) ek post olarak çıkar — ama yalnızca son reklamdan beri en az
 * `adNextAfter` portal videosu yayınlandıysa. Günde en fazla bir reklam (tek
 * reklam saati). Her görsel bir kez yayınlanır; havuz biterse reklam durur.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Her N videoda bir" sınırları — ayar doğrulaması ve form aynı sabiti okur. */
export const AD_GAP_MIN = 1;
export const AD_GAP_MAX = 30;

/** Reklam ayarının kuralların ihtiyaç duyduğu dilimi (`PublishSettings`). */
export type AdSettings = Pick<QueueSettings, "timezone" | "days" | "paused"> & {
  adsEnabled: boolean;
  adSlot: string;
  adMinGap: number;
  adMaxGap: number;
  adNextAfter: number | null;
  adCountFrom: Date | null;
};

/**
 * `[min, max]` aralığından tam sayı (iki uç dahil). Sabit modda (min = max)
 * `rand` ne olursa olsun N. Bozuk bir satır (min > max) da patlamasın diye
 * sınırlar sıralanır; `rand` enjekte edilebilir ki testte uçlar sınansın.
 */
export function rollGap(min: number, max: number, rand: () => number = Math.random): number {
  const lo = Math.max(AD_GAP_MIN, Math.min(min, max));
  const hi = Math.max(lo, Math.max(min, max));
  const r = Math.min(Math.max(rand(), 0), 0.999_999_999);
  return lo + Math.floor(r * (hi - lo + 1));
}

/**
 * Bu turun hedefi. `adNextAfter` boşsa (reklam açılırken yazılamadıysa ya da
 * elle bozulduysa) alt sınır — "hiç reklam çıkmaz"a düşmektense erken çıkmak
 * daha az şaşırtıcı.
 */
export function effectiveNextAfter(settings: Pick<AdSettings, "adNextAfter" | "adMinGap">): number {
  return Math.max(AD_GAP_MIN, settings.adNextAfter ?? settings.adMinGap);
}

/** Reklam kaç video sonra — 0 ise sıradaki reklam saatinde çıkar. */
export function videosUntilAd(
  publishedSince: number,
  settings: Pick<AdSettings, "adNextAfter" | "adMinGap">
): number {
  return Math.max(0, effectiveNextAfter(settings) - publishedSince);
}

/**
 * Sayaç yeni bir tura başlarken `adNextAfter` yeniden çekilmeli mi? Sınırlar
 * değiştiğinde mevcut hedef yeni aralığın dışında kaldıysa (ör. 5–10'dan
 * "her 3 videoda bir"e geçildi, hedef 8'di) eski değer kullanıcının seçtiği
 * ritmi bir tur boyunca bozardı.
 */
export function needsReroll(nextAfter: number | null, min: number, max: number): boolean {
  return nextAfter === null || nextAfter < min || nextAfter > max;
}

/**
 * Pencereye (1 saat, video slotuyla aynı K8 kuralı) düşen, henüz işlenmemiş
 * reklam saatleri — eskiden yeniye. Pencere dışı reklam saati için satır
 * YAZILMAZ: kaçırılan reklam ertesi gün çıkar, "atlandı" diye kayıt ve
 * bildirim üretmenin anlamı yok (videonun aksine kuyrukta bekleyen bir ritim
 * yok, sayaç zaten birikiyor).
 */
export function dueAdSlots(
  settings: Pick<AdSettings, "adSlot" | "timezone" | "days">,
  now: Date,
  takenAdRunTimes: Date[]
): Date[] {
  if (!parseSlot(settings.adSlot)) return [];
  const taken = new Set(takenAdRunTimes.map((d) => d.getTime()));
  return slotInstants(
    { slots: [settings.adSlot], timezone: settings.timezone, days: settings.days },
    { from: new Date(now.getTime() - SLOT_WINDOW_MS), to: now }
  ).filter((at) => !taken.has(at.getTime()));
}

// ─── Havuz ─────────────────────────────────────────────────────────────────

export type AdItem = {
  id: string;
  status: PostStatus;
  publishStatus: PublishStatus;
  createdAt: Date;
  sourceName: string | null;
  /** V12c — portalda verilen sıra; boş = sonda, yükleme sırasıyla. */
  adPosition: number | null;
};

/**
 * Yayına seçilebilir reklam. Videodaki gibi yalnızca `idle`: `failed` reklam
 * hata kartıyla bekler ve "tekrar dene"yi ister — kendiliğinden yeniden
 * denense aynı hata her reklam saatinde tekrarlanırdı. `draft` (yüklemesi
 * bitmemiş) seçilmez.
 */
export function isAdEligible(item: AdItem): boolean {
  if (item.publishStatus !== "idle") return false;
  return item.status === "pending" || item.status === "approved";
}

const nameCollator = new Intl.Collator("tr", { numeric: true, sensitivity: "base" });

/**
 * Havuz sırası. Önce portalda verilen konum (`adPosition`, V12c — basılı tutup
 * sürükleyerek); konumu olmayan (göçten önce eski kodun yazdığı) sona. Sonra
 * yükleme sırası: toplu yüklemedeki 50 taslak aynı milisaniyede doğabildiği
 * için dosya adı sayısal karşılaştırmayla ("2.jpg" < "10.jpg").
 */
export function compareAds(a: AdItem, b: AdItem): number {
  const pa = a.adPosition ?? Number.POSITIVE_INFINITY;
  const pb = b.adPosition ?? Number.POSITIVE_INFINITY;
  return (
    (pa === pb ? 0 : pa < pb ? -1 : 1) ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    nameCollator.compare(a.sourceName ?? "", b.sourceName ?? "") ||
    a.id.localeCompare(b.id)
  );
}

export function pickNextAd<T extends AdItem>(pool: T[]): T | null {
  return [...pool].sort(compareAds).find((item) => isAdEligible(item)) ?? null;
}

// ─── Tahmin ────────────────────────────────────────────────────────────────

export type AdProjection = {
  /** Reklamdan önce yayınlanması gereken video sayısı. */
  videosLeft: number;
  /** Tahmini reklam anı; kuyrukta yeterli video yoksa `null`. */
  at: Date | null;
};

/**
 * Sıradaki reklamın tahmini — portaldaki "~3 video sonra · Cuma 21:00".
 * `null` = reklam çıkmayacak (kapalı, duraklatılmış ya da havuz boş).
 *
 * Kuralı tick'le aynı: `videosLeft`inci video `projectSchedule`daki slotuna
 * oturur, reklam ondan SONRAKİ ilk reklam saatinde çıkar. Reklam saati video
 * saatinden önceyse bu doğal olarak ertesi güne düşer.
 */
export function projectNextAd<T extends QueueItem>(input: {
  settings: AdSettings & Pick<QueueSettings, "slots">;
  queue: T[];
  publishedSince: number;
  poolSize: number;
  now: Date;
}): AdProjection | null {
  const { settings, now } = input;
  if (!settings.adsEnabled || settings.paused || input.poolSize === 0) return null;

  const videosLeft = videosUntilAd(input.publishedSince, settings);
  let after = now;
  if (videosLeft > 0) {
    const videos = projectSchedule(input.queue, settings, now, videosLeft);
    if (videos.length < videosLeft) return { videosLeft, at: null };
    after = videos[videosLeft - 1].slotAt;
  }

  // Ufuk: yalnızca Pazar seçili olsa bile bir sonraki reklam saati 7 gün içinde.
  const next = slotInstants(
    { slots: [settings.adSlot], timezone: settings.timezone, days: settings.days },
    { from: new Date(after.getTime() + 1), to: new Date(after.getTime() + 8 * DAY_MS) }
  )[0];
  return { videosLeft, at: next ?? null };
}

// ─── Ayar kaydı ────────────────────────────────────────────────────────────

/**
 * Ayar kaydında sayaca ne yazılacağı. Saf; route yalnızca sonucu yazar.
 *
 *  • Kapalıdan açığa: sayaç ŞİMDİ başlar ve hedef çekilir — geçmişte
 *    yayınlanmış videolar sayılsaydı ayarı açar açmaz reklam çıkardı.
 *  • Açıkken sınırlar değişti ve hedef yeni aralığın dışında: yalnızca hedef
 *    yeniden çekilir, sayaç korunur (o ana kadar yayınlanan videolar sayılı).
 *  • Kapatmak sayaca dokunmaz; yeniden açmak zaten sıfırdan başlatır.
 */
export function counterOnSave(
  current: Pick<AdSettings, "adsEnabled" | "adNextAfter">,
  next: Pick<AdSettings, "adsEnabled" | "adMinGap" | "adMaxGap">,
  now: Date,
  rand: () => number = Math.random
): { adNextAfter?: number; adCountFrom?: Date } {
  if (!next.adsEnabled) return {};
  if (!current.adsEnabled) {
    return { adCountFrom: now, adNextAfter: rollGap(next.adMinGap, next.adMaxGap, rand) };
  }
  if (needsReroll(current.adNextAfter, next.adMinGap, next.adMaxGap)) {
    return { adNextAfter: rollGap(next.adMinGap, next.adMaxGap, rand) };
  }
  return {};
}
