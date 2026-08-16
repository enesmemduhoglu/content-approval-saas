import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { authenticateApiKey } from "@/lib/api-key";
import { db } from "@/lib/db";
import { ClientNotOwnedError, getScopedDb } from "@/lib/scoped-db";
import { InvalidImageError, uploadPostImage } from "@/lib/blob";
import { sendApprovalRequestEmail } from "@/lib/email";
import {
  MAX_IMAGES_PER_POST,
  validateCaption,
  validateImageUrls,
} from "@/lib/validation";

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

/** Gövdeden çıkarılan, henüz sahiplik kontrolünden geçmemiş alanlar. */
type ParsedBody = {
  caption: string;
  clientId: string;
  /** JSON yolu: hazır URL'ler. Form yolu: yüklenecek dosyalar. */
  images: { kind: "urls"; urls: string[] } | { kind: "files"; files: File[] };
  altTexts?: (string | null)[];
  externalRef?: string | null;
};

function badRequest(error: string, field?: string, status = 400) {
  return NextResponse.json({ error, field }, { status });
}

/**
 * Makine yolu (furi): `Content-Type: application/json` ile hazır public URL'ler.
 * Blob'a hiçbir şey yazılmaz — URL'ler doğrudan `PostImage.url`'e gider.
 */
async function parseJsonBody(request: Request): Promise<ParsedBody | NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Geçersiz istek");
  }
  const { caption, clientId, imageUrls, altTexts, externalRef } = (body ?? {}) as {
    caption?: unknown;
    clientId?: unknown;
    imageUrls?: unknown;
    altTexts?: unknown;
    externalRef?: unknown;
  };

  const captionError = validateCaption(caption);
  if (captionError) return badRequest(captionError, "caption");
  if (typeof clientId !== "string" || !clientId) {
    return badRequest("Müşteri seçmelisin", "clientId");
  }
  const urlError = validateImageUrls(imageUrls);
  if (urlError) return badRequest(urlError, "imageUrls");

  return {
    caption: (caption as string).trim(),
    clientId,
    images: { kind: "urls", urls: (imageUrls as string[]).map((url) => url.trim()) },
    altTexts: Array.isArray(altTexts)
      ? altTexts.map((item) => (typeof item === "string" && item.trim() ? item.trim() : null))
      : undefined,
    externalRef:
      typeof externalRef === "string" && externalRef.trim()
        ? externalRef.trim().slice(0, 500)
        : null,
  };
}

/** Panel yolu: `multipart/form-data` ile dosya yükleme (mevcut davranış). */
async function parseFormBody(request: Request): Promise<ParsedBody | NextResponse> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return badRequest("Geçersiz istek");
  }

  const caption = formData.get("caption");
  const clientId = formData.get("clientId");
  // Çoklu görsel (D3.3): aynı "image" alanında 1..MAX dosya
  const images = formData.getAll("image").filter((f): f is File => f instanceof File);

  const captionError = validateCaption(caption);
  if (captionError) return badRequest(captionError, "caption");
  if (typeof clientId !== "string" || !clientId) {
    return badRequest("Müşteri seçmelisin", "clientId");
  }
  if (images.length === 0) {
    return badRequest("En az bir görsel seçmelisin", "image");
  }
  if (images.length > MAX_IMAGES_PER_POST) {
    return badRequest(`En fazla ${MAX_IMAGES_PER_POST} görsel yükleyebilirsin`, "image");
  }

  return {
    caption: (caption as string).trim(),
    clientId,
    images: { kind: "files", files: images },
  };
}

export async function POST(request: Request) {
  // Oturum yoksa API anahtarı denenir (makine erişimi). Anahtar yalnızca
  // agencyId üretir; sorgular yine getScopedDb üzerinden gider — IDOR koruması
  // her iki yolda da aynıdır.
  const session = (await auth()) ?? (await authenticateApiKey(request));
  if (!session?.agencyId) {
    return NextResponse.json({ error: "Giriş gerekli" }, { status: 401 });
  }
  const scoped = getScopedDb(session);

  const isJson = (request.headers.get("content-type") ?? "").includes("application/json");
  const parsed = isJson ? await parseJsonBody(request) : await parseFormBody(request);
  if (parsed instanceof NextResponse) return parsed;

  // Müşteri sahipliği upload'dan ÖNCE kontrol edilir — cross-agency clientId
  // için blob'a hiç yazılmaz (IDOR koruması getScopedDb üzerinden).
  const client = await scoped.clients.findById(parsed.clientId);
  if (!client) {
    return badRequest("Bu müşteri bulunamadı", "clientId", 403);
  }

  let imageUrls: string[];
  if (parsed.images.kind === "urls") {
    imageUrls = parsed.images.urls;
  } else {
    try {
      imageUrls = [];
      for (const image of parsed.images.files) {
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

  try {
    const { post, approvalLink } = await scoped.posts.createWithApprovalLink({
      clientId: parsed.clientId,
      imageUrls,
      caption: parsed.caption,
      altTexts: parsed.altTexts,
      externalRef: parsed.externalRef,
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
