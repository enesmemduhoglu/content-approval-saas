import { NextResponse } from "next/server";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { portalMutationGuard, readJson } from "@/lib/portal-route";
import { AD_CONTENT_TYPE, validateAdUploadFiles } from "@/lib/portal-validation";
import { ALL_CLIENTS_PREFIX, prefixUsage, r2Configured, signPutUrl } from "@/lib/storage-r2";
import { uploadBlockedReason } from "@/lib/storage-usage";

/**
 * V12 — reklam görseli yükleme başlatma (K36). Video yüklemesinin
 * (`api/portal/upload`) görsel ikizi: dosya başına bir taslak reklam + R2'ye
 * doğrudan PUT için imzalı URL. Dosya bu fonksiyondan GEÇMEZ (Vercel'in 4.5 MB
 * gövde sınırı; 50 görsel tek istekte).
 *
 * Videodan farkları bilinçli: çok parçalı yükleme yok (görsel ≤ 8 MB, tek PUT
 * yeter), kare yok, caption kuyruğu yok — reklamın metni ayarlardaki sabit
 * metin ya da reklama özel yazılan.
 */
export async function POST(request: Request) {
  // Kapı sırası: oturum → checkOrigin → hız sınırı (bkz. portal-route.ts).
  const guard = await portalMutationGuard(request, { action: "ad-upload" });
  if (!guard.ok) return guard.response;

  // Taslak üretmeden önce: imzalayamayacağımız bir reklam DB'de öksüz kalmasın.
  if (!r2Configured()) {
    return NextResponse.json(
      { error: "Görsel depolama henüz yapılandırılmadı, ajansınla iletişime geç" },
      { status: 503 }
    );
  }

  const parsed = validateAdUploadFiles(await readJson(request));
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, field: parsed.field }, { status: 400 });
  }

  // Depolama tavanı (K35) videoyla ORTAK: kota bucket'a ait, reklam da aynı
  // bucket'ta. Okunamayan doluluk "sığar" sayılmaz (video yolunun gerekçesi).
  let usedBytes: number;
  try {
    usedBytes = (await prefixUsage(ALL_CLIENTS_PREFIX)).totalBytes;
  } catch (error) {
    console.error("[portal-ad-upload] depolama doluluğu okunamadı:", (error as Error).message);
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

  const scoped = getClientScopedDb(guard.session);
  const drafts = await scoped.ads.createDrafts(parsed.files);

  // İmza DB'deki anahtardan, istemcinin beyanından değil. Patlarsa bu istekte
  // doğan taslaklar geri alınır ki kullanıcı aynı seçimi yeniden deneyebilsin.
  try {
    const items = await Promise.all(
      drafts.map(async (draft) => ({
        adId: draft.id,
        putUrl: await signPutUrl(draft.imageKey, AD_CONTENT_TYPE),
      }))
    );
    return NextResponse.json({ items }, { status: 201 });
  } catch (error) {
    console.error("[portal-ad-upload] yükleme hazırlanamadı:", (error as Error).message);
    await scoped.ads.deleteDrafts(drafts.map((draft) => draft.id));
    return NextResponse.json(
      { error: "Depolama şu an yanıt vermiyor, biraz sonra tekrar dene" },
      { status: 502 }
    );
  }
}
