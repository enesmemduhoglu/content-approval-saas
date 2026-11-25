import { NextResponse } from "next/server";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { jpegSize } from "@/lib/jpeg-size";
import { adNotFound, portalMutationGuard } from "@/lib/portal-route";
import { AD_CONTENT_TYPE, MAX_AD_BYTES, adRatioOk } from "@/lib/portal-validation";
import { syncQueueWakes } from "@/lib/queue-wake";
import {
  deleteObject,
  getObjectBytes,
  headObject,
  keyBelongsToClient,
  r2Configured,
} from "@/lib/storage-r2";

/**
 * V12 — reklam görseli yüklendi. İstemcinin "yükledim, JPEG'dir, 4:5'tir"
 * demesine güvenilmez (video `complete`inin gerekçesi): HEAD boyutu ve tipi,
 * dosyanın başı da gerçek piksel oranını kanıtlar. İmzalı PUT boyutu
 * sınırlamıyor, yani 8 MB'ı aşan dosyanın yakalandığı yer burası.
 *
 * Reddedilen dosya R2'den silinir, taslak `draft` kalır (havuza girmez,
 * 24 saatte `draft-cleanup` satırı da temizler).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // 50 görsellik toplu yüklemede her görsel ayrı `complete` atıyor; video
  // `complete`i ile aynı geniş ama müşteri anahtarlı tavan.
  // Kapı sırası: oturum → checkOrigin → hız sınırı (bkz. portal-route.ts).
  const guard = await portalMutationGuard(request, { action: "ad-complete", max: 120 });
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const { clientId } = guard.session;

  if (!r2Configured()) {
    return NextResponse.json({ error: "Görsel depolama henüz yapılandırılmadı" }, { status: 503 });
  }

  const scoped = getClientScopedDb(guard.session);
  const ad = await scoped.ads.findState(id);
  if (!ad || !ad.imageKey || !keyBelongsToClient(ad.imageKey, clientId)) return adNotFound();
  if (ad.status !== "draft") {
    return NextResponse.json({ error: "Bu yükleme zaten tamamlandı" }, { status: 409 });
  }

  const head = await headObject(ad.imageKey);
  if (!head) {
    return NextResponse.json(
      { error: "Görsel depolamada bulunamadı — yükleme tamamlanmamış olabilir" },
      { status: 400 }
    );
  }
  const reject = async (error: string) => {
    await deleteObject(ad.imageKey!);
    return NextResponse.json({ error }, { status: 400 });
  };
  if (head.size <= 0 || head.size > MAX_AD_BYTES) {
    return reject(`Görsel en fazla ${MAX_AD_BYTES / (1024 * 1024)} MB olabilir`);
  }
  if (head.contentType && head.contentType !== AD_CONTENT_TYPE) {
    return reject("Reklam görseli JPEG olmalı");
  }

  // Boyut sınırlı (≤ 8 MB) olduğu için dosyanın tamamı okunuyor; SOF başlığı
  // genelde ilk birkaç KB'ta ama EXIF küçük resmi onu ileri itebiliyor.
  const bytes = await getObjectBytes(ad.imageKey);
  const size = bytes ? jpegSize(bytes) : null;
  if (!size) return reject("Görsel okunamadı — geçerli bir JPEG değil");
  if (!adRatioOk(size.width, size.height)) {
    return reject(
      `Görselin oranı Instagram'a uygun değil (${size.width}×${size.height}). ` +
        "Dikeyde en fazla 4:5, yatayda en fazla 1.91:1 olabilir"
    );
  }

  if (!(await scoped.ads.complete(id))) {
    return NextResponse.json({ error: "Bu yükleme zaten tamamlandı" }, { status: 409 });
  }

  // Havuz boşken reklam saati uyandırması kurulmuyor (`adWakeSlot`); ilk
  // görsel gelince kurulmalı. Throw etmez, başarısızsa günlük senkron tamamlar.
  const wakes = await syncQueueWakes();
  if (wakes.failed > 0 || wakes.skipped) {
    console.error("[portal-ad-complete] uyandırmalar kurulamadı:", wakes);
  }

  return NextResponse.json({ ok: true, width: size.width, height: size.height });
}
