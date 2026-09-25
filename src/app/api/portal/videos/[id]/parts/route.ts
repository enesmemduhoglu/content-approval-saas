import { NextResponse } from "next/server";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { notFound, portalMutationGuard, readJson } from "@/lib/portal-route";
import { FRAME_COUNT, validatePartNumbers } from "@/lib/portal-validation";
import {
  frameKey,
  keyBelongsToClient,
  PUT_URL_TTL_SECONDS,
  r2Configured,
  signPutUrl,
  signUploadPartUrl,
} from "@/lib/storage-r2";

/**
 * Video kuyruğu (V7b) — çok parçalı yüklemenin parça imzaları.
 *
 * URL'ler parça parça ve 15 dakikalık alınıyor, yüklemenin başında topluca
 * değil: telefonda yükleme uygulamadan çıkıldığında askıda kalıyor ve
 * dakikalar sonra devam ediyor — baştan verilmiş URL'lerin süresi o arada
 * dolardı. İstemci yalnızca SIRADAKİ parçaların imzasını ister.
 *
 * `uploadId` gövdeden OKUNMAZ, `Post.uploadId`ten gelir; anahtar da DB'den.
 * İstemcinin söyleyebildiği tek şey hangi parça numaralarını istediği.
 *
 * `includeFrames`: kaldığı yerden devam eden yüklemede ilk istekteki kare
 * URL'lerinin süresi çoktan dolmuş olabilir; kareler henüz yüklenmediyse aynı
 * kapsam kontrolünden geçmiş taze URL'ler buradan alınır.
 */

/**
 * Parça imzası yüklemenin en sık isteği: 300 MB = 38 parça, 20'lik gruplarla
 * ve kopmalarda yeniden imzayla. 20 videoluk bir toplu yükleme genel portal
 * tavanına (60/dk) takılmasın; anahtar yine MÜŞTERİ.
 */
const PARTS_RATE_LIMIT_MAX = 240;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Kapı sırası: oturum → checkOrigin → hız sınırı (bkz. portal-route.ts).
  const guard = await portalMutationGuard(request, { action: "parts", max: PARTS_RATE_LIMIT_MAX });
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const { clientId } = guard.session;

  if (!r2Configured()) {
    return NextResponse.json({ error: "Video depolama henüz yapılandırılmadı" }, { status: 503 });
  }

  const parsed = validatePartNumbers(await readJson(request));
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, field: parsed.field }, { status: 400 });
  }

  const post = await getClientScopedDb(guard.session).posts.findUploadState(id);
  if (!post || !post.videoKey || !keyBelongsToClient(post.videoKey, clientId)) return notFound();
  if (post.status !== "draft") {
    return NextResponse.json({ error: "Bu yükleme zaten tamamlandı" }, { status: 409 });
  }
  if (!post.uploadId) {
    // Küçük dosya (tek PUT) ya da parçaları zaten birleştirilmiş yükleme.
    return NextResponse.json(
      { error: "Bu video parça parça yüklenmiyor", field: "partNumbers" },
      { status: 400 }
    );
  }

  const { videoKey, uploadId } = post;
  const urls = await Promise.all(
    parsed.partNumbers.map(async (partNumber) => ({
      partNumber,
      url: await signUploadPartUrl(videoKey, uploadId, partNumber, PUT_URL_TTL_SECONDS),
    }))
  );
  const framePutUrls = parsed.includeFrames
    ? await Promise.all(
        Array.from({ length: FRAME_COUNT }, (_, i) => signPutUrl(frameKey(clientId, id, i), "image/jpeg"))
      )
    : undefined;

  return NextResponse.json({ parts: urls, expiresIn: PUT_URL_TTL_SECONDS, framePutUrls });
}
