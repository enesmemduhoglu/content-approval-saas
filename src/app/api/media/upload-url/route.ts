import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { authenticateApiKey } from "@/lib/api-key";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import {
  ALLOWED_VIDEO_TYPES,
  MAX_VIDEO_BYTES,
  validateVideoUpload,
} from "@/lib/validation";

/**
 * Reels videosu için presigned PUT URL'i üretir (makine erişimi, furi).
 *
 * ─── Neden dosya bu route'tan GEÇMİYOR ─────────────────────────────────────
 * Vercel'de serverless istek gövdesi 4.5MB ile sınırlı; bir Reel 10–70MB.
 * Dosyayı buradan geçirmek imkânsız, `@vercel/blob`'un `put()`'u da sunucu
 * tarafında çalıştığı için aynı duvara toslar. Presigned URL bu duvarı komple
 * atlıyor: istemci dosyayı doğrudan Blob'a yüklüyor, biz yalnızca "şu yola, şu
 * tipte, şu boyuta kadar, şu süre içinde yazabilirsin" diyen imzayı üretiyoruz.
 *
 * ─── Sınırlar İMZANIN İÇİNDE ───────────────────────────────────────────────
 * `allowedContentTypes` ve `maximumSizeInBytes` hem `issueSignedToken`'a hem
 * `presignUrl`'e veriliyor: kısıt imzalı yükün parçası olduğu için Blob
 * tarafında zorlanıyor. Yalnızca burada kontrol etseydik, URL'i eline geçiren
 * herkes 300MB'lık sınırı da mp4 kısıtını da yok sayabilirdi — bu uç, gövdede
 * beyan edilen `size`'a güvenmek zorunda ve o beyan doğrulanamaz.
 *
 * ─── Güvenlik ──────────────────────────────────────────────────────────────
 * • Kimlik doğrulama YALNIZCA API anahtarı — `/api/clients/[id]/instagram-token`
 *   ile aynı gerekçe: bu bir makine yolu, tarayıcı oturumuna açmak panelde bir
 *   XSS'in blob store'a yazmasına kapı olurdu.
 * • Yol adı sunucuda üretilir (`randomUUID`). İstemcinin verdiği bir `pathname`
 *   kabul edilseydi `../` ya da başka bir postun dosya adı yazılabilirdi;
 *   dosya adının kullanıcı için bir anlamı da yok, URL zaten `video.json`'da
 *   saklanıyor.
 * • Rate limit: aynı `checkRateLimit` + `getClientIp`. Anahtar sızarsa
 *   üretilebilecek imza sayısı sınırlı kalır.
 * • Yanıt bir sırdır (URL'in kendisi yazma yetkisi taşır) — `no-store`.
 */

export const dynamic = "force-dynamic";

/** İmzanın ömrü. Yükleme hemen yapılıyor; uzun tutmanın faydası yok, riski var. */
const IMZA_OMRU_MS = 15 * 60 * 1000;

function secretJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate, private" },
  });
}

export async function POST(request: Request) {
  const ip = getClientIp(request.headers);
  if (await checkRateLimit(ip)) {
    return secretJson({ error: "Çok fazla istek, biraz sonra tekrar deneyin" }, 429);
  }

  const session = await authenticateApiKey(request);
  if (!session) {
    return secretJson({ error: "Yetkisiz" }, 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return secretJson({ error: "Geçersiz istek" }, 400);
  }
  const { contentType, size } = (body ?? {}) as { contentType?: unknown; size?: unknown };

  const uploadError = validateVideoUpload(contentType, size);
  if (uploadError) {
    return secretJson({ error: uploadError }, 400);
  }

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    // Yerel görsel yüklemesinin `public/uploads` fallback'i burada YOK: presigned
    // yükleme Blob'a özgü bir mekanizma, taklidi yok. Sessizce başarısız olmak
    // yerine yapılandırma eksiğini açıkça söylüyoruz.
    console.error("[media] BLOB_READ_WRITE_TOKEN tanımlı değil");
    return secretJson(
      { error: "Blob deposu yapılandırılmamış", code: "blob_not_configured" },
      500
    );
  }

  const uzanti = ALLOWED_VIDEO_TYPES[contentType as string];
  const pathname = `videos/${randomUUID()}.${uzanti}`;
  const validUntil = Date.now() + IMZA_OMRU_MS;

  try {
    const { issueSignedToken, presignUrl } = await import("@vercel/blob");
    const signed = await issueSignedToken({
      token,
      pathname,
      operations: ["put"],
      validUntil,
      allowedContentTypes: [contentType as string],
      maximumSizeInBytes: MAX_VIDEO_BYTES,
    });
    const { presignedUrl } = await presignUrl(signed, {
      operation: "put",
      pathname,
      access: "public",
      allowedContentTypes: [contentType as string],
      maximumSizeInBytes: MAX_VIDEO_BYTES,
      // Yol adı zaten rastgele bir UUID; ikinci bir sonek URL'i uzatmaktan
      // başka bir şey yapmaz ve çağıranın nihai adresi önceden bilmesini engeller.
      addRandomSuffix: false,
    });

    return secretJson({
      uploadUrl: presignedUrl,
      pathname,
      contentType,
      validUntil: new Date(validUntil).toISOString(),
      maxBytes: MAX_VIDEO_BYTES,
    });
  } catch (error) {
    console.error("[media] presigned URL üretilemedi:", error);
    return secretJson({ error: "Yükleme adresi üretilemedi" }, 500);
  }
}
