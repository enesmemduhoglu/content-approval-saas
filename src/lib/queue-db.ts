import { Prisma, type SlotOutcome } from "@prisma/client";
import { db } from "@/lib/db";
import { SLOT_WINDOW_MS } from "@/lib/queue";

/**
 * Video kuyruğu (V4) — tick'in ve günlük özetin SİSTEM DÜZEYİ sorguları.
 *
 * `getScopedDb` BİLEREK kullanılmıyor: tick bir cron gibi oturumsuz koşuyor ve
 * işi tüm müşterilerin kuyruğunu gezmek (`findStuckVideoPublishes` ile aynı
 * istisna). Bunun yerine her sorgu `clientId` ile AÇIKÇA kapsamlanıyor — bir
 * müşterinin slotu için seçilen post başka müşterinin kuyruğundan gelemez,
 * çünkü seçim, kilit ve onay yazımının hepsi `clientId`yi koşula koyuyor.
 * Dışarıya (HTTP yanıtına) hiçbir müşteri verisi çıkmıyor; tick yalnızca sayı döner.
 */

/** Ayarı olan bütün müşteriler — duraklatılmışlar da (onlara `paused` satırı yazılır). */
export function findQueueClients() {
  return db.publishSettings.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      client: {
        select: {
          id: true,
          name: true,
          email: true,
          agencyId: true,
          instagramUserId: true,
          instagramAccessToken: true,
          instagramTokenExpiry: true,
          agency: { select: { email: true } },
        },
      },
    },
  });
}

export type QueueClient = Awaited<ReturnType<typeof findQueueClients>>[number];

/** Müşterinin `since`den sonraki SlotRun anları — `dueSlots`un "kaydı var" filtresi. */
export async function recentSlotRunTimes(clientId: string, since: Date): Promise<Date[]> {
  const runs = await db.slotRun.findMany({
    where: { clientId, slotAt: { gte: since } },
    select: { slotAt: true },
  });
  return runs.map((run) => run.slotAt);
}

/**
 * Slotu SAHİPLEN: `(clientId, slotAt)` INSERT'i. İki tick aynı slotu aynı anda
 * görürse yalnızca INSERT'i başaran devam eder; UNIQUE çakışması (`P2002`)
 * "başkası aldı" demek ve `false` döner. Önce-oku-sonra-yaz yapılmıyor —
 * yarışın tek hakemi veritabanı.
 *
 * `outcome` verilirse satır sonucuyla birlikte doğar (skipped/paused: iş yok).
 */
export async function claimSlotRun(
  clientId: string,
  slotAt: Date,
  init: { outcome?: SlotOutcome; detail?: string } = {}
): Promise<boolean> {
  try {
    await db.slotRun.create({
      data: { clientId, slotAt, outcome: init.outcome ?? null, detail: init.detail ?? null },
    });
    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return false;
    }
    throw error;
  }
}

/** Slota seçilen postu işler — sonuç, yayının kendisi bitince yazılabilsin diye ÖNCE. */
export async function attachPostToSlotRun(
  clientId: string,
  slotAt: Date,
  postId: string
): Promise<void> {
  await db.slotRun.updateMany({ where: { clientId, slotAt }, data: { postId } });
}

/**
 * Slot sonucunu yazar — yalnızca henüz yazılmamışsa (`outcome: null`).
 * Video yayını birden çok turda bitebildiği için sonucu `publish-post`un
 * sonuç kancası da yazabiliyor (bkz. `recordSlotOutcomeForPost`); hangisi
 * önce yazarsa o kalır, diğeri üzerine yazmaz.
 */
export async function finishSlotRun(
  clientId: string,
  slotAt: Date,
  data: { outcome: SlotOutcome; postId?: string | null; detail?: string | null }
): Promise<void> {
  await db.slotRun.updateMany({
    where: { clientId, slotAt, outcome: null },
    data: {
      outcome: data.outcome,
      ...(data.postId !== undefined ? { postId: data.postId } : {}),
      detail: data.detail ? data.detail.slice(0, 500) : null,
    },
  });
}

/**
 * Yayın sonucu (başarı/hata) belli olduğunda o postun açık SlotRun'ını kapatır.
 * `publish-post.ts`teki sonuç kancasından çağrılır: tick'in turunda bitmeyen
 * video (Instagram hâlâ işliyor) sonraki tick ya da günlük cron'da biter ve
 * slotun sonucu ancak o zaman bilinir.
 */
export async function recordSlotOutcomeForPost(
  postId: string,
  outcome: SlotOutcome,
  detail?: string | null
): Promise<void> {
  await db.slotRun.updateMany({
    where: { postId, outcome: null },
    data: { outcome, detail: detail ? detail.slice(0, 500) : null },
  });
}

