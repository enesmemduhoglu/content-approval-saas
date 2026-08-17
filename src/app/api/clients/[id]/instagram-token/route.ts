import { NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/api-key";
import { getScopedDb } from "@/lib/scoped-db";
import { isInstagramTokenExpired } from "@/lib/instagram-token";

/**
 * Instagram token'ının TEK KAYNAKTAN dağıtımı (makine erişimi, furi).
 *
 * Neden var: aynı token'ın iki kopyası vardı — SaaS'ta `Client.instagramAccessToken`,
 * furi'de kendi `IG_ACCESS_TOKEN` env değişkeni. Aralarında senkron yoktu.
 * `/api/cron/refresh-instagram-tokens` SaaS kopyasını yenilediğinde Instagram
 * eskisini kısa süre sonra geçersiz kılıyor ve furi'nin kopyası SESSİZCE
 * bayatlıyordu. Kopyayı yok etmenin yolu: furi token'ı her çalışmada buradan
 * çeksin, kendi kopyasını hiç tutmasın.
 *
 * ─── Güvenlik kararları ────────────────────────────────────────────────────
 * • Kimlik doğrulama YALNIZCA API anahtarı (`authenticateApiKey`, sabit zamanlı).
 *   Tarayıcı oturumu (`auth()`) BİLEREK kabul edilmiyor: panelde ham token
 *   göstermek bir gereksinim değil ve `GET /api/clients` tam da token sızdırdığı
 *   için `ClientView` ile kapatılmıştı. O düzeltme yerinde duruyor; burası ondan
 *   ayrı, dar ve bilinçli bir makine yolu. Oturum yolu açılırsa panelde bir XSS
 *   token'ı dışarı taşıyabilir — açılmıyor.
 * • Ajans kapsamı `getScopedDb` üzerinden: anahtar yalnızca `agencyId` üretir,
 *   sorgu daima o `agencyId` ile filtrelenir. Başka ajansın müşteri id'si 404
 *   alır — "yok" ile "senin değil" ayırt edilmez.
 * • Yanıt ham token taşır (endpoint'in işi bu), ama LOG ve HATA metinleri asla
 *   taşımaz — `refresh-instagram-tokens` route'undaki kalıp aynen sürüyor.
 * • Yanıt minimum: hangi müşteri, token, bitiş tarihi, hesap kimliği. Müşteri
 *   adı, e-postası, post sayısı — hiçbiri yok.
 */

type RouteParams = { params: Promise<{ id: string }> };

// Token yanıtı ne CDN'e ne de Next önbelleğine düşmeli.
export const dynamic = "force-dynamic";

/** Sır taşıyan her yanıtta aynı başlıklar — ara katmanlar kopyalamasın. */
function secretJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate, private" },
  });
}

export async function GET(request: Request, { params }: RouteParams) {
  const session = await authenticateApiKey(request);
  if (!session) {
    return secretJson({ error: "Yetkisiz" }, 401);
  }

  const { id } = await params;

  // Token DB'de şifreli duruyor (S1); okuma yolu çözüyor. Anahtar kaybolmuş ya
  // da kayıt bozulmuşsa şifreli metni "token" diye göndermek, furi tarafında
  // teşhisi imkânsız bir "Instagram kabul etmedi" hatasına dönerdi — bunun
  // yerine açık bir 500 dönüyoruz.
  let client: Awaited<
    ReturnType<ReturnType<typeof getScopedDb>["clients"]["findInstagramCredentials"]>
  >;
  try {
    client = await getScopedDb(session).clients.findInstagramCredentials(id);
  } catch (error) {
    // Mesaj sırrın kendisini taşımaz; ayrıntı yalnızca log'a.
    console.error("[ig-token] token çözülemedi:", error);
    return secretJson(
      {
        error: "Token sunucuda çözülemedi — yapılandırma sorunu",
        code: "token_undecryptable",
      },
      500
    );
  }

  // Başka ajansın müşterisi de, hiç olmayan id de aynı yanıtı alır — hangi
  // id'lerin var olduğu bilgisi de sızmasın.
  if (!client) {
    return secretJson({ error: "Bu müşteri bulunamadı", code: "client_not_found" }, 404);
  }

  if (!client.instagramAccessToken || !client.instagramUserId) {
    // 404 DEĞİL: müşteri var, sadece Instagram bağlı değil. furi bu ikisini
    // ayırt edebilmeli — biri yanlış yapılandırma (FURI_CLIENT_ID), diğeri
    // panelden hesap bağlanmamış olması.
    return secretJson(
      {
        error: "Bu müşteride Instagram hesabı bağlı değil",
        code: "instagram_not_connected",
      },
      409
    );
  }

  const expiry = client.instagramTokenExpiry;
  // Süresi dolmuş token'ı gizlemiyoruz — furi'nin eline geçen şey ile SaaS'ın
  // yayınlarken kullandığı şey aynı olsun. Ama "dolmuş" bilgisi açıkça
  // işaretlenir ki furi sessizce 190 hatasına koşmasın.
  return secretJson({
    clientId: client.id,
    instagramUserId: client.instagramUserId,
    accessToken: client.instagramAccessToken,
    expiresAt: expiry ? expiry.toISOString() : null,
    expired: isInstagramTokenExpired(expiry),
  });
}
