import { NextResponse } from "next/server";
import { sendAlert } from "@/lib/alerts";
import { db } from "@/lib/db";
import { bearerToken, secretsMatch } from "@/lib/api-key";
import { notifyAgencyTeam } from "@/lib/agency-notify";
import { sendApprovalReminderEmail } from "@/lib/email";
import { REMINDER_AFTER_DAYS, daysPending, reminderDecision } from "@/lib/reminders";

/**
 * Bekleyen postlar için günlük hatırlatma (F3).
 *
 * Neden var: post `pending`'de sonsuza kadar durabiliyordu. Müşteri postu
 * görmediyse ya da unuttuysa kimse dürtmüyordu; onay linki 7 günde ölünce iş
 * sessizce tamamen tıkanıyor ve bunu ancak biri panele bakarsa fark ediyordu.
 *
 * Kararı bu dosya VERMEZ: hangi posta ne yapılacağı `reminders.ts` içindeki
 * `reminderDecision` yükleminin işi. Buradaki tek iş kararı uygulamak — token
 * yenileme cron'uyla (`refresh-instagram-tokens`) birebir aynı desen.
 *
 * ─── Spam koruması ──────────────────────────────────────────────────────────
 * Her iki bildirim de post başına TEK SEFERLİK. Damga (`reminderSentAt` /
 * `expiryNoticeSentAt`) gönderimden SONRA yazılır ve bir sonraki gece kararı
 * `none`'a düşürür. Damga yazılamazsa (DB hatası) mail ertesi gün tekrar gider
 * — bu bilinçli tercih: "bir kez fazla hatırlatma" ile "hiç hatırlatmama"
 * arasında ikincisi daha pahalı.
 *
 * ─── Yetkilendirme ──────────────────────────────────────────────────────────
 * Token yenileme cron'uyla AYNI `CRON_SECRET`. Vercel bütün cron'lara aynı
 * Authorization başlığını gönderir; ikinci bir sır üretmenin faydası yok,
 * yönetilecek bir sır daha olurdu.
 */

export const dynamic = "force-dynamic";
// Çok sayıda bekleyen postta gönderimler sırayla gider; varsayılan 10sn dar kalır.
export const maxDuration = 60;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cron:reminders] CRON_SECRET tanımlı değil — istek reddedildi");
    return false;
  }
  const presented = bearerToken(request);
  if (!presented) return false;
  return secretsMatch(presented, secret);
}

function appBaseUrl(request: Request): string {
  return process.env.APP_URL ?? new URL(request.url).origin;
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });
  }

  const now = new Date();
  const baseUrl = appBaseUrl(request);

  // Tüm gövde try/catch'e alınıyor (F11): sarmadan önce burada bir DB hatası
  // ya da beklenmeyen istisna cron'u SESSİZCE çökertiyordu — istek 500 ile
  // düşüyor ama kimseye haber gitmiyordu. Buradaki `catch` yalnızca cron'un
  // KENDİSİ patladığında devreye girer; tek bir postun maili patlarsa o zaten
  // aşağıdaki döngü içi try/catch'te yutulup `failed` sayacına yazılıyor.
  try {
  // `getScopedDb` BİLEREK kullanılmıyor: cron'un oturumu yok ve işi ajanslar
  // ÜSTÜ. Dışarıya hiçbir müşteri verisi çıkmadığından IDOR yüzeyi yok —
  // token yenileme cron'undaki aynı bilinçli istisna.
  const pending = await db.post.findMany({
    where: { status: "pending" },
    select: {
      id: true,
      caption: true,
      createdAt: true,
      externalRef: true,
      reminderSentAt: true,
      expiryNoticeSentAt: true,
      agencyId: true,
      approvalLink: { select: { token: true, expiresAt: true } },
      client: { select: { name: true, email: true } },
      agency: { select: { email: true, name: true, logoUrl: true, brandColor: true } },
    },
  });

  let reminded = 0;
  let expiryNoticed = 0;
  let skipped = 0;
  let failed = 0;

  for (const post of pending) {
    const decision = reminderDecision(
      {
        status: "pending",
        createdAt: post.createdAt,
        reminderSentAt: post.reminderSentAt,
        expiryNoticeSentAt: post.expiryNoticeSentAt,
        linkExpiresAt: post.approvalLink?.expiresAt ?? null,
      },
      now
    );

    if (decision === "none") {
      skipped += 1;
      continue;
    }

    const bekleyenGun = daysPending(post.createdAt, now);
    // Postu tanıtan kısa etiket — ajans bildirimlerinde kullanılan aynı kalıp.
    const postRef = post.externalRef ?? post.caption.split("\n")[0].slice(0, 60);

    // Hata TEK TEK yutulur: bir postun maili patladığında diğerleri durmamalı.
    try {
      if (decision === "client_reminder") {
        const result = await sendApprovalReminderEmail({
          to: post.client.email,
          agencyName: post.agency.name ?? "Ajansınız",
          clientName: post.client.name,
          approvalUrl: `${baseUrl}/approve/${post.approvalLink!.token}`,
          logoUrl: post.agency.logoUrl,
          brandColor: post.agency.brandColor,
          daysPending: bekleyenGun,
        });
        if (!result.sent) {
          // Gitmeyen mail için damga YAZILMAZ — yarın tekrar denenir.
          failed += 1;
          console.error(
            `[cron:reminders] ${post.id} hatırlatması gönderilemedi: ${result.reason}`
          );
          continue;
        }
        await db.post.update({ where: { id: post.id }, data: { reminderSentAt: now } });
        reminded += 1;
        console.log(`[cron:reminders] ${post.id} müşteriye hatırlatıldı (${bekleyenGun} gün)`);
      } else {
        // Ekibin tamamına: linki yenileyebilecek kişi ajansı KURAN olmak
        // zorunda değil (gerekçe `agency-notify.ts` başında).
        const result = await notifyAgencyTeam(post.agencyId, {
          agencyEmail: post.agency.email,
          event: "link_expired",
          clientName: post.client.name,
          postRef,
          daysPending: bekleyenGun,
        });
        if (!result.sent) {
          failed += 1;
          console.error(
            `[cron:reminders] ${post.id} süre bildirimi gönderilemedi: ${result.reason}`
          );
          continue;
        }
        await db.post.update({ where: { id: post.id }, data: { expiryNoticeSentAt: now } });
        expiryNoticed += 1;
        console.log(`[cron:reminders] ${post.id} için ajansa süre bildirimi gitti`);
      }
    } catch (error) {
      failed += 1;
      console.error(`[cron:reminders] ${post.id} işlenemedi:`, error);
    }
  }

  // Yanıt yalnızca SAYI taşır — müşteri adı, e-posta, caption hiçbiri geçmez.
  // Bu çıktı Vercel cron loglarına düşüyor.
  return NextResponse.json({
    ok: true,
    reminderAfterDays: REMINDER_AFTER_DAYS,
    checked: pending.length,
    reminded,
    expiryNoticed,
    skipped,
    failed,
  });
  } catch (error) {
    console.error("[cron:reminders] cron çöktü:", error);
    // `key` sabit: bu cron zaten günde bir kez koşuyor, bastırma penceresi
    // burada "aynı günde tekrar tetiklenirse iki kez mail gitmesin" içindir.
    await sendAlert(
      "cron:pending-reminders:crash",
      "pending-reminders cron'u beklenmeyen hatayla çöktü",
      { error: error instanceof Error ? error.message : String(error) }
    );
    return NextResponse.json({ ok: false, error: "cron çöktü" }, { status: 500 });
  }
}
