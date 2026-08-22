import { NextResponse } from "next/server";
import { sendAlert } from "@/lib/alerts";
import { db } from "@/lib/db";
import { bearerToken, secretsMatch } from "@/lib/api-key";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { IGError, refreshInstagramToken } from "@/lib/instagram";
import {
  IG_TOKEN_REFRESH_DAYS,
  instagramTokenRefreshDecision,
} from "@/lib/instagram-token";

/**
 * Instagram long-lived token'larının günlük otomatik yenilenmesi (Vercel cron).
 *
 * Neden var: token 60 günlük ve dolduğunda yayın SESSİZCE durur — post
 * `publishStatus='failed'` olur. Önceden tek savunma dashboard'daki uyarı
 * şeridiydi ve ajansın onu görüp elle yenilemesi gerekiyordu.
 *
 * Kararı bu dosya vermez: hangi müşterinin yenileneceği `instagram-token.ts`
 * içindeki `instagramTokenRefreshDecision` yükleminin işidir; buradaki tek iş
 * o kararı uygulamak ve sonucu loglamaktır.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TOKEN'IN TEK KOPYASI VAR — BURASI
 *
 * Eskiden aynı token furi'de de ayrı bir ortam değişkeninde duruyordu ve bu
 * cron SaaS kopyasını yenilediğinde furi'ninki sessizce bayatlıyordu. Artık
 * furi kendi kopyasını tutmuyor; token'ı her çalışmada
 * `GET /api/clients/[id]/instagram-token` üzerinden buradan çekiyor.
 * Dolayısıyla bu cron yenilediği anda furi de yeni token'ı görür.
 *
 * Bu bağı kırmadan önce oraya bak: furi'nin env'ine token geri konursa aynı
 * bayatlama sorunu geri gelir.
 * ────────────────────────────────────────────────────────────────────────────
 */

// Cron her çağrıda taze veri okumalı; statik/ISR önbelleğe düşmesin.
export const dynamic = "force-dynamic";
// Çok müşterili kurulumda yenilemeler sırayla gider; varsayılan 10sn dar kalır.
export const maxDuration = 60;

/**
 * Vercel cron `Authorization: Bearer $CRON_SECRET` gönderir. Sır tanımlı
 * değilse endpoint TAMAMEN kapalıdır — yanlışlıkla herkese açık bir token
 * yenileme uç noktası bırakmaktansa cron'un patlaması yeğdir.
 */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cron:ig-token] CRON_SECRET tanımlı değil — istek reddedildi");
    return false;
  }
  const presented = bearerToken(request);
  if (!presented) return false;
  return secretsMatch(presented, secret);
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });
  }

  const now = new Date();

  // Tüm gövde try/catch'e alınıyor (F11) — aynı gerekçe pending-reminders
  // cron'undaki gibi: sarmadan önce beklenmeyen bir istisna cron'u sessizce
  // çökertiyordu. Döngü içindeki try/catch tek müşteri hatasını yutuyor;
  // buradaki dıştaki catch yalnızca CRON'UN KENDİSİ patladığında çalışır.
  try {
  // `getScopedDb` BİLEREK kullanılmıyor: cron'un oturumu yok ve işi ajanslar
  // ÜSTÜ — tüm müşterilerin token'ını yeniler. Scoped sarmalayıcı ayrıca
  // `ClientView` döndürdüğü için token'ı hiç vermez; yenileme için token
  // zorunlu. Bu, kuralın bilinçli ve tek istisnasıdır: dışarıya hiçbir müşteri
  // verisi çıkmadığından IDOR yüzeyi yoktur.
  const clients = await db.client.findMany({
    where: { instagramAccessToken: { not: null }, instagramUserId: { not: null } },
    select: {
      id: true,
      name: true,
      instagramUserId: true,
      instagramAccessToken: true,
      instagramTokenExpiry: true,
    },
  });

  let refreshed = 0;
  let skipped = 0;
  let expired = 0;
  let failed = 0;

  for (const client of clients) {
    const decision = instagramTokenRefreshDecision(client, now);

    if (decision === "skip") {
      skipped += 1;
      continue;
    }

    if (decision === "expired") {
      expired += 1;
      console.error(
        `[cron:ig-token] ${client.id} (${client.name}) token süresi DOLMUŞ — ` +
          "otomatik yenilenemez, hesabın elle yeniden bağlanması gerekiyor"
      );
      continue;
    }

    // Tek tek denenir ve hata BURADA yutulur: bir müşterinin token'ını
    // Instagram reddettiğinde diğerlerinin yenilenmesi durmamalı.
    try {
      // Token DB'de şifreli (S1): Instagram'a giderken çözülür, dönen YENİ
      // token yazılırken tekrar şifrelenir. Çözme hatası da bu `catch`e düşer
      // ve o müşteri "failed" sayılır — diğerleri etkilenmez.
      const current = decryptSecret(client.instagramAccessToken as string);
      const result = await refreshInstagramToken(current);
      await db.client.update({
        where: { id: client.id },
        data: {
          instagramAccessToken: encryptSecret(result.accessToken),
          instagramTokenExpiry: result.expiresAt,
        },
      });
      refreshed += 1;
      console.log(
        `[cron:ig-token] ${client.id} (${client.name}) yenilendi — ` +
          `yeni bitiş ${result.expiresAt.toISOString()}`
      );
    } catch (error) {
      failed += 1;
      // Ayrıntı yalnızca log'a; `IGError.report()` token taşımaz.
      console.error(
        `[cron:ig-token] ${client.id} (${client.name}) yenilenemedi:`,
        error instanceof IGError ? error.report() : error
      );
    }
  }

  // Yanıt SADECE sayı taşır. Token'ın kendisi, bir parçası, ipucu ya da müşteri
  // adı bile geçmez — bu endpoint'in çıktısı Vercel cron loglarına düşüyor.
  return NextResponse.json({
    ok: true,
    windowDays: IG_TOKEN_REFRESH_DAYS,
    checked: clients.length,
    refreshed,
    skipped,
    expired,
    failed,
  });
  } catch (error) {
    console.error("[cron:ig-token] cron çöktü:", error);
    await sendAlert(
      "cron:refresh-instagram-tokens:crash",
      "refresh-instagram-tokens cron'u beklenmeyen hatayla çöktü",
      { error: error instanceof Error ? error.message : String(error) }
    );
    return NextResponse.json({ ok: false, error: "cron çöktü" }, { status: 500 });
  }
}
