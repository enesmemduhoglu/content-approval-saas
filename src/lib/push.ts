import webpush, { WebPushError } from "web-push";
import { db } from "@/lib/db";
import { resolvePortalApp } from "@/lib/portal-app";
import { upstashConfig } from "@/lib/rate-limit";

/**
 * V7c — telefon bildirimi (Web Push) gönderimi (V7-pwa §6).
 *
 * ─── Sözleşme: ASLA throw etmez ─────────────────────────────────────────────
 * `sendAlert` deseni: bildirim ek bir kanal, e-posta asıl kanal (K4). Push
 * servisinin (Apple/Google) hatası yayını, tick'i ya da caption işini
 * düşürmemeli. Her hata yutulur ve (sırsız) loglanır.
 *
 * ─── Env boşken ────────────────────────────────────────────────────────────
 * `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` yoksa gönderim
 * atlanır ve bu LOGLANIR (CLAUDE.md "env boşken sessizce değil"). Abonelik
 * route'u da public anahtarı `null` döner; arayüz anahtarı kapatır.
 *
 * ─── Abonelik temizliği ────────────────────────────────────────────────────
 * 404/410: push servisi "bu abonelik yok" diyor (kullanıcı izni kaldırdı,
 * uygulamayı sildi) → satır silinir. Diğer hatalar geçici olabilir →
 * `failCount++`; art arda `PUSH_MAX_FAILURES` hatada satır silinir. Başarı
 * sayacı sıfırlar: sınır "art arda" hatalar için.
 *
 * ─── Ne loglanır, ne loglanmaz ─────────────────────────────────────────────
 * `endpoint` bir yetenek adresi (bilen herkes o cihaza istek atabilir; içerik
 * şifreli olsa da), `p256dh`/`auth` şifreleme anahtarı. Üçü de loga girmez;
 * log satırında abonelik id'si ve HTTP durum kodu yeter.
 */

/** Art arda bu kadar başarısız gönderimde abonelik silinir. */
export const PUSH_MAX_FAILURES = 5;
/**
 * Push servisinde bekleme süresi (sn). Telefon kapalıyken gelen "yayınlandı"
 * bir gün sonra hâlâ anlamlı; bir haftalık bayat bildirim ise kafa karıştırır.
 */
const PUSH_TTL_SECONDS = 24 * 60 * 60;
/** Push servisine tek istek için soket zaman aşımı; tick'i bekletmesin. */
const PUSH_TIMEOUT_MS = 10_000;
const TITLE_MAX = 80;
const BODY_MAX = 200;

export type PushPayload = {
  title: string;
  body: string;
  /** Yalnızca portal içi yol ("/portal…") ya da https Instagram linki — bkz. `safePushUrl`. */
  url: string;
  /** Aynı etiketli bildirim bildirim merkezinde öncekinin yerine geçer. */
  tag?: string;
};

export type PushResult = {
  sent: number;
  removed: number;
  failed: number;
  /** Gönderim hiç denenmedi: env yok ya da abonelik yok. */
  skipped?: "not_configured" | "no_subscriptions" | "error";
};

type VapidDetails = { publicKey: string; privateKey: string; subject: string };

function vapidDetails(): VapidDetails | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

/** İstemcinin `applicationServerKey`'i. Private anahtar yoksa da `null`: yarım yapılandırmada abone olunmasın. */
export function getVapidPublicKey(): string | null {
  return vapidDetails()?.publicKey ?? null;
}

const INSTAGRAM_HOSTS = new Set(["www.instagram.com", "instagram.com"]);

/**
 * Bildirim URL'i yalnızca iki biçimde: portal içi yol ya da https Instagram
 * linki. Başka her şey "/portal"a düşer. SW aynı kuralı tekrar uygular
 * (`public/sw.js`) — bu fonksiyon payload'a ne yazıldığını, SW neyin
 * açıldığını korur.
 */
