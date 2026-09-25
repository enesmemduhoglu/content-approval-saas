import { NextResponse } from "next/server";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { notFound, portalMutationGuard, readJson } from "@/lib/portal-route";
import { FRAME_COUNT, MAX_FRAME_BYTES, validateCompleteParts } from "@/lib/portal-validation";
import { enqueueCaption } from "@/lib/qstash";
import {
  completeMultipartUpload,
  deleteObject,
  frameKey,
  headObject,
  keyBelongsToClient,
  r2Configured,
  storageErrorCode,
} from "@/lib/storage-r2";
import { ALLOWED_VIDEO_TYPES, MAX_VIDEO_BYTES } from "@/lib/validation";

/**
 * Video kuyruğu (V3) — yükleme tamamlandı (README §7 "Yükle" 3. adım).
 *
 * İstemcinin "yükledim" demesine güvenilmez: `HeadObject` dosyanın R2'de
 * gerçekten durduğunu, boyutunun ve tipinin sınırda olduğunu kanıtlar. İmzalı
 * PUT boyutu sınırlamıyor (SigV4 presigned PUT'ta içerik uzunluğu imzaya
 * girmiyor), yani 300 MB'ı aşan dosyanın yakalandığı tek yer burası.
 *
 * Kareler isteğe bağlı: tarayıcı kare çıkaramadıysa (codec, eski cihaz) video
 * yine kuyruğa girer, caption yalnızca transkriptle üretilir.
 *
 * V7b — çok parçalı yüklemede (taslakta `uploadId` dolu) önce parçalar
 * birleştirilir: gövdedeki `parts: [{ partNumber, etag }]` listesiyle
 * `CompleteMultipartUpload`. Kimlik gövdeden değil DB'den; birleşmeden sonra
 * aşağıdaki `headObject` / boyut / tip kontrolleri tek PUT yoluyla AYNI.
 */

/** R2'nin "gönderdiğin parça listesi tutmuyor" hataları — istemcinin hatası, 400. */
const CLIENT_PART_ERRORS = new Set(["InvalidPart", "InvalidPartOrder", "EntityTooSmall"]);
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Toplu yüklemede her video ayrı `complete` atıyor (20 video = 20 istek);
  // genel portal tavanı yerine daha geniş ama yine MÜŞTERİ anahtarlı bir
  // tavan. Toplam iş zaten günlük yükleme tavanı ve `status: draft` koşuluyla
  // (her taslak bir kez tamamlanır) sınırlı.
  // Kapı sırası: oturum → checkOrigin → hız sınırı (bkz. portal-route.ts).
  const guard = await portalMutationGuard(request, { action: "complete", max: 120 });
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const { clientId } = guard.session;

  if (!r2Configured()) {
    return NextResponse.json(
      { error: "Video depolama henüz yapılandırılmadı" },
      { status: 503 }
    );
  }

  // Gövde isteğe bağlı (tek PUT yolu gövdesiz geliyor); `parts` VARSA DB'ye
  // gitmeden doğrulanır. Gerekip gerekmediği ancak taslağa bakınca belli.
  const body = ((await readJson(request)) ?? {}) as { parts?: unknown };
  const parts = body.parts === undefined ? null : validateCompleteParts(body.parts);
  if (parts && !parts.ok) {
    return NextResponse.json({ error: parts.error, field: parts.field }, { status: 400 });
  }

  const scoped = getClientScopedDb(guard.session);
  const post = await scoped.posts.findUploadState(id);
  if (!post || !post.videoKey || !keyBelongsToClient(post.videoKey, clientId)) return notFound();
  if (post.status !== "draft") {
    return NextResponse.json({ error: "Bu yükleme zaten tamamlandı" }, { status: 409 });
  }

  if (post.uploadId) {
    if (!parts) {
      return NextResponse.json(
        { error: "Yüklenen parçaların listesi gerekli", field: "parts" },
        { status: 400 }
      );
    }
    try {
      await completeMultipartUpload(post.videoKey, post.uploadId, parts.parts);
    } catch (error) {
      const code = storageErrorCode(error);
      if (code && CLIENT_PART_ERRORS.has(code)) {
        // Parçalar R2'de duruyor; istemci eksik parçayı yükleyip yeniden deneyebilir.
        return NextResponse.json(
          { error: "Parça listesi depolamadakiyle uyuşmuyor — eksik parça olabilir", field: "parts" },
          { status: 400 }
        );
      }
      // `NoSuchUpload`: yükleme R2'de yok. En olası sebep, önceki bir
      // `complete` parçaları birleştirdi ama yanıt istemciye ulaşmadı (gerçek
      // R2'de denendi: ikinci birleştirme `NoSuchUpload` döner). Nesne varsa
      // aşağıdaki kontroller onu tek PUT'ta olduğu gibi kabul eder; yoksa
      // `headObject` 400'ü "dosya bulunamadı" der.
      if (code !== "NoSuchUpload") {
        console.error(`[portal-complete] birleştirme başarısız (post=${id}): ${code ?? "bilinmiyor"}`);
        return NextResponse.json(
          { error: "Depolama şu an yanıt vermiyor, biraz sonra tekrar dene" },
          { status: 502 }
        );
      }
    }
    await scoped.posts.clearUploadId(id, post.uploadId);
  }

  const video = await headObject(post.videoKey);
  if (!video) {
    return NextResponse.json(
      { error: "Video dosyası depolamada bulunamadı — yükleme tamamlanmamış olabilir" },
      { status: 400 }
    );
  }
  if (video.size <= 0 || video.size > MAX_VIDEO_BYTES) {
    // Sınırı aşan dosya depolamada tutulmaz; taslak `draft` kalır, kuyruğa girmez.
    await deleteObject(post.videoKey);
    return NextResponse.json(
      { error: `Video en fazla ${Math.floor(MAX_VIDEO_BYTES / (1024 * 1024))}MB olabilir` },
      { status: 400 }
    );
  }
  if (video.contentType && !ALLOWED_VIDEO_TYPES[video.contentType]) {
    await deleteObject(post.videoKey);
    return NextResponse.json(
      { error: "Yalnızca video/mp4 ya da video/quicktime yüklenebilir" },
      { status: 400 }
    );
  }

  // Kare anahtarları istemciden ALINMAZ — beklenen 6 anahtar sunucuda üretilip
  // hangileri gerçekten yüklenmiş diye bakılır.
  const candidates = Array.from({ length: FRAME_COUNT }, (_, i) => frameKey(clientId, id, i));
  const heads = await Promise.all(candidates.map((key) => headObject(key).catch(() => null)));
  const frameKeys = candidates.filter((_, i) => {
    const head = heads[i];
    return head !== null && head.size > 0 && head.size <= MAX_FRAME_BYTES;
  });

  const completed = await scoped.posts.complete(id, frameKeys);
  if (!completed) {
    return NextResponse.json({ error: "Bu yükleme zaten tamamlandı" }, { status: 409 });
  }

  // Commit'ten SONRA: kuyruk mesajı DB'deki `pending` satırı görmeli. QStash
  // yoksa/patlarsa post `captionStatus = pending` kalır; portaldaki "yeniden
  // üret" aynı işi elle tetikler, yükleme başarısız sayılmaz.
  const enqueue = await enqueueCaption(id);
  if (!enqueue.queued) {
    console.error(`[portal-complete] caption kuyruğa atılamadı (post=${id}): ${enqueue.reason}`);
  }

  return NextResponse.json({
    ok: true,
    frameCount: frameKeys.length,
    captionQueued: enqueue.queued,
  });
}
