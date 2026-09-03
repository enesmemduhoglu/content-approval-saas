import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { deletePostImages, InvalidImageError, uploadPostImage } from "@/lib/blob";
import { db } from "@/lib/db";
import { sendRevisedPostEmail, type EmailResult } from "@/lib/email";
import { checkOrigin } from "@/lib/origin";
import { getScopedDb } from "@/lib/scoped-db";
import { MAX_IMAGES_PER_POST, validateCaption, validateImageUrls } from "@/lib/validation";

/**
 * Düzeltip yeniden onaya gönderme (F10) — revizyon turunun ajans yarısı.
 *
 * Neden `PATCH /api/posts/[id]` değil: o uç nokta yalnızca metni düzeltiyor ve
 * postun DURUMUNA dokunmuyor; buradaki iş bir durum geçişi (revision_requested
 * → pending), zincire bir satır ve müşteriye bir bildirim. Aynı uca sıkıştırmak
 * "metni kaydet" ile "müşteriye tekrar gönder"i ayırt edilemez hâle getirirdi —
 * ajans yazım hatasını düzeltirken istemeden mail attırırdı.
 *
 * İki gövde şekli — `/api/posts` ile aynı ayrım:
 * • JSON: `caption`, `imageUrls` (hazır public URL), `altTexts`, `message`.
 *   Hepsi opsiyonel; verilmeyen alan olduğu gibi korunur.
 * • `multipart/form-data`: `caption`, `message` ve `image` alanında DOSYA.
 *   Panelin revizyon sayfası bunu kullanıyor — müşteri çoğu zaman metni değil
 *   görseli beğenmiyor, dosya yükleyemeyen bir revizyon turu o isteği
 *   karşılayamıyordu (yalnız-metin düzeltme F10'un ilk hâliydi).
 *
 * Kapsam `getScopedDb` üzerinden (IDOR): `id` istekten gelse de her sorgu
 * oturumdaki `agencyId` ile filtrelenir, başka ajansın postu 404 alır.
 */

type RouteParams = { params: Promise<{ id: string }> };

function appBaseUrl(request: Request): string {
  return process.env.APP_URL ?? new URL(request.url).origin;
}

function badRequest(error: string, field?: string, status = 400) {
  return NextResponse.json({ error, field }, { status });
}

/**
 * İki 409 metni tek yerde: aynı iki durum hem yükleme öncesi ön kontrolde hem
 * de koşullu UPDATE sonrasında dönüyor. Ayrı ayrı yazılsalardı panel, aynı
 * duruma dosya yükleyip yüklememesine göre farklı cümle görürdü.
 */
const PUBLISHED_ERROR =
  "Instagram'a yayınlanmış post revize edilemez — metni burada değiştirmek " +
  "yayındaki gönderiyi değiştirmez, yalnızca panelle gerçekliği ayırır. " +
  "Yeni bir post oluştur.";

const NOT_REVISION_ERROR =
  "Bu post revizyon beklemiyor; yalnızca müşterinin düzeltme istediği postlar tekrar gönderilebilir.";

/** İki gövde şeklinin ortak çıktısı; `undefined` = "bu alana dokunma". */
type ParsedBody = {
  caption?: string;
  /** JSON yolunda hazır URL'ler, form yolunda yüklenecek dosyalar. */
  images?: { kind: "urls"; urls: string[] } | { kind: "files"; files: File[] };
  altTexts?: (string | null)[];
  message: string | null;
};

async function parseJsonBody(request: Request): Promise<ParsedBody | NextResponse> {
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // Gövdesiz istek meşru: "metni panelden zaten düzelttim, sadece geri yolla".
  }
  const { caption, imageUrls, altTexts, message } = (body ?? {}) as {
    caption?: unknown;
    imageUrls?: unknown;
    altTexts?: unknown;
    message?: unknown;
  };

  if (caption !== undefined) {
    const captionError = validateCaption(caption);
    if (captionError) return badRequest(captionError, "caption");
  }
  if (imageUrls !== undefined) {
    // Aynı allowlist: revizyon yolu, post oluşturma yolunun açmadığı bir kapıyı
    // açmamalı — keyfi host'tan görsel buradan da giremez.
    const urlError = validateImageUrls(imageUrls);
    if (urlError) return badRequest(urlError, "imageUrls");
  }

  return {
    caption: caption === undefined ? undefined : (caption as string).trim(),
    images:
      imageUrls === undefined
        ? undefined
        : { kind: "urls", urls: (imageUrls as string[]).map((url) => url.trim()) },
    altTexts: Array.isArray(altTexts)
      ? altTexts.map((item) => (typeof item === "string" && item.trim() ? item.trim() : null))
      : undefined,
    message: typeof message === "string" && message.trim() ? message.trim().slice(0, 2000) : null,
  };
}

/**
 * Panel yolu. Boş `image` alanı "görselleri değiştirmiyorum" demektir — form
 * her göndermede alanı taşıdığı için dosyasız gelen istek görselleri SİLMEZ,
 * `undefined`a düşer.
 */
async function parseFormBody(request: Request): Promise<ParsedBody | NextResponse> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return badRequest("Geçersiz istek");
  }

  const caption = formData.get("caption");
  const message = formData.get("message");
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
    images: files.length > 0 ? { kind: "files", files } : undefined,
    message: typeof message === "string" && message.trim() ? message.trim().slice(0, 2000) : null,
  };
}

