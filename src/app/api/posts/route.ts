import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { ClientNotOwnedError, getScopedDb } from "@/lib/scoped-db";
import { InvalidImageError, uploadPostImage } from "@/lib/blob";
import { sendApprovalRequestEmail } from "@/lib/email";
import { MAX_IMAGES_PER_POST, validateCaption } from "@/lib/validation";

export async function GET() {
  const session = await auth();
  if (!session?.agencyId) {
    return NextResponse.json({ error: "Giriş gerekli" }, { status: 401 });
  }
  const posts = await getScopedDb(session).posts.findManyWithRelations({
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ posts });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.agencyId) {
    return NextResponse.json({ error: "Giriş gerekli" }, { status: 401 });
  }
  const scoped = getScopedDb(session);

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Geçersiz istek" }, { status: 400 });
  }

  const caption = formData.get("caption");
  const clientId = formData.get("clientId");
  // Çoklu görsel (D3.3): aynı "image" alanında 1..MAX dosya
  const images = formData.getAll("image").filter((f): f is File => f instanceof File);

  const captionError = validateCaption(caption);
  if (captionError) {
    return NextResponse.json({ error: captionError, field: "caption" }, { status: 400 });
  }
  if (typeof clientId !== "string" || !clientId) {
    return NextResponse.json(
      { error: "Müşteri seçmelisin", field: "clientId" },
      { status: 400 }
    );
  }
  if (images.length === 0) {
    return NextResponse.json(
      { error: "En az bir görsel seçmelisin", field: "image" },
      { status: 400 }
    );
  }
  if (images.length > MAX_IMAGES_PER_POST) {
    return NextResponse.json(
      { error: `En fazla ${MAX_IMAGES_PER_POST} görsel yükleyebilirsin`, field: "image" },
      { status: 400 }
    );
  }

  // Müşteri sahipliği upload'dan ÖNCE kontrol edilir — cross-agency clientId
  // için blob'a hiç yazılmaz (IDOR koruması getScopedDb üzerinden).
  const client = await scoped.clients.findById(clientId);
  if (!client) {
    return NextResponse.json(
      { error: "Bu müşteri bulunamadı", field: "clientId" },
      { status: 403 }
    );
  }

  let imageUrls: string[];
  try {
    imageUrls = [];
    for (const image of images) {
      imageUrls.push(await uploadPostImage(image));
    }
  } catch (error) {
    if (error instanceof InvalidImageError) {
      return NextResponse.json({ error: error.message, field: "image" }, { status: 400 });
    }
    console.error("[posts] görsel yükleme hatası:", error);
    return NextResponse.json(
      { error: "Görsel yüklenemedi, tekrar deneyin", field: "image" },
      { status: 400 }
    );
  }

  try {
    const { post, approvalLink } = await scoped.posts.createWithApprovalLink({
      clientId,
      imageUrls,
      caption: (caption as string).trim(),
    });

    const approvalUrl = `${appBaseUrl(request)}/approve/${approvalLink.token}`;

    // Fire-and-forget: e-posta hatası post oluşturmayı ASLA başarısız yapmaz.
    const agency = await db.agency.findUnique({ where: { id: session.agencyId } });
    await sendApprovalRequestEmail({
      to: client.email,
      agencyName: agency?.name ?? "Ajansınız",
      clientName: client.name,
      approvalUrl,
      logoUrl: agency?.logoUrl,
      brandColor: agency?.brandColor,
    }).catch((error) => console.error("[posts] e-posta hatası:", error));

    return NextResponse.json({ post, approvalUrl }, { status: 201 });
  } catch (error) {
    if (error instanceof ClientNotOwnedError) {
      return NextResponse.json(
        { error: error.message, field: "clientId" },
        { status: 403 }
      );
    }
    console.error("[posts] oluşturma hatası:", error);
    return NextResponse.json(
      { error: "Bir hata oluştu, tekrar deneyin" },
      { status: 500 }
    );
  }
}

function appBaseUrl(request: Request): string {
  return process.env.APP_URL ?? new URL(request.url).origin;
}
