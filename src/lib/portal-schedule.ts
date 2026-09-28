import type { PublishSettings } from "@prisma/client";
import {
  localParts,
  parseSlot,
  projectSchedule,
  slotInstants,
  type QueueItem,
} from "@/lib/queue";

/**
 * Video kuyruğu (V3) — portal kartındaki "tahmini yayın" metni.
 *
 * Hesap V4'ün `projectSchedule`ı: tick'in kurallarını birebir simüle ediyor
 * (onay açıkken onaysız video takvimde yok, duraklatılmış kuyrukta takvim
 * boş). Portal kendi hesabını yazmıyor — iki ayrı hesap, kartta "19:00" yazıp
 * tick'in başka videoyu yayınlaması demek olurdu.
 *
 * Ayar satırı yoksa tahmin YOK: tick yalnızca ayarı olan müşterileri tarar,
 * yani o kuyruk hiç yayın yapmayacak.
 */
export function estimatePublishTimes(
  queue: QueueItem[],
  settings: Pick<PublishSettings, "slots" | "timezone" | "days" | "requireApproval" | "paused"> | null,
  now: Date = new Date()
): Map<string, Date> {
  if (!settings) return new Map();
  return new Map(
    projectSchedule(queue, settings, now, queue.length).map((slot) => [slot.postId, slot.slotAt])
  );
}

