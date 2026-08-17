import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { sendApprovalRequestEmail, type EmailResult } from "@/lib/email";
import { getScopedDb } from "@/lib/scoped-db";
import { isExpired } from "@/lib/tokens";

/**
 * Onay linkini yenile ve/veya onay e-postasını tekrar gönder (F1 + F5).
 *
 * Neden tek uç nokta: ikisi aynı işin iki ucu. Link 7 günde ölüyordu ve
 * yenilemenin YOLU YOKTU — müşteri tatildeyse post kalıcı olarak kilitleniyor,
 * ajansın elinde hiçbir kurtarma aracı kalmıyordu. Mailin gitmediği durumda da
 * (bkz. #31) tek çare yeni bir post oluşturmaktı.
 *
 * Gövde: `{ renew?: boolean }`
 * • Link süresi DOLMUŞSA `renew` ne derse desin yenilenir — süresi geçmiş bir
 *   linki tekrar e-postalamak kullanıcıyı boşuna yürütürdü.
 * • `renew: true` geçerli linki de değiştirir (link sızdıysa iptal yolu).
 * • Aksi hâlde mevcut link korunur, yalnızca e-posta tekrar gider.
 *
 * E-posta YALNIZCA `pending` postlar için gider: karar verilmiş bir post için
 * "İncele ve Onayla" maili atmak yanlış bilgi olurdu. Karar verilmiş postta da
 * link yenilenebilir — onay sayfasındaki "Instagram'a yayınla / tekrar dene"
 * butonu oradan çalışıyor ve linki ölmüş bir postta o yol da ölür.
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
    // Gövdesiz istek meşru: "linki koru, maili tekrar gönder" varsayılanı.
  }
  const renewRequested = (body as { renew?: unknown })?.renew === true;

  const { id } = await params;
  const scoped = getScopedDb(session);
  const post = await scoped.posts.findByIdWithClientAndLink(id);
  if (!post) {
    return NextResponse.json({ error: "Bu post bulunamadı" }, { status: 404 });
  }

  const linkDead = !post.approvalLink || isExpired(post.approvalLink.expiresAt);
  const shouldRenew = renewRequested || linkDead;

  let token = post.approvalLink?.token;
  if (shouldRenew) {
    const renewed = await scoped.posts.renewApprovalLink(post.id);
    if (!renewed) {
      return NextResponse.json({ error: "Bu post bulunamadı" }, { status: 404 });
    }
    token = renewed.token;
  }

  const approvalUrl = `${appBaseUrl(request)}/approve/${token}`;

  // Karar verilmiş postta mail atlanır ama link yenilemesi geçerlidir; yanıt
  // hangisinin olduğunu açıkça söyler ki arayüz "mail gitti" demesin.
  if (post.status !== "pending") {
    return NextResponse.json({
      approvalUrl,
      renewed: shouldRenew,
      emailSent: false,
      emailSkipped: "Bu posta karar verilmiş; onay e-postası gönderilmedi.",
    });
  }

  const agency = await db.agency.findUnique({ where: { id: session.agencyId } });
  const email = await sendApprovalRequestEmail({
    to: post.client.email,
    agencyName: agency?.name ?? "Ajansınız",
    clientName: post.client.name,
    approvalUrl,
    logoUrl: agency?.logoUrl,
    brandColor: agency?.brandColor,
  }).catch((error): EmailResult => {
    console.error("[approval-link] e-posta hatası:", error);
    return { sent: false, reason: error instanceof Error ? error.message : String(error) };
  });

  // Sonucu SAKLA — F5'in bütün mesele bu: panele bakan insan da öğrensin.
  await scoped.posts
    .recordApprovalEmail(post.id, email)
    .catch((error) => console.error("[approval-link] mail durumu yazılamadı:", error));

  return NextResponse.json({
    approvalUrl,
    renewed: shouldRenew,
    emailSent: email.sent,
    ...(email.sent ? {} : { emailError: email.reason }),
  });
}