export function safePushUrl(url: string | null | undefined): string {
  if (!url) return "/portal";
  if (/^\/portal(?:[/?#]|$)/.test(url) && !url.startsWith("//")) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && INSTAGRAM_HOSTS.has(parsed.hostname)) return parsed.href;
  } catch {
    // geçersiz URL → varsayılan
  }
  return "/portal";
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** `Topic` başlığı: en fazla 32 karakter, URL-güvenli base64 alfabesi. */
function topicOf(tag: string | undefined): string | undefined {
  const topic = tag?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  return topic || undefined;
}

let warnedNotConfigured = false;

/** Testler "env yok" uyarısını yeniden görebilsin diye. */
export function resetPushForTests(): void {
  warnedNotConfigured = false;
  captionReadySentAt.clear();
}

/**
 * Müşterinin TÜM portal kullanıcılarının TÜM cihazlarına gönderir. Asla
 * throw etmez; dönüş yalnızca gözlem (testler, log) için.
 */
export async function notifyClientUsers(clientId: string, payload: PushPayload): Promise<PushResult> {
  const result: PushResult = { sent: 0, removed: 0, failed: 0 };
  try {
    const vapid = vapidDetails();
    if (!vapid) {
      // Her çağrıda değil süreç başına bir kez: tick her slotta çağırıyor.
      if (!warnedNotConfigured) {
        warnedNotConfigured = true;
        console.warn("[push] VAPID anahtarları tanımlı değil — telefon bildirimleri gönderilmiyor");
      }
      return { ...result, skipped: "not_configured" };
    }

    const [subscriptions, client] = await Promise.all([
      db.pushSubscription.findMany({
        where: { clientUser: { clientId } },
        select: { id: true, endpoint: true, p256dh: true, auth: true },
      }),
      db.client.findUnique({
        where: { id: clientId },
        select: {
          name: true,
          appName: true,
          appShortName: true,
          appThemeColor: true,
          appIconBase: true,
        },
      }),
    ]);
    if (subscriptions.length === 0) return { ...result, skipped: "no_subscriptions" };

    // İkon müşteriye özel (K23); Android'de bildirimde görünür, iOS uygulama
    // ikonunu kullanır. Yol `portal-app`in doğrulamasından geçiyor ("/icons/…").
    const app = resolvePortalApp(client);
    const body = JSON.stringify({
      title: clip(payload.title, TITLE_MAX),
      body: clip(payload.body, BODY_MAX),
      url: safePushUrl(payload.url),
      tag: payload.tag,
      icon: `${app.iconBase}/icon-192.png`,
    });

    const options = {
      vapidDetails: vapid,
      TTL: PUSH_TTL_SECONDS,
      urgency: "normal" as const,
      topic: topicOf(payload.tag),
      timeout: PUSH_TIMEOUT_MS,
      // Apple yalnızca RFC 8291 (aes128gcm) kabul ediyor.
      contentEncoding: "aes128gcm" as const,
    };

    await Promise.all(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            body,
            options
          );
          result.sent += 1;
          await db.pushSubscription.updateMany({
            where: { id: sub.id },
            data: { lastSuccessAt: new Date(), failCount: 0 },
          });
        } catch (error) {
          if (await handleSendError(sub.id, error)) result.removed += 1;
          else result.failed += 1;
        }
      })
    );
    return result;
  } catch (error) {
    console.error(`[push] bildirim gönderilemedi (müşteri=${clientId}):`, safeError(error));
    return { ...result, skipped: "error" };
  }
}

/** Hatalı gönderimin kaydı. Dönüş: abonelik silindi mi. Kendisi de throw etmez. */
async function handleSendError(subscriptionId: string, error: unknown): Promise<boolean> {
  try {
    const status = error instanceof WebPushError ? error.statusCode : null;
    if (status === 404 || status === 410) {
      await db.pushSubscription.deleteMany({ where: { id: subscriptionId } });
      return true;
    }
    console.error(`[push] gönderim başarısız (abonelik=${subscriptionId}):`, safeError(error));
    await db.pushSubscription.updateMany({
      where: { id: subscriptionId },
      data: { failCount: { increment: 1 } },
    });
    const removed = await db.pushSubscription.deleteMany({
      where: { id: subscriptionId, failCount: { gte: PUSH_MAX_FAILURES } },
    });
    return removed.count > 0;
  } catch (dbError) {
    console.error(`[push] abonelik güncellenemedi (abonelik=${subscriptionId}):`, safeError(dbError));
    return false;
  }
}

/**
 * Log için hata özeti. `WebPushError.message`/`body` push servisinin yanıtı,
 * `endpoint` alanı ise abonelik adresi — o alan yazılmaz.
 */
