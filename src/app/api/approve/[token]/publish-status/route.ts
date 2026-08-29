import { NextResponse } from "next/server";
import { resumePublishByApprovalToken } from "@/lib/publish-post";
import { getClientIp, checkRateLimit } from "@/lib/rate-limit";

/**
 * Devam eden bir video yayınını ilerletir ve güncel durumu döner.
 *
 * ─── Neden böyle bir uç var ────────────────────────────────────────────────
 * Görsel yayını onay isteğinin içinde bitiyor (~8.5sn/slayt). Video'da
 * Instagram dosyayı transcode ettiği için süre tek bir Vercel fonksiyon ömrüne
 * (60sn, Hobby) sığmıyor: onay isteği container'ı açıp bir tur yokluyor, iş
 * bitmezse post `publishing`de kalıyor. Yayını bitirecek olan bu uç — onay
 * sayfası birkaç saniyede bir çağırıyor.
 *
 * Zamanlanmış yayının cron'u bu işi ÜSTLENEMEZDİ: Hobby planı cron'ları günde
 * bire sınırlıyor (bkz. `cron/publish-scheduled`) — onaydan sonra yayının bir
 * güne kadar gecikmesi demek olurdu. Cron yine de emniyet ağı olarak duruyor,
 * tarayıcı kapanırsa post asılı kalmasın diye; hızlı yol burası.
 *
 * ─── Neden POST ────────────────────────────────────────────────────────────
 * Salt okuma gibi görünüyor ama değil: çağrı gerçekten Instagram'a yayın
 * basabilir. GET olsaydı bir link önizlemesi ya da önbellek yayın tetikleyebilirdi.
 *
 * Kimlik doğrulama onay linkinin kendisidir — tıpkı onay/red uçlarında olduğu
 * gibi; token'ı bilen zaten onaylayabiliyor, yayının bitmesini beklemek daha
 * dar bir yetki. `checkOrigin` YOK çünkü bu yolun oturumu da yok: CSRF'in
 * sömüreceği bir çerez kimliği bulunmuyor, tıpkı `POST /api/approve/[token]`de
 * olduğu gibi.
 */

// `resumePublish` bir yoklama turu (30sn) + media_publish yapabilir.
export const maxDuration = 60;

type RouteParams = { params: Promise<{ token: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  const ip = getClientIp(request.headers);
  if (await checkRateLimit(ip)) {
    return NextResponse.json(
      { error: "Çok fazla istek, biraz sonra tekrar deneyin" },
      { status: 429 }
    );
  }

  const { token } = await params;
  const outcome = await resumePublishByApprovalToken(token);
  if (!outcome) {
    return NextResponse.json({ error: "Bu link geçersiz" }, { status: 404 });
  }

  return NextResponse.json({
    publishStatus: outcome.publishStatus,
    igPermalink: outcome.igPermalink ?? null,
    publishError: outcome.publishError ?? null,
    linkExpired: outcome.linkExpired,
  });
}
