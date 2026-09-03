import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { deletePostImages, InvalidImageError, uploadPostImage } from "@/lib/blob";
import { checkOrigin } from "@/lib/origin";
import { getScopedDb } from "@/lib/scoped-db";
import { MAX_IMAGES_PER_POST, validateCaption } from "@/lib/validation";

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
 * PATCH iki gövde şekli kabul eder: JSON (`{ caption }`) ve panel düzenleme
 * sayfasının `multipart/form-data`sı (`caption` + `image` dosyaları). Görsel
 * değiştirme sonradan açıldı — "yanlış görselle oluşan postu silip yeniden
 * oluştur" tavsiyesi, onay bekleyen postta linki de öldürdüğü için pratikte
 * kimsenin yapmadığı bir işti.
 *
 * Kapsam dışı bırakılan (bilinçli): yayınlanmış postu silme — aşağıda
 * gerekçesiyle reddediliyor.
 */

type RouteParams = { params: Promise<{ id: string }> };

/**
 * Reel'e görsel yüklenemez: `videoUrl` ve `images` birlikte dolduğunda hangi
 * medyanın yayınlanacağı `publish-post`un dallanma sırasına kalırdı —
 * `validatePostMedia`ın post oluştururken kapattığı deliğin aynısı. Video
 * dosyası zaten panelden geçmiyor (presigned yükleme, F14).
 */
const VIDEO_ERROR =
  "Reel videosu panelden değiştirilemez; görsel eklemek postu bozar. " +
  "Video değişecekse yeni bir post oluştur.";

/** Aynı 409 iki yerden dönüyor: yükleme öncesi ön kontrol ve koşullu UPDATE. */
const NOT_PENDING_ERROR =
  "Bu posta karar verilmiş; metni artık değiştirilemez. Yeni bir post oluştur.";

function badRequest(error: string, field?: string, status = 400) {
  return NextResponse.json({ error, field }, { status });
}

/** İki gövde şeklinin ortak çıktısı; `undefined` = "bu alana dokunma". */
type ParsedPatch = { caption?: string; files?: File[] };

async function parsePatchBody(request: Request): Promise<ParsedPatch | NextResponse> {
  const isJson = (request.headers.get("content-type") ?? "").includes("application/json");
  if (isJson) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return badRequest("Geçersiz istek");
    }
    const { caption } = (body ?? {}) as { caption?: unknown };
    const captionError = validateCaption(caption);
    if (captionError) return badRequest(captionError, "caption");
    return { caption: (caption as string).trim() };
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return badRequest("Geçersiz istek");
  }
  const caption = formData.get("caption");
  // Boş dosya alanı "görselleri değiştirmiyorum" demek — form her göndermede
  // alanı taşıdığı için dosyasız istek mevcut görselleri SİLMEZ.
  const files = formData
    .getAll("image")
    .filter((item): item is File => item instanceof File && item.size > 0);

  if (caption !== null) {
    const captionError = validateCaption(caption);
    if (captionError) return badRequest(captionError, "caption");
  }
  if (files.length > MAX_IMAGES_PER_POST) {
    return badRequest(`En fazla ${MAX_IMAGES_PER_POST} görsel yükleyebilirsin`, "image");
  }

  return {
    caption: caption === null ? undefined : (caption as string).trim(),
    files: files.length > 0 ? files : undefined,
  };
}

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

  const parsed = await parsePatchBody(request);
  if (parsed instanceof NextResponse) return parsed;

  const { id } = await params;
  const scoped = getScopedDb(session);

  // Yükleme ÖNCESİ durum kontrolü: 409 dönecek istek Blob'a hiç yazmasın,
  // yoksa reddedilen düzenleme arkasında sahipsiz dosya bırakırdı. Yarışı bu
  // kontrol değil, `updatePending`in koşullu UPDATE'i kapatıyor.
  if (parsed.files) {
    const current = await scoped.posts.findById(id);
    if (!current) {
      return NextResponse.json({ error: "Bu post bulunamadı" }, { status: 404 });
    }
    if (current.status !== "pending") {
      return NextResponse.json({ error: NOT_PENDING_ERROR }, { status: 409 });
    }
    if (current.videoUrl) {
      return badRequest(VIDEO_ERROR, "image", 409);
    }
  }

  let imageUrls: string[] | undefined;
  if (parsed.files) {
    try {
      imageUrls = [];
      for (const image of parsed.files) {
        imageUrls.push(await uploadPostImage(image));
      }
    } catch (error) {
      if (error instanceof InvalidImageError) {
        return badRequest(error.message, "image");
      }
      console.error("[posts] görsel yükleme hatası:", error);
      return badRequest("Görsel yüklenemedi, tekrar deneyin", "image");
    }
  }

  const result = await scoped.posts.updatePending({ id, caption: parsed.caption, imageUrls });

  if (!result.ok) {
    if (result.reason === "not_found") {
      return NextResponse.json({ error: "Bu post bulunamadı" }, { status: 404 });
    }
    // Karar verilmiş postun metnini değiştirmek, müşterinin onayladığı şeyle
    // kayıttaki şeyi ayırırdı — onay kaydını sessizce yalan hâline getirirdi.
    return NextResponse.json({ error: NOT_PENDING_ERROR }, { status: 409 });
  }

  // Yerini kaybeden görseller DB yazmasından SONRA ve best-effort siliniyor
  // (F13 deseni): dosya kalsa bile düzenleme gerçekten kaydedildi.
  await deletePostImages(result.removedImageUrls);

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
