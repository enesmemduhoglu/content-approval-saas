import { NextResponse } from "next/server";
import { sendAlert } from "@/lib/alerts";
import { notifyAgencyTeam } from "@/lib/agency-notify";
import { portalUrl, queueRecipient, sendSlotEmptyEmail, type SlotEmptyReason } from "@/lib/email-queue";
import { isInstagramTokenExpired, isPublishTarget } from "@/lib/instagram-token";
import { publishApprovedPost, resumePublish } from "@/lib/publish-post";
import { notifyClientUsers } from "@/lib/push";
import { slotEmptyPush } from "@/lib/push-messages";
import { authorizeQueueRequest } from "@/lib/qstash";
import { SLOT_LOOKBACK_MS, SLOT_WINDOW_MS, dueSlots, isEligible, pickNext } from "@/lib/queue";
import {
  attachPostToSlotRun,
  autoApprovePost,
  claimPostForSlot,
  claimSlotRun,
  findPortalPublishingPosts,
  findQueueClients,
  finishSlotRun,
  loadQueue,
  recentSlotRunTimes,
  type QueueClient,
} from "@/lib/queue-db";

/**
 * Video kuyruğu (V4) — slot tabanlı yayın tick'i. QStash her 5 dakikada bir
 * çağırır (K7); yedek tetikleyici cron-job.org + `CRON_SECRET`.
 *
 * Her müşteri için (README §5):
 *   1. `paused` → vadesi gelen slotlara `SlotRun(paused)`, yayın yok.
 *   2. Penceresi (1 saat) kaçmış slot → `SlotRun(skipped)`, yayın yok (K8).
 *   3. Vadesi gelen slot → `SlotRun` INSERT; UNIQUE çakışması = başka tick aldı.
 *   4. `pickNext` → yoksa `empty` + e-posta.
 *   5. Onay kapalıysa koşullu `pending → approved` + `ApprovalAudit(auto_approved)`.
 *   6. `publishApprovedPost` (throw etmez, kendi kilidi ve onay kontrolü var).
 * Ardından `publishing`de kalmış portal videoları `resumePublish` ile ilerletilir.
 *
 * ─── Zaman bütçesi ──────────────────────────────────────────────────────────
 * Tek bir video yayını ~30 sn yoklama (`IG_VIDEO_BUDGET_MS`) + container açma +
 * media_publish sürebiliyor; fonksiyon tavanı 60 sn. Yeni bir yayın ya da
 * devam ettirme yalnızca `START_DEADLINE_MS` dolmadan BAŞLATILIR; başlamayan
 * slotun `SlotRun` satırı hiç yazılmaz, yani sonraki tick (5 dk sonra, hâlâ
 * pencerenin içinde) onu yeniden görür. Yarıda kesilen bir iş kalmaz.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Bundan sonra hiçbir yeni iş başlamaz (ucuz satırlar dahil). */
const TIME_BUDGET_MS = 50_000;
/**
 * Yeni bir YAYIN ya da devam ettirme bu süre dolmadan başlamalı: 20 sn + ~35 sn
 * worst-case yayın = 55 sn, 60 sn tavanının altında.
 */
const START_DEADLINE_MS = 20_000;
/** Tek tick'te devam ettirilecek azami video sayısı. */
const RESUME_LIMIT = 5;
/** Aynı slot için yarışta kaybedilen post seçiminden sonra kaç kez yeniden seçilir. */
const PICK_ATTEMPTS = 3;

type Stats = {
  clients: number;
  published: number;
  publishing: number;
  failed: number;
  empty: number;
  skipped: number;
  paused: number;
  /** Başka bir tick'in aldığı slotlar. */
  lost: number;
  /** Bütçe dolduğu için sonraki tick'e bırakılan slotlar. */
  deferred: number;
  resumed: number;
};

export async function POST(request: Request) {
  return handle(request);
}

/** Yedek tetikleyici (cron-job.org) GET atabilsin diye; kapı aynı. */
export async function GET(request: Request) {
  return handle(request);
}

