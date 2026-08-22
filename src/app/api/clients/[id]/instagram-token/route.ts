import { NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/api-key";
import { getScopedDb } from "@/lib/scoped-db";
import { isInstagramTokenExpired } from "@/lib/instagram-token";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

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
 * • Rate limit (S5): `/api/approve/[token]` ile aynı `checkRateLimit` +
 *   `getClientIp` — yeni bir limitleyici yazılmadı. `FURI_API_KEY` sızarsa bu
 *   uç nokta ham token'ı ne kadar hızlı boşaltabilir sınırlanmış olur.
 *   Varsayılan tavan (60sn'de 10 istek) korunuyor: bu bir makine yolu, furi
 *   token'ı cron/publish tetiklemesinde çeker, saniyede onlarca istek atan bir
 *   kullanım deseni yok — ayrı, daha yüksek bir tavan gerektirecek bir
 *   gerekçe görülmedi. İleride furi çok müşteriyi paralel yayınlayıp aynı
 *   IP'den dakikada 10'u aşarsa, bu tavan burada (rate-limit.ts) tek
 *   noktadan yükseltilir.
 * • Erişim logu (S5): her sonuç (başarılı/401/404/409) `clientId` + zaman +
 *   sonuçla loglanır — token sızarsa "ne zaman, kaç kez çekildi" sorusuna
 *   yanıt buradan çıkar. Token'ın kendisi ya da bir parçası ASLA loglanmaz.
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

type AccessOutcome = "basarili" | "401_yetkisiz" | "404_bulunamadi" | "409_baglanmamis";

// Token'ın kendisi ya da bir parçası burada ASLA yer almaz — yalnızca hangi
// müşteri, ne zaman, hangi sonuçla erişildiği. `clientId` bile ham token'dan
// farklı bir şey sızdırmaz: hangi müşterilerin var olduğu zaten ajans içinden
// biliniyor.
function logAccess(clientId: string, outcome: AccessOutcome): void {
  console.log(
    `[ig-token] erişim: clientId=${clientId} zaman=${new Date().toISOString()} sonuc=${outcome}`
  );
}

export async function GET(request: Request, { params }: RouteParams) {
  const ip = getClientIp(request.headers);
  if (await checkRateLimit(ip)) {
    return secretJson({ error: "Çok fazla istek, biraz sonra tekrar deneyin" }, 429);
  }

  const { id } = await params;

  const session = await authenticateApiKey(request);
  if (!session) {
    logAccess(id, "401_yetkisiz");
    return secretJson({ error: "Yetkisiz" }, 401);
  }

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
    logAccess(id, "404_bulunamadi");
    return secretJson({ error: "Bu müşteri bulunamadı", code: "client_not_found" }, 404);
  }

  if (!client.instagramAccessToken || !client.instagramUserId) {
    // 404 DEĞİL: müşteri var, sadece Instagram bağlı değil. furi bu ikisini
    // ayırt edebilmeli — biri yanlış yapılandırma (FURI_CLIENT_ID), diğeri
    // panelden hesap bağlanmamış olması.
    logAccess(id, "409_baglanmamis");
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
  logAccess(id, "basarili");
  return secretJson({
    clientId: client.id,
    instagramUserId: client.instagramUserId,
    accessToken: client.instagramAccessToken,
    expiresAt: expiry ? expiry.toISOString() : null,
    expired: isInstagramTokenExpired(expiry),
  });
}
