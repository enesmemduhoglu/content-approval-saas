import type { PublishStatus, SlotOutcome } from "@prisma/client";
import { isTransientDbError } from "@/lib/db-health";

/**
 * Yarıda kesilmiş yayınların KARAR mantığı — DB'ye dokunmaz, bu yüzden DB'siz
 * test edilir. Sorguları ve yazmaları `publish-post.ts` / `queue-db.ts` yapar;
 * neyin "takılı" sayılacağının tek tanımı burada.
 *
 * 2026-11-01: yayın kilidi tuttuktan sonra DB bağlantısı koptu, hatayı yazacak
 * `markFailed` de aynı ölü bağlantıya çarptı. Post `publishing`de, container
 * id'si boş kaldı — yayın kilidi, `resumePublish` ve takılı-video taraması o
 * kombinasyonu tanımıyordu, post sessizce kuyruktan düştü.
 */

/**
 * Kilidi alıp hiçbir şey yazamadan ölen bir çağrının ardından bu süre geçtiyse
 * post takılı sayılır. Kilit sahibi en fazla `maxDuration` (60 sn) yaşar; 10 dk
 * hâlâ container açmakta olan canlı bir çağrıyla yarışmaz. Günlük cron'un
 * takılı-video eşiğiyle (`STUCK_AFTER_MS`) aynı.
 */
export const INTERRUPTED_AFTER_MS = 10 * 60_000;

/** Panelde ve müşteri e-postasında görünen metin — sır taşımaz, ne yapılacağını söyler. */
export const INTERRUPTED_PUBLISH_DETAIL =
  "Yayın yarıda kesildi (veritabanı bağlantısı koptu) — tekrar denenebilir";

/** Yetim SlotRun'ı kapatırken yazılan açıklama. */
export const ORPHAN_SLOT_DETAIL = "Slot yarıda kaldı — sonuç yazılamadı";

/**
 * Kilit alınmış (`publishing`) ama container id'si hiç yazılmamış ve
 * `updatedAt`'ı eşikten eski post. Kilitten sonra `updatedAt`'ı değiştiren tek
 * yazma container id'sinin kendisi; o yazılmışsa post `resumePublish`in işi.
 */
export function isInterruptedPublish(
  post: { publishStatus: PublishStatus; igContainerId: string | null; updatedAt: Date },
  now: Date,
  staleAfterMs: number = INTERRUPTED_AFTER_MS
): boolean {
  if (post.publishStatus !== "publishing") return false;
  if (post.igContainerId) return false;
  return now.getTime() - post.updatedAt.getTime() >= staleAfterMs;
}

/**
 * Sonucu hiç yazılmamış SlotRun kapatılmalı mı?
 *
 * `publishing`deki postun satırı BEKLER: o yayın sürüyor ya da takılıysa
 * kurtarma ağı onu `failed`a çekecek ve satırı `markFailed` → sonuç kancası
 * kapatacak. Burada kapatmak o kancanın yazacağı gerçek sonucu ezerdi.
 */
export function orphanSlotRunAction(
  run: { outcome: SlotOutcome | null; createdAt: Date },
  post: { publishStatus: PublishStatus } | null,
  now: Date,
  olderThanMs: number
): "close" | "keep" {
  if (run.outcome !== null) return "keep";
  if (now.getTime() - run.createdAt.getTime() < olderThanMs) return "keep";
  if (post?.publishStatus === "publishing") return "keep";
  return "close";
}

/**
 * Yayının beklenmeyen hatası için operatöre giden metin. Ham hata metni
 * BİLEREK girmiyor: Prisma metni sorgunun gövdesini, başka bir hata bağlantı
 * adresini ya da imzalı URL'yi taşıyabilir. Ham hali yalnızca `console.error`'a
 * gider (CLAUDE.md: log ve hata metinleri sır taşımaz — uyarı e-postası da).
 */
export function interruptedDetail(error: unknown): string {
  if (isTransientDbError(error)) {
    return "Veritabanı bağlantısı koptu; yayın yarıda kalmış olabilir, kurtarma ağı sonucu yazacak";
  }
  const name = error instanceof Error ? error.name : typeof error;
  return `Beklenmeyen hata (${name}); yayın yarıda kalmış olabilir, kurtarma ağı sonucu yazacak`;
}
