import { NextResponse } from "next/server";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { portalMutationGuard, readJson } from "@/lib/portal-route";
import {
  FRAME_COUNT,
  MULTIPART_PART_SIZE,
  MULTIPART_THRESHOLD_BYTES,
  validateUploadFiles,
} from "@/lib/portal-validation";
import {
  ALL_CLIENTS_PREFIX,
  abortMultipartUpload,
  createMultipartUpload,
  frameKey,
  prefixUsage,
  r2Configured,
  signPutUrl,
} from "@/lib/storage-r2";
import { uploadBlockedReason } from "@/lib/storage-usage";

/**
 * Video kuyruğu (V3) — yükleme başlatma (README §7 "Yükle" 1. adım).
 *
 * Dosya başına bir taslak post + R2'ye doğrudan PUT için imzalı URL'ler döner
 * (video + 6 kare). Dosyanın kendisi bu fonksiyondan GEÇMEZ: Vercel'in 4.5 MB
 * gövde sınırı var, video 300 MB olabilir.
 *
 * Toplu yükleme TEK istekte başlar (50 dosyaya kadar): dosya başına istek
 * atılsaydı 50 videoluk bir yükleme hız sınırına tek başına çarpardı.
 *
 * V7b: `MULTIPART_THRESHOLD_BYTES` ve üstündeki video çok parçalı yüklenir —
 * burada R2'de yükleme açılır, kimliği (`uploadId`) taslağa yazılır ve
 * istemciye yalnızca `multipart: true` + parça boyutu döner. Parça URL'leri
 * `videos/[id]/parts`'tan, parça parça ve süreli alınır. Küçük dosyanın tek
 * PUT yolu aynen duruyor.
 */

export async function POST(request: Request) {
  // Kapı sırası: oturum → checkOrigin → hız sınırı (bkz. portal-route.ts).
  const guard = await portalMutationGuard(request, { action: "upload" });
  if (!guard.ok) return guard.response;

  // Depolama yoksa yükleme AÇIK bir hatayla kapalı (CLAUDE.md: sessiz değil).
  // Taslak üretmeden önce: imzalayamayacağımız bir post DB'de öksüz kalmasın.
  if (!r2Configured()) {
    return NextResponse.json(
      { error: "Video depolama henüz yapılandırılmadı, ajansınla iletişime geç" },
      { status: 503 }
    );
  }

  const parsed = validateUploadFiles(await readJson(request));
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, field: parsed.field }, { status: 400 });
  }

  const scoped = getClientScopedDb(guard.session);

  // Depolama tavanı (K35): adet değil doluluk. Eskiden müşteri başına günde 40
  // videoydu; asıl korunan şey R2'nin ücretsiz katmanı olduğu için ölçü de o.
  // Doluluk R2'den ANLIK okunuyor (gösterge ile aynı `prefixUsage`; yarım
  // çok parçalı yüklemelerin parçaları dahil) — DB'de boyut tutmak her silme
  // yolunda senkron gerektirirdi. Bucket'ın tamamı sayılıyor, müşteri öneki
  // değil: kota bucket'a ait. Yanıta yalnızca boş yer çıkıyor, kimin ne
  // yüklediği değil.
  //
  // Kota deseni (F7): 429 değil 403 — bu bir hız sınırı değil, tavan. Say-sonra-
  // yaz yarışa açık (iki eşzamanlı seçim birlikte geçebilir); 1 GB'lık pay
  // bunun için (bkz. storage-usage.ts).
  let usedBytes: number;
  try {
    usedBytes = (await prefixUsage(ALL_CLIENTS_PREFIX)).totalBytes;
  } catch (error) {
    // Okunamayan doluluk "sığar" sayılmaz: tavanın tek işi taşmayı önlemek.
    // İmzalama da aynı R2'ye gidiyor, yani bu anda yükleme zaten yürümezdi.
    console.error("[portal-upload] depolama doluluğu okunamadı:", (error as Error).message);
    return NextResponse.json(
      { error: "Depolama şu an yanıt vermiyor, biraz sonra tekrar dene" },
      { status: 502 }
    );
  }
  const incomingBytes = parsed.files.reduce((sum, file) => sum + file.size, 0);
  const blocked = uploadBlockedReason(usedBytes, incomingBytes);
  if (blocked) {
    return NextResponse.json({ error: blocked, field: "files" }, { status: 403 });
  }

  const drafts = await scoped.posts.createDrafts(parsed.files);

  // Büyük dosyalar için R2 çok parçalı yüklemesi, ardından istemciye dönecek
  // imzalar. İkisi AYNI try içinde: herhangi biri patlarsa istemci yüklemeye
  // başlayacak bilgiyi alamaz, yani bu istekte doğan taslaklar kullanılamaz —
  // geri alınır ki yarım bir toplu yükleme günlük tavanı yemesin ve kullanıcı
  // aynı seçimi yeniden deneyebilsin. İmzalama eskiden dışarıdaydı: hata 500
  // olarak kaçıyor, taslaklar 24 saat (`draft-cleanup`) tavanda kalıyordu.
  const multipart = new Map<string, string>();
  let items;
  try {
    for (const [index, draft] of drafts.entries()) {
      if (parsed.files[index].size < MULTIPART_THRESHOLD_BYTES) continue;
      const uploadId = await createMultipartUpload(draft.videoKey, parsed.files[index].contentType);
      multipart.set(draft.id, uploadId);
      await scoped.posts.setUploadId(draft.id, uploadId);
    }

    // İmzalar DB'deki anahtardan üretiliyor, istemcinin beyanından değil; kare
    // anahtarları da aynı müşteri önekinde (`frameKey`). `uploadId` yanıtta
    // YOK — parça imzası onu yine DB'den okuyor.
    items = await Promise.all(
      drafts.map(async (draft, index) => {
        const framePutUrls = await Promise.all(
          Array.from({ length: FRAME_COUNT }, (_, i) =>
            signPutUrl(frameKey(guard.session.clientId, draft.id, i), "image/jpeg")
          )
        );
        if (multipart.has(draft.id)) {
          return { postId: draft.id, multipart: true, partSize: MULTIPART_PART_SIZE, framePutUrls };
        }
        return {
          postId: draft.id,
          multipart: false,
          videoPutUrl: await signPutUrl(draft.videoKey, parsed.files[index].contentType),
          framePutUrls,
        };
      })
    );
  } catch (error) {
    console.error("[portal-upload] yükleme hazırlanamadı:", (error as Error).message);
    const byId = new Map(drafts.map((draft) => [draft.id, draft.videoKey]));
    await Promise.all(
      [...multipart].map(([id, uploadId]) =>
        abortMultipartUpload(byId.get(id)!, uploadId).catch(() => undefined)
      )
    );
    await scoped.posts.deleteDrafts(drafts.map((draft) => draft.id));
    return NextResponse.json(
      { error: "Depolama şu an yanıt vermiyor, biraz sonra tekrar dene" },
      { status: 502 }
    );
  }

  return NextResponse.json({ items }, { status: 201 });
}
