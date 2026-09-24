import { NextResponse } from "next/server";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { notFound, portalMutationGuard } from "@/lib/portal-route";
import { FRAME_COUNT, MAX_FRAME_BYTES } from "@/lib/portal-validation";
import { enqueueCaption } from "@/lib/qstash";
import {
  deleteObject,
  frameKey,
  headObject,
  keyBelongsToClient,
  r2Configured,
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
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Hız sınırı POST BAŞINA: toplu yüklemede her video ayrı `complete` atıyor
  // (20 video = 20 istek). Toplam sayıyı zaten günlük yükleme tavanı ve
  // `status: draft` koşulu (her taslak bir kez tamamlanır) sınırlıyor.
  const { id } = await params;
  // Kapı sırası: oturum → checkOrigin → hız sınırı (bkz. portal-route.ts).
  const guard = await portalMutationGuard(request, {
    action: "complete",
    rateKeySuffix: id,
    max: 10,
  });
  if (!guard.ok) return guard.response;
  const { clientId } = guard.session;

  if (!r2Configured()) {
    return NextResponse.json(
      { error: "Video depolama henüz yapılandırılmadı" },
      { status: 503 }
    );
  }

  const scoped = getClientScopedDb(guard.session);
  const post = await scoped.posts.findById(id);
  if (!post || !post.videoKey || !keyBelongsToClient(post.videoKey, clientId)) return notFound();
  if (post.status !== "draft") {
    return NextResponse.json({ error: "Bu yükleme zaten tamamlandı" }, { status: 409 });
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