/** Müşterinin kuyruğu — `pickNext`in baktığı alanlar + e-postalar için caption/kare. */
export function loadQueue(clientId: string) {
  return db.post.findMany({
    where: { clientId, source: "portal", queuePosition: { not: null } },
    orderBy: [{ queuePosition: "asc" }, { id: "asc" }],
    select: {
      id: true,
      queuePosition: true,
      captionStatus: true,
      status: true,
      publishStatus: true,
      caption: true,
      frameKeys: true,
    },
  });
}

export type QueuePost = Awaited<ReturnType<typeof loadQueue>>[number];

/**
 * Bir sahiplenmenin "bayat" sayılacağı süre. Pencereden (1 saat) uzun: aynı
 * pencere içindeki iki slot aynı postu asla birlikte sahiplenemez.
 */
const POST_CLAIM_STALE_MS = 2 * SLOT_WINDOW_MS;

/**
 * Postu bu slota sahiplen (`slotAt` yazımı) — koşullu UPDATE.
 *
 * Neden `SlotRun` yetmiyor: o tablo AYNI slotun iki kez işlenmesini engelliyor.
 * İki FARKLI slot (ör. 19:00 ve 19:30, iki tick eşzamanlı) aynı `pickNext`
 * sonucunu görürse ikisi de aynı postu seçer; yayın kilidi çift yayını
 * engeller ama ikinci slot videosuz kalır ve "yayınlandı" diye yanlış kayıt
 * düşerdi. Kaybeden taraf burada `false` alır ve sıradakini seçer.
 *
 * `slotAt` dolu ama eski bir post (ör. hatadan sonra portaldan "tekrar dene"
 * ile `idle`a dönmüş) yeniden sahiplenilebilir; eşik `POST_CLAIM_STALE_MS`.
 */
export async function claimPostForSlot(input: {
  clientId: string;
  postId: string;
  slotAt: Date;
  now: Date;
}): Promise<boolean> {
  const staleBefore = new Date(input.now.getTime() - POST_CLAIM_STALE_MS);
  const result = await db.post.updateMany({
    where: {
      id: input.postId,
      clientId: input.clientId,
      source: "portal",
      publishStatus: "idle",
      OR: [{ slotAt: null }, { slotAt: { lt: staleBefore } }],
    },
    data: { slotAt: input.slotAt },
  });
  return result.count === 1;
}

/**
 * `ApprovalAudit.ip` ZORUNLU bir alan ve karar bir insandan gelmediği için
 * gerçek bir IP yok. Boş bırakmak ya da sahte bir IP yazmak kaydı yalana
 * çevirirdi; sabit "system" hem "bunu makine verdi" diyor hem de IP gibi
 * görünmediği için panelde bir kişiyle karıştırılmıyor (K3).
 */
export const AUTO_APPROVAL_IP = "system";

/**
 * Onay KAPALIYKEN sırası gelen videoyu onaylar (K3). Koşullu UPDATE
 * (`status: pending`) + audit aynı transaction'da — onay yolundaki desenin
 * aynısı. `false` = post artık bekleyen değil (ör. müşteri o sırada reddetti);
 * çağıran yayın denemez, yayın kilidinin önündeki onay kontrolü de zaten
 * reddeder.
 */
export async function autoApprovePost(clientId: string, postId: string): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const result = await tx.post.updateMany({
      where: { id: postId, clientId, status: "pending" },
      data: { status: "approved" },
    });
    if (result.count === 0) return false;
    await tx.approvalAudit.create({
      data: { postId, action: "auto_approved", ip: AUTO_APPROVAL_IP },
    });
    return true;
  });
}

/**
 * Container'ı açılmış ama yayını bitmemiş PORTAL videoları. Günlük cron'un
 * "takılı" dalından (10 dk) farkı: bir dakikalık container'ları da alır —
 * portal postunun onay sayfasında yoklayan bir tarayıcı yok.
 *
 * `openedBefore` neden hâlâ var: container'ı açan fonksiyon (eşzamanlı başka
 * bir tick) en fazla `maxDuration` = 60 sn yaşar ve o süre boyunca aynı
 * container'ı kendisi yokluyor olabilir. Daha tazesine dokunmak iki yoklayıcı,
 * iki `media_publish` denemesi demek; 60 sn sonra açan fonksiyonun öldüğü kesin.
 */
export function findPortalPublishingPosts(take: number, openedBefore: Date) {
  return db.post.findMany({
    where: {
      source: "portal",
      publishStatus: "publishing",
      igContainerId: { not: null },
      containerAt: { lte: openedBefore },
    },
    orderBy: { containerAt: "asc" },
    take,
    select: { id: true },
  });
}
