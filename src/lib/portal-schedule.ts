import type { PublishSettings } from "@prisma/client";
import { projectSchedule, type QueueItem } from "@/lib/queue";

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
  settings: Pick<PublishSettings, "slots" | "timezone" | "requireApproval" | "paused"> | null,
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
