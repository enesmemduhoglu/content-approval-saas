import { keyBelongsToClient, r2Configured, signDisplayUrl } from "@/lib/storage-r2";
import type { PortalVideo } from "@/lib/client-scoped-db";
import { outsideDeletesAt, videoArchivesAt } from "@/lib/retention-rules";

/**
 * Video kuyruğu (V3) — portal yanıtlarına giden imzalı GET URL'leri.
 *
 * İmza YALNIZCA kapsamlı sorgudan (`getClientScopedDb`) dönmüş bir post için
 * ve anahtar o müşterinin önekindeyse üretilir (K5): anahtar DB'den gelse
 * bile `keyBelongsToClient` son kapı — bozuk/elle yazılmış bir satır başka
 * müşterinin nesnesine imza aldırmasın.
 *
 * Adresler `signDisplayUrl` ile: bir saatlik pencere içinde aynı kalır, yanıt
 * önbellek başlığı taşır — kuyruk her açılışta kapakları yeniden indirmez.
 *
 * R2 yapılandırılmamışsa URL'ler `null` döner; liste yine çizilir (kapak
 * yerine boş kutu). Sayfa düşmez, yükleme route'u zaten açık hata veriyor.
 */

async function signIfOwned(key: string | null | undefined, clientId: string): Promise<string | null> {
  if (!key || !keyBelongsToClient(key, clientId) || !r2Configured()) return null;
  try {
    return await signDisplayUrl(key);
  } catch (error) {
    console.error("[portal-media] imzalı URL üretilemedi", (error as Error).message);
    return null;
  }
}

/**
 * Kart görünümü: kapak karesi (ilk kare) + ham anahtarlar DIŞARI ÇIKMAZ.
 * V9 saklama alanları (`retention-rules.ts`):
 *   • `deletesAt` — kuyruk dışı videonun kendiliğinden silineceği an,
 *   • `videoKeptUntil` — yayınlanan videonun dosyası hâlâ duruyorsa kaldırılacağı an,
 *   • `videoArchived` — yayınlanan videonun dosyası kaldırıldı, yalnızca kapak var.
 */
export type PortalVideoCard = Omit<PortalVideo, "videoKey" | "frameKeys"> & {
  coverUrl: string | null;
  deletesAt: Date | null;
  videoKeptUntil: Date | null;
  videoArchived: boolean;
};

export async function toCard(video: PortalVideo, clientId: string): Promise<PortalVideoCard> {
  const { videoKey, frameKeys, ...rest } = video;
  const done = video.publishStatus === "published" || video.publishStatus === "duplicate";
  return {
    ...rest,
    coverUrl: await signIfOwned(frameKeys[0], clientId),
    deletesAt: done ? null : outsideDeletesAt(video.outsideAt),
    videoKeptUntil: done && videoKey ? videoArchivesAt(video.publishedAt, video.updatedAt) : null,
    videoArchived: done && !videoKey,
  };
}

export type PortalVideoDetail = PortalVideoCard & {
  videoUrl: string | null;
  frameUrls: string[];
};

export async function toDetail(video: PortalVideo, clientId: string): Promise<PortalVideoDetail> {
  const [card, videoUrl, frameUrls] = await Promise.all([
    toCard(video, clientId),
    signIfOwned(video.videoKey, clientId),
    Promise.all(video.frameKeys.map((key) => signIfOwned(key, clientId))),
  ]);
  return {
    ...card,
    videoUrl,
    frameUrls: frameUrls.filter((url): url is string => url !== null),
  };
}