function safeError(error: unknown): string {
  if (error instanceof WebPushError) {
    return `HTTP ${error.statusCode} ${clip(error.body ?? "", 120)}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  // Hata metnine bir URL (endpoint) karışmışsa ayıkla.
  return clip(message.replace(/https?:\/\/\S+/gi, "[adres gizlendi]"), 200);
}

// ─── Caption'lar hazır (toplu) ─────────────────────────────────────────────

/**
 * Aynı müşteriye bu süre içinde "hazır" bildirimi gittiyse yenisi atlanır.
 * Üç video art arda yüklenince üç bildirim değil bir bildirim.
 */
export const CAPTION_READY_THROTTLE_MS = 2 * 60 * 1000;
/**
 * Bu süreden eski `pending`/`generating` "yolda" sayılmaz (takılmış iş —
 * `run.ts > STALE_AFTER_MS` ve `STUCK_PENDING_MS` ile aynı değer). Takılı bir
 * video bildirimi sonsuza kadar bekletmesin.
 */
const IN_FLIGHT_MAX_AGE_MS = 10 * 60 * 1000;

// Süreç içi kısma; Upstash varsa instance'lar arası da (bkz. `claimCaptionReadySlot`).
const captionReadySentAt = new Map<string, number>();

/**
 * Kısma hakkını alır: `true` → bu çağrı gönderebilir. Upstash varsa
 * `SET NX PX` (instance'lar arası tek kazanan), yoksa ya da hata verirse
 * süreç içi bellek. Kesin tekrar koruması DEĞİL — amaç spam önlemek (K4'teki
 * e-posta asıl kanal; bir fazla bildirim zarar değil).
 */
async function claimCaptionReadySlot(clientId: string, now: number): Promise<boolean> {
  const last = captionReadySentAt.get(clientId);
  if (last !== undefined && now - last < CAPTION_READY_THROTTLE_MS) return false;

  const config = upstashConfig();
  if (config) {
    try {
      const res = await fetch(`${config.baseUrl}/pipeline`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
        body: JSON.stringify([
          ["SET", `push:caption-ready:${clientId}`, "1", "NX", "PX", String(CAPTION_READY_THROTTLE_MS)],
        ]),
      });
      if (!res.ok) throw new Error(`Upstash pipeline ${res.status}`);
      const out = (await res.json()) as { result?: unknown }[];
      // NX: anahtar zaten varsa `null` — başka bir instance son 2 dk'da gönderdi.
      if (out?.[0]?.result !== "OK") {
        captionReadySentAt.set(clientId, now);
        return false;
      }
    } catch (error) {
      console.warn("[push] Upstash kısma hatası, bellek içi kısmaya düşüldü:", safeError(error));
    }
  }
  captionReadySentAt.set(clientId, now);
  return true;
}

/**
 * Caption `ready` olunca çağrılır (`caption/run.ts`). Video başına bildirim
 * YOK (V7-pwa §6.1): toplu yüklemede her video ayrı bitiyor.
 *
 *  1. Onay kapalıysa gönderilmez — onaylanacak bir şey yok, video sırası
 *     gelince zaten yayınlanır (ve "yayınlandı" bildirimi gider).
 *  2. Aynı müşterinin başka bir caption'ı hâlâ yoldaysa gönderilmez: partinin
 *     SONUNDA tek bildirim, doğru sayıyla. Her çağrı kendi `ready` yazımından
 *     SONRA baktığı için en son biten mutlaka partinin tamamını görür.
 *  3. Son 2 dakikada gönderildiyse atlanır (tek tek art arda yükleme).
 *
 * Asla throw etmez.
 */
export async function notifyCaptionsReady(clientId: string, now: Date = new Date()): Promise<void> {
  try {
    const settings = await db.publishSettings.findUnique({
      where: { clientId },
      select: { requireApproval: true },
    });
    // Ayar satırı yoksa şema varsayılanı (onay açık) geçerli.
    if (settings && !settings.requireApproval) return;

    const portal = { clientId, source: "portal" as const };
    const [inFlight, waiting] = await Promise.all([
      db.post.count({
        where: {
          ...portal,
          status: { in: ["pending", "approved"] },
          captionStatus: { in: ["pending", "generating"] },
          updatedAt: { gt: new Date(now.getTime() - IN_FLIGHT_MAX_AGE_MS) },
        },
      }),
      db.post.count({
        where: {
          ...portal,
          status: "pending",
          captionStatus: "ready",
          queuePosition: { not: null },
          publishStatus: { in: ["idle", "failed"] },
        },
      }),
    ]);
    if (inFlight > 0 || waiting === 0) return;
    if (!(await claimCaptionReadySlot(clientId, now.getTime()))) return;

    await notifyClientUsers(clientId, {
      title: waiting === 1 ? "1 video onayına hazır" : `${waiting} video onayına hazır`,
      body: "Caption'lar yazıldı. Yayından önce göz atıp onaylayabilirsin.",
      url: "/portal",
      tag: "caption-hazir",
    });
  } catch (error) {
    console.error(`[push] caption hazır bildirimi patladı (müşteri=${clientId}):`, safeError(error));
  }
}
