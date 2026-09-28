import type { PrefixUsage } from "@/lib/storage-r2";

/**
 * Portal depolama göstergesi (Ayarlar) — saf kurallar ve metinler.
 *
 * Kota R2 ücretsiz katmanı: 10 GB. Bucket'ın tamamı bu; tek müşteri olduğu
 * için müşterinin payı da bu (ikinci müşteri gelirse kota bölünmeli).
 * 10 GB'ta hiçbir şey ENGELLENMİYOR — R2 aşan kısmı ücretlendirir, yükleme
 * sürer; gösterge yalnızca haber verir (kullanıcı kararı, 2026-09-29).
 *
 * Birimler 1000 tabanlı (GB = 10⁹ bayt): Cloudflare paneli de böyle sayıyor,
 * iki sayı yan yana konunca tutsun.
 */

export const STORAGE_QUOTA_BYTES = 10 * 1000 ** 3;

/**
 * Ortalamayı üç videodan azına dayandırmak yanıltır (tek 26 MB'lık video
 * "380 video daha" dedirtir). 28 Eyl'deki 18 videonun ortalaması ~73 MB.
 */
export const TYPICAL_POST_BYTES = 75 * 1000 ** 2;
const MIN_SAMPLE = 3;

/** Bu orandan sonra "Yer azalıyor". */
const WARN_RATIO = 0.8;

export type StorageLevel = "ok" | "warn" | "full";

export type StorageView = {
  usedLabel: string;
  quotaLabel: string;
  /** 0–100, çubuğun genişliği; kotayı aşınca 100'de durur. */
  percent: number;
  level: StorageLevel;
  videosLeft: number;
  line: string;
};

const oneDecimal = new Intl.NumberFormat("tr-TR", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** "1,4 GB"; 1 GB altında "940 MB" ("0,9 GB" okunması zor). */
export function formatStorage(bytes: number): string {
  if (bytes < 1000 ** 3) return `${Math.round(bytes / 1000 ** 2)} MB`;
  return `${oneDecimal.format(bytes / 1000 ** 3)} GB`;
}

/**
 * Bir postun ortalama yeri: video + kareleri. Kareler kapak dahil kalıcı
 * olduğu için (yayından sonra kapak kalır) toplamı video sayısına bölmek
 * payı hafifçe büyütür — "kaç video daha" iyimser değil, temkinli çıkar.
 */
export function averagePostBytes(usage: PrefixUsage): number {
  if (usage.videoCount < MIN_SAMPLE) return TYPICAL_POST_BYTES;
  return (usage.videoBytes + usage.frameBytes) / usage.videoCount;
}

export function storageView(usage: PrefixUsage): StorageView {
  const used = usage.totalBytes;
  const free = Math.max(0, STORAGE_QUOTA_BYTES - used);
  const videosLeft = Math.floor(free / averagePostBytes(usage));
  const ratio = used / STORAGE_QUOTA_BYTES;
  const level: StorageLevel =
    ratio >= 1 || videosLeft === 0 ? "full" : ratio >= WARN_RATIO ? "warn" : "ok";

  const line =
    level === "full"
      ? "Yer doldu. Kuyruk dışındaki videoları silebilirsin."
      : level === "warn"
        ? `Yer azalıyor · yaklaşık ${videosLeft} video daha sığar`
        : `Yaklaşık ${videosLeft} video daha sığar`;

  return {
    usedLabel: formatStorage(used),
    // "10,0 GB" değil: kota tam sayı, ondalığı gürültü.
    quotaLabel: `${STORAGE_QUOTA_BYTES / 1000 ** 3} GB`,
    percent: Math.min(100, Math.round(ratio * 1000) / 10),
    level,
    videosLeft,
    line,
  };
}
