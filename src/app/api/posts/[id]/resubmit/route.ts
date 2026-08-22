import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { deletePostImages } from "@/lib/blob";
import { db } from "@/lib/db";
import { sendRevisedPostEmail, type EmailResult } from "@/lib/email";
import { getScopedDb } from "@/lib/scoped-db";
import { validateCaption, validateImageUrls } from "@/lib/validation";

/**
 * Düzeltip yeniden onaya gönderme (F10) — revizyon turunun ajans yarısı.
 *
 * Neden `PATCH /api/posts/[id]` değil: o uç nokta yalnızca metni düzeltiyor ve
 * postun DURUMUNA dokunmuyor; buradaki iş bir durum geçişi (revision_requested
 * → pending), zincire bir satır ve müşteriye bir bildirim. Aynı uca sıkıştırmak
 * "metni kaydet" ile "müşteriye tekrar gönder"i ayırt edilemez hâle getirirdi —
 * ajans yazım hatasını düzeltirken istemeden mail attırırdı.
 *
 * Gövde (JSON, hepsi opsiyonel):
 * • `caption` — yeni metin; verilmezse mevcut metin korunur.
 * • `imageUrls` — yeni görseller; verilmezse görsellere DOKUNULMAZ.
 * • `message`  — ajansın "şunu değiştirdim" notu, müşteriye iletilir.
 *
 * Kapsam `getScopedDb` üzerinden (IDOR): `id` istekten gelse de her sorgu
 * oturumdaki `agencyId` ile filtrelenir, başka ajansın postu 404 alır.
 */

type RouteParams = { params: Promise<{ id: string }> };

function appBaseUrl(request: Request): string {
  return process.env.APP_URL ?? new URL(request.url).origin;
}

export async function POST(request: Request, { params }: RouteParams) {
  const session = await auth();
  if (!session?.agencyId) {
    return NextResponse.json({ error: "Giriş gerekli" }, { status: 401 });
  }

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
    if (captionError) {
      return NextResponse.json({ error: captionError, field: "caption" }, { status: 400 });
    }
  }
  if (imageUrls !== undefined) {
    // Aynı allowlist: revizyon yolu, post oluşturma yolunun açmadığı bir kapıyı
    // açmamalı — keyfi host'tan görsel buradan da giremez.
    const urlError = validateImageUrls(imageUrls);
    if (urlError) {
      return NextResponse.json({ error: urlError, field: "imageUrls" }, { status: 400 });
    }
  }

  const { id } = await params;
  const scoped = getScopedDb(session);
  const result = await scoped.posts.resubmitForApproval({
    id,
    caption: caption === undefined ? undefined : (caption as string).trim(),
    imageUrls:
      imageUrls === undefined
        ? undefined
        : (imageUrls as string[]).map((url) => url.trim()),
    altTexts: Array.isArray(altTexts)
      ? altTexts.map((item) => (typeof item === "string" && item.trim() ? item.trim() : null))
      : undefined,
    message:
      typeof message === "string" && message.trim() ? message.trim().slice(0, 2000) : null,
  });

  if (!result.ok) {
    if (result.reason === "not_found") {
      return NextResponse.json({ error: "Bu post bulunamadı" }, { status: 404 });
    }
    if (result.reason === "published") {
      // KRİTİK: caption/görsel yalnızca DB'de değişir, Instagram'daki gönderi
      // olduğu yerde kalır. Panel ile gerçeklik sessizce ayrışacağı için bu yol
      // kapalı — düzeltme isteniyorsa Instagram tarafında yeni bir gönderi lazım.
      return NextResponse.json(
        {
          error:
            "Instagram'a yayınlanmış post revize edilemez — metni burada değiştirmek " +
            "yayındaki gönderiyi değiştirmez, yalnızca panelle gerçekliği ayırır. " +
            "Yeni bir post oluştur.",
        },
        { status: 409 }
      );
    }
    return NextResponse.json(
      {
        error:
          "Bu post revizyon beklemiyor; yalnızca müşterinin düzeltme istediği postlar tekrar gönderilebilir.",
        status: result.status,
      },
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
    agencyNote: typeof message === "string" && message.trim() ? message.trim() : null,
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
