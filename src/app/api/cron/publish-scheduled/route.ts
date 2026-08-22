import { NextResponse } from "next/server";
import { sendAlert } from "@/lib/alerts";
import { db } from "@/lib/db";
import { bearerToken, secretsMatch } from "@/lib/api-key";
import { sendAgencyNoticeEmail } from "@/lib/email";
import { publishApprovedPost } from "@/lib/publish-post";

/**
 * Zamanlanmış yayın (F8): `publishAt` zamanı gelmiş, onaylanmış ama henüz
 * yayınlanmamış postları (`publishStatus = "scheduled"`) bulup yayınlar.
 * Yayın çekirdeği tamamen `publishApprovedPost` — onay yolunun kullandığı
 * AYNI idempotent kilit burada da geçerli (bkz. publish-post.ts, "scheduled"
 * artık kilidin kabul ettiği durumlardan biri).
 *
 * ─── Koşu başına sınır — NEDEN ──────────────────────────────────────────────
 * Tek bir postun yayını (özellikle çok slaytlı karusel) container oluşturma +
 * bekleme için ~40sn'ye (`IG_DEFAULT_BUDGET_MS`, instagram.ts), üstüne
 * media_publish + permalink çağrıları için ~15sn daha alabiliyor — worst-case
 * TEK POST ~55sn. Vercel fonksiyon tavanı (`maxDuration`) 60sn ve postlar
 * SIRAYLA yayınlanıyor (paralel yayın hem kilit hem Instagram rate limit
 * açısından güvenli değil) — bu yüzden aynı koşuda birden fazla postu
 * arka arkaya denemek koşuyu ortasında kestirebilir. `TIME_BUDGET_MS` bunu
 * zamanla erken çıkarak, `RUN_LIMIT` de sorguyu baştan küçük tutarak önler.
 * Yarıda kesilen bir post `publishing` kilidinde TAKILI KALMAZ: kesilen post
 * hiç `publishApprovedPost` çağrılmadan atlanır (döngü BAŞLAMADAN önce zaman
 * kontrolü yapılır), yani `scheduled` durumunda kalır ve bir sonraki koşuda
 * güvenle tekrar denenir.
 *
 * ─── Vercel Hobby cron sıklığı — ARAŞTIRILDI, DÜRÜST SÖYLENİYOR ─────────────
 * Vercel'in resmi dokümanına göre (docs/cron-jobs/usage-and-pricing) Hobby
 * planı cron'ları GÜNDE BİR'e sınırlıyor; saatlik/dakikalık desenler DEPLOY
 * SIRASINDA reddediliyor ("Hobby accounts are limited to daily cron jobs").
 * Üstüne o tek günlük koşunun kendisi de dakika hassasiyetinde DEĞİL: Vercel
 * onu tanımlı SAAT içinde herhangi bir anda tetikleyebiliyor (±59dk).
 * Sonuç: bu depo Hobby planda çalıştığı sürece (bkz. README.md) `publishAt`
 * "en iyi saatte yayınla" değil, GÜNDE BİR KOŞUYLA ANCAK ±24 SAAT İSABET
 * demektir — saat/dakika hassasiyeti için Pro plana geçmek gerekir. Bu sınır
 * burada gizlenmiyor; `vercel.json`'daki TEK günlük satır bunun kabulü.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** bkz. yukarıdaki "koşu başına sınır" yorumu — ikisi birlikte savunma katmanı. */