/** "Cmt 27 Eyl 19:00" — müşterinin kendi saat diliminde. */
export function formatEta(slotAt: Date, timezone: string): string {
  return slotAt.toLocaleString("tr-TR", {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── Kuyruk kaç gün yeter ──────────────────────────────────────────────────

type RunwaySettings = Pick<
  PublishSettings,
  "slots" | "timezone" | "days" | "requireApproval" | "paused"
>;

/** Bir senaryoda (onaylılar / hepsi onaylanırsa) kuyruğun bittiği yer. */
export type RunwayEnd = {
  /** Takvime giren video sayısı. */
  count: number;
  /** Son yayının anı (kuyruğun son videosu). */
  lastAt: Date;
  /**
   * Bugünden son yayın gününe kadar kapsanan YEREL takvim günü, bugün dahil.
   * Tanım ve kenar durumlar `queueRunway`ın açıklamasında.
   */
  days: number;
  /** Son yayından sonraki ilk slot — video eklenmezse boş geçecek ilk slot. */
  emptyFrom: Date;
};

export type QueueRunway = {
  /** Şu anki kuyrukla gerçekten yayınlanacaklar; takvime giren yoksa `null`. */
  approved: RunwayEnd | null;
  /**
   * Kuyruktaki her şey onaylanırsa. Yalnızca onay AÇIKKEN ve sonuç
   * `approved`dan fazla video kapsıyorsa dolu; aksi halde `null` (gösterilmez).
   */
  ifAllApproved: RunwayEnd | null;
  /** `now`dan sonraki ilk slot — kuyruk boşken "sıradaki slot boş geçer" için. */
  nextSlotAt: Date;
};

const DAY_MS = 86_400_000;

/**
 * Seçili bir yayın günü (yalnız Pazartesi dahil) en geç 7 günde bir gelir;
 * +2 gün DST ve gün sınırı payı. `emptyFrom`/`nextSlotAt` bu pencerede kesin
 * bulunur.
 */
const NEXT_SLOT_SPAN_MS = 9 * DAY_MS;

/** İki anın `timezone`daki takvim günleri arasındaki fark (gün). */
function localDayDiff(from: Date, to: Date, timezone: string): number {
  const a = localParts(from, timezone);
  const b = localParts(to, timezone);
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY_MS
  );
}

/** `after`dan SONRAKİ ilk slot — `projectSchedule`ın `now + 1ms` kuralıyla aynı. */
function firstSlotAfter(settings: RunwaySettings, after: Date): Date {
  const [first] = slotInstants(settings, {
    from: new Date(after.getTime() + 1),
    to: new Date(after.getTime() + NEXT_SLOT_SPAN_MS),
  });
  return first;
}

function runwayEnd(queue: QueueItem[], settings: RunwaySettings, now: Date): RunwayEnd | null {
  const projected = projectSchedule(queue, settings, now, queue.length);
  if (projected.length === 0) return null;
  // `projectSchedule` slotları artan sırada dolduruyor; yine de sıraya
  // yaslanmadan en geçi al — sözleşme "en geç yayın".
  const lastAt = projected.reduce(
    (max, p) => (p.slotAt > max ? p.slotAt : max),
    projected[0].slotAt
  );
  return {
    count: projected.length,
    lastAt,
    days: localDayDiff(now, lastAt, settings.timezone) + 1,
    emptyFrom: firstSlotAfter(settings, lastAt),
  };
}

/**
 * "Kuyruk kaç gün yeter" — portalın kuyruk ekranı için.
 *
 * Ayrı bir takvim hesabı YOK: iki senaryo da `projectSchedule`dan geçer,
 * yani yayın günleri, slotlar, saat dilimi, onay modu ve `now`dan önceki
 * slotların atlanması tick'le birebir aynı. Portal "10 gün yeter" deyip
 * tick'in 8. gün boş slot geçirmesi mümkün olmasın.
 *
 * **"Gün" tanımı:** bugünden (müşterinin saat diliminde YEREL takvim günü)
 * son yayının yerel gününe kadar kapsanan takvim günü sayısı, BUGÜN DAHİL:
 * `days = (sonYayınGünü − bugün) + 1`. Yayın yapılmayan günler (seçilmemiş
 * hafta sonu gibi) de sayılır — soru "kaç gün boyunca içerik derdim yok",
 * "kaç yayın günü" değil. Örnekler (İstanbul, slotlar 12:00 ve 19:00,
 * 20 onaylı video):
 *  - Şu an 10:00 → bugün 2 yayın, … son yayın 10. günün 19:00'u → **10 gün**.
 *  - Şu an 13:00 (12:00 geçti) → bugün yalnız 19:00; son yayın 11. günün
 *    12:00'si → **11 gün**: kaçan slot bir video artırıyor, takvim bir gün uzuyor.
 *  - Şu an 20:00 (bugünün slotları bitti) → ilk yayın yarın ama bugün yine
 *    sayılır; son yayın 11. günün 19:00'u → **11 gün**.
 * Gün sınırı UTC'nin değil müşterinin gece yarısı: sunucu (Vercel) UTC'de
 * koşuyor, İstanbul'da 00:00–03:00 arası UTC günüyle sayılsaydı bir gün kayardı.
 *
 * `null` → gösterge gizlenir: ayar yok (tick bu müşteriyi hiç taramaz),
 * kuyruk duraklatılmış ya da geçerli tek bir slot saati bile yok. Kuyruk boş
 * ya da takvime giren video yoksa `null` DEĞİL, `approved: null` — o durum
 * kullanıcıya söylenmesi gereken bir bilgi ("sıradaki slot boş geçer").
 *
 * `ifAllApproved`: her öğe `status: "approved"`, `captionStatus: "ready"`
 * sayılır; `publishStatus` ve `queuePosition` olduğu gibi kalır, yani yayını
 * patlamış (`failed`) video `isEligible` gereği yine takvime girmez — onu
 * onay değil "tekrar dene" kurtarır. Caption'ı ÜRETİLEMEMİŞ (`failed`) video
 * da sayılmaz: onaylanabilmesi için önce caption'ının düzeltilmesi gerekiyor
 * (2026-09-28 analizi); hazırlanmakta olanlar birazdan hazır olacağı için
 * sayılır. Onay KAPALIYKEN hep `null`: onay yayını zaten belirlemiyor,
 * "hepsini onaylarsan" cümlesi yanıltıcı olurdu.
 */
export function queueRunway(
  queue: QueueItem[],
  settings: RunwaySettings | null,
  now: Date = new Date()
): QueueRunway | null {
  if (!settings || settings.paused) return null;
  // Gün listesi hiçbir zaman boş sayılmaz (boşsa tüm günler, bkz.
  // `QueueSettings.days`); haftada slot olup olmadığını geçerli saat belirler.
  if (!settings.slots.some((slot) => parseSlot(slot) !== null)) return null;

  const approved = runwayEnd(queue, settings, now);

  let ifAllApproved: RunwayEnd | null = null;
  if (settings.requireApproval) {
    const hypothetical = queue.map((item) =>
      item.captionStatus === "failed"
        ? item
        : { ...item, status: "approved" as const, captionStatus: "ready" as const }
    );
    const all = runwayEnd(hypothetical, settings, now);
    if (all && all.count > (approved?.count ?? 0)) ifAllApproved = all;
  }

  return { approved, ifAllApproved, nextSlotAt: firstSlotAfter(settings, now) };
}