async function handle(request: Request) {
  // Ham gövde imzanın parçası — JSON'a çevrilmeden ÖNCE okunmalı (qstash.ts).
  const rawBody = await request.text();
  if (!(await authorizeQueueRequest(request, rawBody))) {
    return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });
  }

  const start = Date.now();
  const now = new Date();
  const elapsed = () => Date.now() - start;
  const stats: Stats = {
    clients: 0,
    published: 0,
    publishing: 0,
    failed: 0,
    empty: 0,
    skipped: 0,
    paused: 0,
    lost: 0,
    deferred: 0,
    resumed: 0,
  };
  // Bu tick'te yayını başlatılan postlar: az önce 30 sn yoklandılar, aynı turda
  // tekrar yoklamak yalnızca bütçe yer.
  const touched = new Set<string>();

  try {
    const clients = await findQueueClients();
    stats.clients = clients.length;

    for (const settings of clients) {
      if (elapsed() > TIME_BUDGET_MS) break;
      // Müşteri başına yutulur: birinin DB/e-posta hatası diğerlerinin
      // slotunu kaçırtmamalı.
      try {
        await processClient(settings, now, stats, touched, elapsed);
      } catch (error) {
        console.error(`[queue:tick] müşteri ${settings.clientId} işlenemedi:`, error);
        await sendAlert("queue:tick:client", "Kuyruk tick'i bir müşteride patladı", {
          clientId: settings.clientId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Instagram'ın hâlâ işlediği videolar. Günlük cron'un "takılı" dalından
    // (10 dk) farkı bir dakikalık container'ları da almak: portal postunun onay
    // sayfasında yoklayan bir tarayıcı yok, beklemek yalnızca yayını geciktirir.
    // Bir dakikadan tazesi alınmaz: onu açan (eşzamanlı) tick hâlâ yokluyor olabilir.
    const publishing = await findPortalPublishingPosts(
      RESUME_LIMIT,
      new Date(Date.now() - maxDuration * 1000)
    );
    for (const post of publishing) {
      if (touched.has(post.id)) continue;
      if (elapsed() > START_DEADLINE_MS) break;
      try {
        const outcome = await resumePublish(post.id);
        stats.resumed += 1;
        if (outcome.publishStatus === "published") stats.published += 1;
        else if (outcome.publishStatus === "failed") stats.failed += 1;
        // Sonuç e-postası ve SlotRun sonucu `publish-post`un kancasında.
      } catch (error) {
        console.error(`[queue:tick] ${post.id} devam ettirilemedi:`, error);
      }
    }

    // Yanıt yalnızca SAYI taşır — caption/müşteri bilgisi QStash loglarına düşmesin.
    return NextResponse.json({ ok: true, ...stats });
  } catch (error) {
    console.error("[queue:tick] tick çöktü:", error);
    await sendAlert("queue:tick:crash", "Kuyruk tick'i beklenmeyen hatayla çöktü", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ ok: false, error: "tick çöktü" }, { status: 500 });
  }
}

async function processClient(
  settings: QueueClient,
  now: Date,
  stats: Stats,
  touched: Set<string>,
  elapsed: () => number
): Promise<void> {
  const { client } = settings;
  // Pencere + geriye bakış kadar eski kayıtlar yeter; `dueSlots` daha eskisini üretmez.
  const since = new Date(now.getTime() - SLOT_LOOKBACK_MS - SLOT_WINDOW_MS);
  const runs = await recentSlotRunTimes(client.id, since);
  const due = dueSlots(settings, now, runs);

  for (const slot of due) {
    if (elapsed() > TIME_BUDGET_MS) {
      stats.deferred += 1;
      continue;
    }

    // Duraklatılmışken de satır yazılır: "o gün neden yayın olmadı" sorusunun
    // cevabı SlotRun'da dursun, duraklatma kalkınca eski slotlar da art arda
    // yayına girmesin.
    if (settings.paused) {
      if (await claimSlotRun(client.id, slot.slotAt, { outcome: "paused" })) stats.paused += 1;
      continue;
    }

    if (slot.action === "skip") {
      const claimed = await claimSlotRun(client.id, slot.slotAt, {
        outcome: "skipped",
        detail: "Slot penceresi kaçırıldı (1 saatten geç görüldü)",
      });
      if (claimed) stats.skipped += 1;
      continue;
    }

    // Yayın bütçeye sığmayacaksa slot SAHİPLENİLMEDEN bırakılır: sonraki tick
    // hâlâ pencerenin içinde ve onu yeniden görecek.
    if (elapsed() > START_DEADLINE_MS) {
      stats.deferred += 1;
      continue;
    }
    if (!(await claimSlotRun(client.id, slot.slotAt))) {
      stats.lost += 1;
      continue;
    }
    await runSlot(settings, slot.slotAt, now, stats, touched);
  }
}

/** Sahiplenilmiş TEK bir slotu sonuçlandırır. */
async function runSlot(
  settings: QueueClient,
  slotAt: Date,
  now: Date,
  stats: Stats,
  touched: Set<string>
): Promise<void> {
  const { client } = settings;
  const to = queueRecipient(settings, client.email);

  // Instagram tarafı hazır değilse video HARCANMAZ. `publishApprovedPost` bu
  // durumda postu `skipped`/`failed` yapardı ve her slot kuyruktan bir video
  // daha yakardı; bağlantı düzeldiğinde kuyruk kaldığı yerden sürmeli.
  const blocked = !isPublishTarget(client)
    ? "Instagram hesabı bağlı değil"
    : isInstagramTokenExpired(client.instagramTokenExpiry)
      ? "Instagram erişim izninin süresi dolmuş"
      : null;
  if (blocked) {
    await finishSlotRun(client.id, slotAt, { outcome: "failed", detail: blocked });
    stats.failed += 1;
    await notifySlotEmpty(settings, to, slotAt, "blocked", { detail: blocked });
    // Bunu yalnızca ajans düzeltebilir (hesabı bağlamak / token yenilemek).
    await notifyAgencyTeam(client.agencyId, {
      agencyEmail: client.agency.email,
      event: "queue_failed",
      clientName: client.name,
      postRef: "Kuyruk",
      publishError: `${blocked} — kuyruk bekliyor, video harcanmadı`,
    }).catch((error) => console.error("[queue:tick] ajans bildirimi hatası:", error));
    return;
  }

  const exclude = new Set<string>();
  for (let attempt = 0; attempt < PICK_ATTEMPTS; attempt += 1) {
    const queue = await loadQueue(client.id);
    const candidates = queue.filter((post) => !exclude.has(post.id));
    const next = pickNext(candidates, settings.requireApproval);

    if (!next) {
      // Onay açık ve kuyrukta onay bekleyen hazır video varsa e-posta bunu
      // söylemeli: "kuyruk boş" demek kullanıcıyı yanlış işe (yükleme) yollar.
      const waiting = settings.requireApproval
        ? candidates.filter((post) => post.status === "pending" && isEligible(post, false)).length
        : 0;
      const reason: SlotEmptyReason = waiting > 0 ? "no_approved" : "empty";
      await finishSlotRun(client.id, slotAt, {
        outcome: "empty",
        detail: reason === "no_approved" ? `Onaylı video yok (${waiting} bekliyor)` : "Kuyruk boş",
      });
      stats.empty += 1;
      await notifySlotEmpty(settings, to, slotAt, reason, { pendingCount: waiting });
      return;
    }

    // İki FARKLI slot aynı postu seçmiş olabilir; kaybeden sıradakine geçer.
    if (!(await claimPostForSlot({ clientId: client.id, postId: next.id, slotAt, now }))) {
      exclude.add(next.id);
      continue;
    }
    await attachPostToSlotRun(client.id, slotAt, next.id);

    // K3: onay kapalıyken kararı kuyruk verir ve bu, kimin verdiği bilinsin
    // diye audit'e yazılır. Koşullu (`pending`) — o anda müşteri reddettiyse
    // onay yazılmaz ve aşağıdaki yayın, kilidin önündeki onay kontrolünde durur.
    if (!settings.requireApproval && next.status === "pending") {
      await autoApprovePost(client.id, next.id);
    }

    touched.add(next.id);
    const outcome = await publishApprovedPost(next.id);

    if (outcome.publishStatus === "published") {
      stats.published += 1;
      await finishSlotRun(client.id, slotAt, { outcome: "published" });
    } else if (outcome.publishStatus === "publishing") {
      // Instagram videoyu hâlâ işliyor: sonuç satırı BOŞ kalır, yayını sonraki
      // tick `resumePublish` ile bitirir ve sonucu `publish-post`un kancası yazar.
      stats.publishing += 1;
    } else {
      stats.failed += 1;
      await finishSlotRun(client.id, slotAt, {
        outcome: "failed",
        detail: outcome.publishError ?? `Yayın durumu: ${outcome.publishStatus}`,
      });
    }
    return;
  }

  // Her seçimi başka bir slot kaptı — bu slot için video kalmadı sayılır.
  await finishSlotRun(client.id, slotAt, { outcome: "empty", detail: "Uygun video başka slota gitti" });
  stats.empty += 1;
}

/** "Slot boş kaldı" e-postası + telefon bildirimi (V7c) — akışı asla düşürmez. */
async function notifySlotEmpty(
  settings: QueueClient,
  to: string,
  slotAt: Date,
  reason: SlotEmptyReason,
  extra: { pendingCount?: number; detail?: string }
): Promise<void> {
  try {
    const result = await sendSlotEmptyEmail({
      to,
      clientName: settings.client.name,
      slotAt,
      timezone: settings.timezone,
      reason,
      pendingCount: extra.pendingCount,
      detail: extra.detail ?? null,
      portalUrl: portalUrl(),
    });
    if (!result.sent) {
      console.error(`[queue:tick] slot e-postası gitmedi: ${settings.clientId} (${result.reason})`);
    }
  } catch (error) {
    console.error("[queue:tick] slot e-postası patladı:", error);
  }
  // E-postanın try'ının DIŞINDA: e-posta patlasa da bildirim gitsin.
  // `notifyClientUsers` throw etmez.
  await notifyClientUsers(
    settings.clientId,
    slotEmptyPush({
      slotAt,
      timezone: settings.timezone,
      reason,
      pendingCount: extra.pendingCount,
    })
  );
}
