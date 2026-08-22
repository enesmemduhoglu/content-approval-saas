import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { deletePostImages } from "@/lib/blob";
import { checkOrigin } from "@/lib/origin";
import { getScopedDb } from "@/lib/scoped-db";
import { validateCaption } from "@/lib/validation";

/**
 * Post düzenleme ve silme (F2).
 *
 * Bu iki yol açılana kadar CRUD'un yarısı yoktu: yanlış caption'la ya da yanlış
 * görselle oluşan bir postu geri almanın hiçbir yolu bulunmuyordu — bir ONAY
 * aracında tuhaf bir boşluk. TODOS'taki "doğrulama test postunu sil" maddesinin
 * elle iş olarak beklemesinin sebebi de buydu.
 *
 * Kapsam `getScopedDb` üzerinden: `id` istekten gelse de her sorgu oturumdaki
 * `agencyId` ile filtrelenir, başka ajansın postu 404 alır.
 *
 * Kapsam dışı bırakılanlar (bilinçli):
 * • Görsel değiştirme — yeni yükleme + eski blob temizliği + sıra yönetimi
 *   demek; caption düzeltmesiyle aynı PR'a sığmaz. Görsel yanlışsa post silinip
 *   yeniden oluşturulur.
 * • Yayınlanmış postu silme — aşağıda gerekçesiyle reddediliyor.
 */

type RouteParams = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: RouteParams) {
  const session = await auth();
  if (!session?.agencyId) {
    return NextResponse.json({ error: "Giriş gerekli" }, { status: 401 });
  }

  // Origin kontrolü (S8, CSRF ikinci katman) — bu route her zaman çerez
  // tabanlı oturumla çalışır (API anahtarı yolu yok), bu yüzden koşulsuz.
  const originCheck = checkOrigin(request);
  if (!originCheck.ok) {
    return NextResponse.json({ error: originCheck.message }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Geçersiz istek" }, { status: 400 });
  }

  const { caption } = (body ?? {}) as { caption?: unknown };
  const captionError = validateCaption(caption);
  if (captionError) {
    return NextResponse.json({ error: captionError, field: "caption" }, { status: 400 });
  }

  const { id } = await params;
  const result = await getScopedDb(session).posts.updateCaption(
    id,
    (caption as string).trim()
  );

  if (!result.ok) {
    if (result.reason === "not_found") {
      return NextResponse.json({ error: "Bu post bulunamadı" }, { status: 404 });
    }
    // Karar verilmiş postun metnini değiştirmek, müşterinin onayladığı şeyle
    // kayıttaki şeyi ayırırdı — onay kaydını sessizce yalan hâline getirirdi.
    return NextResponse.json(
      {
        error:
          "Bu posta karar verilmiş; metni artık değiştirilemez. Yeni bir post oluştur.",
      },
      { status: 409 }
    );
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, { params }: RouteParams) {
  const session = await auth();
  if (!session?.agencyId) {
    return NextResponse.json({ error: "Giriş gerekli" }, { status: 401 });
  }

  // Origin kontrolü (S8, CSRF ikinci katman) — bu route her zaman çerez
  // tabanlı oturumla çalışır (API anahtarı yolu yok), bu yüzden koşulsuz.
  const originCheck = checkOrigin(request);
  if (!originCheck.ok) {
    return NextResponse.json({ error: originCheck.message }, { status: 403 });
  }

  const { id } = await params;
  const result = await getScopedDb(session).posts.deleteById(id);

  if (!result.ok) {
    if (result.reason === "not_found") {
      return NextResponse.json({ error: "Bu post bulunamadı" }, { status: 404 });
    }
    return NextResponse.json(
      {
        error:
          "Instagram'a yayınlanmış post silinemez — kaydı silmek 'bu yayınlandı mı' " +
          "sorusunu cevapsız bırakır ve mükerrer yayın korumasını kör eder.",
      },
      { status: 409 }
    );
  }

  // Blob temizliği DB silmesinden SONRA ve best-effort: dosya kalsa bile post
  // gerçekten silindi, isteğe hata döndürmek yanıltıcı olurdu.
  await deletePostImages(result.imageUrls);

  return NextResponse.json({ ok: true });
}
