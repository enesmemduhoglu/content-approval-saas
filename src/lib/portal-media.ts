import { keyBelongsToClient, r2Configured, signGetUrl } from "@/lib/storage-r2";
import type { PortalVideo } from "@/lib/client-scoped-db";

/**
 * Video kuyruğu (V3) — portal yanıtlarına giden imzalı GET URL'leri.
 *
 * İmza YALNIZCA kapsamlı sorgudan (`getClientScopedDb`) dönmüş bir post için
 * ve anahtar o müşterinin önekindeyse üretilir (K5): anahtar DB'den gelse
 * bile `keyBelongsToClient` son kapı — bozuk/elle yazılmış bir satır başka
 * müşterinin nesnesine imza aldırmasın.
 *
 * R2 yapılandırılmamışsa URL'ler `null` döner; liste yine çizilir (kapak
 * yerine boş kutu). Sayfa düşmez, yükleme route'u zaten açık hata veriyor.
 */

async function signIfOwned(key: string | null | undefined, clientId: string): Promise<string | null> {
  if (!key || !keyBelongsToClient(key, clientId) || !r2Configured()) return null;
  try {
    return await signGetUrl(key);
  } catch (error) {
    console.error("[portal-media] imzalı URL üretilemedi", (error as Error).message);
    return null;
  }
}

/** Kart görünümü: kapak karesi (ilk kare) + ham anahtarlar DIŞARI ÇIKMAZ. */
export type PortalVideoCard = Omit<PortalVideo, "videoKey" | "frameKeys"> & {
  coverUrl: string | null;
};

export async function toCard(video: PortalVideo, clientId: string): Promise<PortalVideoCard> {
  const { videoKey: _videoKey, frameKeys, ...rest } = video;
  void _videoKey;
  return { ...rest, coverUrl: await signIfOwned(frameKeys[0], clientId) };
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
