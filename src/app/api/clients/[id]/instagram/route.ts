import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getScopedDb } from "@/lib/scoped-db";
import { IGError, fetchInstagramAccount } from "@/lib/instagram";
import {
  validateInstagramAccessToken,
  validateInstagramTokenExpiry,
  validateInstagramUserId,
} from "@/lib/validation";

/**
 * Müşteriye Instagram bağlama / bağlantıyı kaldırma.
 *
 * Bu endpoint'in tek yazma yolu `getScopedDb(...).clients.updateInstagram`'dir;
 * `id` istekten gelse de sorgu daima oturumdaki `agencyId` ile filtrelenir —
 * başka ajansın müşterisi 404 alır.
 *
 * Yanıtlar `ClientView` döner: `instagramAccessToken` ASLA geri gönderilmez,
 * yerine `instagramConnected` + `instagramTokenHint` (son 4 karakter) çıkar.
 */

type RouteParams = { params: Promise<{ id: string }> };

function badRequest(error: string, field?: string, status = 400) {
  return NextResponse.json({ error, field }, { status });
}

export async function POST(request: Request, { params }: RouteParams) {
  const session = await auth();
  if (!session?.agencyId) {
    return NextResponse.json({ error: "Giriş gerekli" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Geçersiz istek");
  }

  const {
    accessToken,
    instagramUserId,
    tokenExpiry,
  } = (body ?? {}) as {
    accessToken?: unknown;
    instagramUserId?: unknown;
    tokenExpiry?: unknown;
  };

  const tokenError = validateInstagramAccessToken(accessToken);
  if (tokenError) return badRequest(tokenError, "accessToken");
  const token = (accessToken as string).trim();

  // Hesap kimliği opsiyonel: boşsa token'dan türetilir. Doluysa da doğrulanır,
  // sonra token'ın gerçek hesabıyla karşılaştırılır — yanlış eşleşmeyle yayın
  // yapıp "hangi hesaba gitti" sorusuna düşmemek için.
  let requestedUserId: string | null = null;
  if (typeof instagramUserId === "string" && instagramUserId.trim() !== "") {
    const userIdError = validateInstagramUserId(instagramUserId);
    if (userIdError) return badRequest(userIdError, "instagramUserId");
    requestedUserId = instagramUserId.trim();
  }

  let expiry: Date | null = null;
  if (typeof tokenExpiry === "string" && tokenExpiry.trim() !== "") {
    const expiryError = validateInstagramTokenExpiry(tokenExpiry);
    if (expiryError) return badRequest(expiryError, "tokenExpiry");
    expiry = new Date(tokenExpiry.trim());
  }

  // Müşteri sahipliği Instagram'a gitmeden ÖNCE kontrol edilir — başka ajansın
  // müşteri id'siyle bizim üzerimizden Graph'a istek attırılmasın.
  const { id } = await params;
  const scoped = getScopedDb(session);
  const existing = await scoped.clients.findById(id);
  if (!existing) {
    return NextResponse.json({ error: "Bu müşteri bulunamadı" }, { status: 404 });
  }

  let account: Awaited<ReturnType<typeof fetchInstagramAccount>>;
  try {
    account = await fetchInstagramAccount(token);
  } catch (error) {
    // Ayrıntı log'a; kullanıcıya yalnızca anlaşılır Türkçe özet.
    console.error("[instagram] token doğrulama hatası:", error instanceof IGError ? error.report() : error);
    return badRequest(
      "Instagram bu token'ı kabul etmedi. Süresi dolmuş ya da yanlış kopyalanmış olabilir.",
      "accessToken"
    );
  }

  if (requestedUserId && requestedUserId !== account.userId) {
    return badRequest(
      `Bu token ${account.userId} hesabına ait, girdiğin kimlik (${requestedUserId}) ile eşleşmiyor`,
      "instagramUserId"
    );
  }

  const client = await scoped.clients.updateInstagram(existing.id, {
    instagramUserId: account.userId,
    instagramAccessToken: token,
    instagramTokenExpiry: expiry,
  });
  if (!client) {
    return NextResponse.json({ error: "Bu müşteri bulunamadı" }, { status: 404 });
  }

  return NextResponse.json({ client, username: account.username });
}

/** Bağlantıyı kaldırır — üç alan da temizlenir, yayın akışı "skipped"e döner. */
export async function DELETE(_request: Request, { params }: RouteParams) {
  const session = await auth();
  if (!session?.agencyId) {
    return NextResponse.json({ error: "Giriş gerekli" }, { status: 401 });
  }

  const { id } = await params;
  const client = await getScopedDb(session).clients.updateInstagram(id, {
    instagramUserId: null,
    instagramAccessToken: null,
    instagramTokenExpiry: null,
  });
  if (!client) {
    return NextResponse.json({ error: "Bu müşteri bulunamadı" }, { status: 404 });
  }
  return NextResponse.json({ client });
}
