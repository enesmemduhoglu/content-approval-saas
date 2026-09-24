/**
 * Video kuyruğu (V3) — portal kuyruğunda taşıma hesabı. Saf fonksiyon, DB'siz
 * test edilir.
 *
 * `queuePosition` Float: araya taşıma iki komşunun ortalaması, yani normalde
 * TEK satır güncellenir (README §4). Ama float'ın çözünürlüğü sonsuz değil —
 * aynı iki komşunun arasına ~50 kez üst üste taşıma yapılırsa ortalama
 * komşulardan birine eşit çıkar ve sıra sessizce bozulur. O noktada tüm kuyruk
 * 1, 2, 3… diye yeniden numaralanır (nadir, küçük bir kuyrukta ucuz).
 *
 * Not: V4'ün `queue.ts`'inde de benzer bir `positionBetween` planlanıyor;
 * entegrasyonda tek yere indirilebilir.
 */

export type QueueItem = { id: string; queuePosition: number };

/**
 * Taşımanın hedefi. İkisi de "yeni konumdaki komşu" anlamında:
 *  - `beforeId`: taşınan video BU videonun ÖNÜNE gelir,
 *  - `afterId`:  taşınan video BU videonun ARKASINA gelir.
 * İkisi birden verilirse yeni konumda gerçekten yan yana olmaları gerekir;
 * değillerse istemci bayat bir listeye bakıyordur (409).
 */
export type MoveTarget = { beforeId?: string; afterId?: string };

export type MovePlan =
  | { kind: "single"; position: number }
  | { kind: "renumber"; order: string[] }
  | { kind: "error"; reason: "not_in_queue" | "anchor_not_found" | "stale" | "self" };

/** İki float arasında güvenli bir orta nokta var mı? */
function between(prev: number | null, next: number | null): number | null {
  if (prev === null && next === null) return 1;
  if (prev === null) return (next as number) - 1;
  if (next === null) return prev + 1;
  const mid = (prev + next) / 2;
  // Ortalama komşulardan birine eşitse (ya da sıra zaten bozuksa) float
  // çözünürlüğü tükenmiş demektir.
  if (!(mid > prev && mid < next)) return null;
  return mid;
}

/**
 * `queue`: bu müşterinin kuyruğu, sırasıyla (taşınan video DAHİL).
 */
export function planMove(queue: QueueItem[], movingId: string, target: MoveTarget): MovePlan {
  if (!queue.some((item) => item.id === movingId)) {
    return { kind: "error", reason: "not_in_queue" };
  }
  if (target.beforeId === movingId || target.afterId === movingId) {
    return { kind: "error", reason: "self" };
  }
  const rest = queue.filter((item) => item.id !== movingId);

  let insertAt: number;
  if (target.afterId) {
    const idx = rest.findIndex((item) => item.id === target.afterId);
    if (idx === -1) return { kind: "error", reason: "anchor_not_found" };
    insertAt = idx + 1;
    if (target.beforeId && rest[insertAt]?.id !== target.beforeId) {
      return { kind: "error", reason: rest.some((i) => i.id === target.beforeId) ? "stale" : "anchor_not_found" };
    }
  } else if (target.beforeId) {
    const idx = rest.findIndex((item) => item.id === target.beforeId);
    if (idx === -1) return { kind: "error", reason: "anchor_not_found" };
    insertAt = idx;
  } else {
    return { kind: "error", reason: "anchor_not_found" };
  }

  const prev = insertAt > 0 ? rest[insertAt - 1].queuePosition : null;
  const next = insertAt < rest.length ? rest[insertAt].queuePosition : null;
  const position = between(prev, next);
  if (position !== null) return { kind: "single", position };

  const order = rest.map((item) => item.id);
  order.splice(insertAt, 0, movingId);
  return { kind: "renumber", order };
}

/** Kuyruğun sonu: en büyük konumun bir fazlası (boş kuyrukta 1). */
export function positionAtEnd(maxPosition: number | null): number {
  return maxPosition === null ? 1 : Math.floor(maxPosition) + 1;
}