export async function POST(request: Request, { params }: RouteParams) {
  const session = await auth();
  if (!session?.agencyId) {
    return NextResponse.json({ error: "Giriş gerekli" }, { status: 401 });
  }

  // CSRF ikinci katmanı (S8). Bu uç noktanın makine yolu yok — hepsi çerezli
  // panel isteği, dolayısıyla muafiyet dalı da yok.
  const originCheck = checkOrigin(request);
  if (!originCheck.ok) {
    return NextResponse.json({ error: originCheck.message }, { status: 403 });
  }

  const isJson = (request.headers.get("content-type") ?? "").includes("application/json");
  const parsed = isJson ? await parseJsonBody(request) : await parseFormBody(request);
  if (parsed instanceof NextResponse) return parsed;

  const { id } = await params;
  const scoped = getScopedDb(session);

  // Yükleme ÖNCESİ durum kontrolü (`/api/posts`taki "kota upload'dan önce"
  // deseninin aynısı): revizyon beklemeyen bir post için Blob'a hiç yazılmasın,
  // yoksa 409 dönen istek arkasında sahipsiz dosya bırakırdı. Yarışı bu kontrol
  // DEĞİL, aşağıdaki koşullu UPDATE kapatıyor.
  if (parsed.images?.kind === "files") {
    const current = await scoped.posts.findById(id);
    if (!current) {
      return NextResponse.json({ error: "Bu post bulunamadı" }, { status: 404 });
    }
    if (current.publishStatus === "published") {
      return NextResponse.json({ error: PUBLISHED_ERROR }, { status: 409 });
    }
    if (current.status !== "revision_requested") {
      return NextResponse.json(
        { error: NOT_REVISION_ERROR, status: current.status },
        { status: 409 }
      );
    }
  }

  let imageUrls: string[] | undefined;
  if (parsed.images?.kind === "urls") {
    imageUrls = parsed.images.urls;
  } else if (parsed.images?.kind === "files") {
    try {
      imageUrls = [];
      for (const image of parsed.images.files) {
        imageUrls.push(await uploadPostImage(image));
      }
    } catch (error) {
      if (error instanceof InvalidImageError) {
        return badRequest(error.message, "image");
      }
      console.error("[resubmit] görsel yükleme hatası:", error);
      return badRequest("Görsel yüklenemedi, tekrar deneyin", "image");
    }
  }

  const result = await scoped.posts.resubmitForApproval({
    id,
    caption: parsed.caption,
    imageUrls,
    altTexts: parsed.altTexts,
    message: parsed.message,
  });

  if (!result.ok) {
    if (result.reason === "not_found") {
      return NextResponse.json({ error: "Bu post bulunamadı" }, { status: 404 });
    }
    if (result.reason === "published") {
      // KRİTİK: caption/görsel yalnızca DB'de değişir, Instagram'daki gönderi
      // olduğu yerde kalır. Panel ile gerçeklik sessizce ayrışacağı için bu yol
      // kapalı — düzeltme isteniyorsa Instagram tarafında yeni bir gönderi lazım.
      return NextResponse.json({ error: PUBLISHED_ERROR }, { status: 409 });
    }
    return NextResponse.json(
      { error: NOT_REVISION_ERROR, status: result.status },
      { status: 409 }
    );
  }

  // Yerini kaybeden görseller DB yazmasından SONRA ve best-effort siliniyor
  // (F13 deseni): dosya kalsa bile revizyon gerçekten gitti, isteğe hata
  // döndürmek yanıltıcı olurdu.
  await deletePostImages(result.removedImageUrls);

  const agency = await db.agency.findUnique({ where: { id: session.agencyId } });
  const approvalUrl = `${appBaseUrl(request)}/approve/${result.token}`;

  // Bildirim `email.ts > gonder()` üzerinden: Resend v4 API hatalarında THROW
  // ETMEZ, `{ data, error }` döner — dönüşü okumayan bir çağrı reddedilen maili
  // iz bırakmadan yutar (17.08'de iki gün böyle mail gitmedi).
  const email = await sendRevisedPostEmail({
    to: result.client.email,
    agencyName: agency?.name ?? "Ajansınız",
    clientName: result.client.name,
    approvalUrl,
    logoUrl: agency?.logoUrl,
    brandColor: agency?.brandColor,
    revisionRequest: result.lastRequest,
    agencyNote: parsed.message,
    round: result.round,
  }).catch((error): EmailResult => {
    console.error("[resubmit] e-posta hatası:", error);
    return { sent: false, reason: error instanceof Error ? error.message : String(error) };
  });

  // Mail durumu posta yazılır (F5 deseni): panele bakan insan da "müşteriye
  // haber gitti mi" sorusunu yanıtlayabilsin.
  await scoped.posts
    .recordApprovalEmail(id, email)
    .catch((error) => console.error("[resubmit] mail durumu yazılamadı:", error));

  return NextResponse.json({
    ok: true,
    status: "pending",
    round: result.round,
    approvalUrl,
    emailSent: email.sent,
    ...(email.sent ? {} : { emailError: email.reason }),
  });
}
