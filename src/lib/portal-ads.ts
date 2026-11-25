import type { PublishSettings } from "@prisma/client";
import { compareAds, isAdEligible, projectNextAd, type AdProjection } from "@/lib/ads";
import type { ClientScopedDb, PortalVideo } from "@/lib/client-scoped-db";
import { formatTime, slotWeekdayLabel } from "@/lib/portal-format";
import { keyBelongsToClient, r2Configured, signDisplayUrl } from "@/lib/storage-r2";

/**
 * V12b — portal reklam ekranlarının sunucu tarafı (K36). Veri katmanı
 * `client-scoped-db > ads`, kurallar `ads.ts`; burada yalnızca görünüm:
 * imzalı küçük resim, kartın durumu, "sıradaki reklam" metni.
 */

/** Reklam ayarlarının forma giden hâli; sayaç alanları (iç durum) gönderilmez. */
export type AdSettingsView = {
  adsEnabled: boolean;
  adSlot: string;
  adMinGap: number;
  adMaxGap: number;
  adCaption: string;
};

/**
 * Kayıtlı metin yokken alana DOLU (placeholder değil) gelen reklam metni:
 * kullanıcı değiştirmedikçe "Kaydet" bunu yazar. Yalnızca reklam
 * görsellerinde geçen bilgiler — online / yüz yüze, her seviye, ilk ders
 * %50 indirimli, DM'den "DERS" — uydurma bir vaat yok. Müşteriye özel
 * (Furkan Hoca); ikinci bir reklam müşterisi gelince kendi metnini yazar,
 * gerekirse bu sabit müşteri alanına taşınır.
 */
export const DEFAULT_AD_CAPTION = [
  "Furkan Hoca ile birebir İngilizce özel ders 🎯",
  "Online ya da yüz yüze · her seviyeye uygun · sana özel ders planı.",
  "Ezber değil, gerçek hayatta konuşacağın İngilizce.",
  "",
  "İlk ders %50 indirimli! Yerini ayırtmak için DM'den \"DERS\" yaz 📩",
  "",
  "#ingilizce #ingilizceözelders #özelders #ingilizceöğren #onlineingilizce #ingilizcekonuşma #speakingpractice",
].join("\n");

/** Ayar satırı yoksa şema varsayılanları — reklam kapalı. */
export const AD_SETTINGS_DEFAULTS: AdSettingsView = {
  adsEnabled: false,
  adSlot: "21:00",
  adMinGap: 5,
  adMaxGap: 10,
  adCaption: DEFAULT_AD_CAPTION,
};

export function toAdSettingsView(settings: PublishSettings | null): AdSettingsView {
  if (!settings) return AD_SETTINGS_DEFAULTS;
  return {
    adsEnabled: settings.adsEnabled,
    adSlot: settings.adSlot,
    adMinGap: settings.adMinGap,
    adMaxGap: settings.adMaxGap,
    // `null` = hiç kaydedilmedi → dolu varsayılan; kaydedilmiş metin aynen.
    adCaption: settings.adCaption ?? DEFAULT_AD_CAPTION,
  };
}

/**
 * Kartın durumu. `next` havuzda tick'in SEÇECEĞİ reklam (`pickNextAd` ile aynı
 * kural): kullanıcı "hangisi çıkacak" sorusunu sıralamaya bakarak değil
 * rozetten okusun.
 */
export type AdCardState = "next" | "queued" | "publishing" | "published" | "failed";

export type AdCard = {
  id: string;
  caption: string;
  coverUrl: string | null;
  state: AdCardState;
  publishError: string | null;
  igPermalink: string | null;
  publishedAt: Date | null;
  sourceName: string | null;
};

type AdRow = Awaited<ReturnType<ClientScopedDb["ads"]["list"]>>[number];

/**
 * İmza yalnızca kapsamlı sorgudan dönmüş satırın, kendi önekindeki anahtarına
 * (`portal-media.ts` ile aynı kapı). R2 yoksa ya da imza patlarsa boş kutu —
 * sayfa düşmez.
 */
async function signCover(key: string | null, clientId: string): Promise<string | null> {
  if (!key || !keyBelongsToClient(key, clientId) || !r2Configured()) return null;
  try {
    return await signDisplayUrl(key);
  } catch (error) {
    console.error("[portal-ads] imzalı URL üretilemedi", (error as Error).message);
    return null;
  }
}

function stateOf(row: AdRow, nextId: string | null): AdCardState {
  if (row.publishStatus === "published" || row.publishStatus === "duplicate") return "published";
  if (row.publishStatus === "failed") return "failed";
  if (row.publishStatus === "publishing") return "publishing";
  return row.id === nextId ? "next" : "queued";
}

/**
 * Havuz (sırada + hata alan, yükleme sırasıyla) ve yayınlananlar (yeniden
 * eskiye) ayrı listeler. Ham `imageKey` dışarı çıkmaz.
 */
export async function toAdCards(
  rows: AdRow[],
  clientId: string
): Promise<{ pool: AdCard[]; published: AdCard[] }> {
  const sorted = [...rows].sort(compareAds);
  const nextId = sorted.find((row) => isAdEligible(row))?.id ?? null;
  const cards = await Promise.all(
    sorted.map(async (row): Promise<AdCard> => ({
      id: row.id,
      caption: row.caption,
      coverUrl: await signCover(row.imageKey, clientId),
      state: stateOf(row, nextId),
      publishError: row.publishError,
      igPermalink: row.igPermalink,
      publishedAt: row.publishedAt,
      sourceName: row.sourceName,
    }))
  );
  return {
    pool: cards.filter((card) => card.state !== "published"),
    published: cards
      .filter((card) => card.state === "published")
      .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0)),
  };
}

/**
 * Sıradaki reklamın tahmini — tick'in kuralı (`projectNextAd`). `null` =
 * reklam çıkmayacak (kapalı, duraklatılmış, havuz boş ya da Instagram
 * bağlantısı yok: o durumda tick reklamı harcamıyor, saat yazmak yalan olur).
 */
export async function nextAdProjection(input: {
  scoped: ClientScopedDb;
  settings: PublishSettings | null;
  queue: PortalVideo[];
  poolSize: number;
  instagramBlocked: boolean;
  now: Date;
}): Promise<AdProjection | null> {
  const { settings } = input;
  if (!settings || input.instagramBlocked) return null;
  const publishedSince = settings.adCountFrom
    ? await input.scoped.ads.publishedVideosSince(settings.adCountFrom)
    : 0;
  return projectNextAd({
    settings,
    queue: input.queue,
    publishedSince,
    poolSize: input.poolSize,
    now: input.now,
  });
}

/**
 * "3 video sonra · Cuma 21:00" / "Bugün · 21:00" / "4 video sonra". Gün
 * adıyla (kuyruk kartıyla aynı dil): reklam birkaç gün sonra olabilir.
 */
export function adProjectionText(
  projection: AdProjection,
  timezone: string,
  now: Date = new Date()
): string {
  const when = projection.at
    ? `${slotWeekdayLabel(projection.at, timezone, now)} · ${formatTime(projection.at, timezone)}`
    : null;
  if (projection.videosLeft === 0) return when ?? "Sıradaki reklam saatinde";
  const count = `${projection.videosLeft} video sonra`;
  return when ? `${count} · ${when}` : count;
}