const RUN_LIMIT = 5;
const TIME_BUDGET_MS = 50_000;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cron:publish-scheduled] CRON_SECRET tanımlı değil — istek reddedildi");
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

  const start = Date.now();
  const now = new Date();

  // Tüm gövde try/catch'e alınıyor (F11 deseni, bkz. pending-reminders): bir
  // DB hatası cron'u SESSİZCE 500'e düşürmesin, operatöre haber gitsin.
  try {
    const due = await db.post.findMany({
      where: { status: "approved", publishStatus: "scheduled", publishAt: { lte: now } },
      orderBy: { publishAt: "asc" },
      take: RUN_LIMIT,
      // Bildirim için gereken alanlar da burada okunuyor: yayın sonrası ikinci
      // bir sorgu açmamak için (cron zaten 60sn tavanıyla yarışıyor).
      select: {
        id: true,
        caption: true,
        externalRef: true,
        client: { select: { name: true } },
        agency: { select: { email: true } },
      },
    });

    let published = 0;
    let skipped = 0;
    let failed = 0;
    let deferred = 0;

    for (const post of due) {
      // Zaman bütçesi doldu: kalanlar hiç DENENMEDEN bir sonraki koşuya
      // bırakılır — "publishing" kilidinde yarım kalmış post riski yok.
      if (Date.now() - start > TIME_BUDGET_MS) {
        deferred += due.length - published - skipped - failed;
        break;
      }
      try {
        const outcome = await publishApprovedPost(post.id);
        if (outcome.publishStatus === "published") published += 1;
        else if (outcome.publishStatus === "skipped" || outcome.publishStatus === "duplicate")
          skipped += 1;
        else failed += 1;
        await notifyAgency(post, outcome);
      } catch (error) {
        // publishApprovedPost sözleşmesi "asla throw etme" ama burada da
        // yutuluyor: bir postun beklenmeyen hatası diğerlerini durdurmasın
        // (pending-reminders'taki aynı desen).
        failed += 1;
        console.error(`[cron:publish-scheduled] ${post.id} işlenemedi:`, error);
      }
    }

    // Yanıt yalnızca SAYI taşır — caption/müşteri bilgisi sızmaz.
    return NextResponse.json({ ok: true, checked: due.length, published, skipped, failed, deferred });
  } catch (error) {
    console.error("[cron:publish-scheduled] cron çöktü:", error);
    await sendAlert(
      "cron:publish-scheduled:crash",
      "publish-scheduled cron'u beklenmeyen hatayla çöktü",
      { error: error instanceof Error ? error.message : String(error) }
    );
    return NextResponse.json({ ok: false, error: "cron çöktü" }, { status: 500 });
  }
}

/**
 * Zamanlanmış yayının SONUCUNU ajansa bildirir.
 *
 * Neden gerekli: anında yayın yolunda ajans tek mailde hem kararı hem yayının
 * akıbetini görüyor (bkz. `approve/[token]/route.ts` — "onaylandı deyip yayının
 * patladığını söylemeyen bir mail en çok bilinmesi gereken şeyi gizler").
 * Zamanlanmış yolda o mail onay ANINDA gidiyor ve yalnızca "planlanan saatte
 * yayınlanacak" diyebiliyor; yayının kendisi saatler sonra, kimse bakmazken
 * oluyor. Bu bildirim olmasaydı ajans için zamanlanmış yayın SESSİZ bir kutu
 * olurdu: tuttu mu, patladı mı, hiç öğrenemezdi.
 *
 * Bildirim gönderimi yayını ETKİLEMEZ — patlarsa yalnızca loglanır; post çoktan
 * yayınlanmış durumda ve bir mail hatası bunu geri almaz.
 */
async function notifyAgency(
  post: {
    caption: string;
    externalRef: string | null;
    client: { name: string };
    agency: { email: string | null };
  },
  outcome: { publishStatus: string; igPermalink?: string | null }
): Promise<void> {
  if (!post.agency.email) return;
  await sendAgencyNoticeEmail({
    to: post.agency.email,
    event: "approved",
    clientName: post.client.name,
    postRef: post.externalRef ?? post.caption.split("\n")[0].slice(0, 80),
    publishStatus: outcome.publishStatus,
    igPermalink: outcome.igPermalink ?? null,
  }).catch((error) =>
    console.error("[cron:publish-scheduled] ajans bildirimi hatası:", error)
  );
}
