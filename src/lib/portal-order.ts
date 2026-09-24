import { needsRenumber, positionBetween } from "@/lib/queue";

/**
 * Video kuyruğu (V3) — portal kuyruğunda taşımanın PLANI. Saf fonksiyon,
 * DB'siz test edilir.
 *
 * Sayı kuralı (komşu ortalaması, adım, float çözünürlüğü eşiği) burada DEĞİL,
 * `queue.ts`te (`positionBetween` / `needsRenumber` / `renumberPositions`):
 * tick ve portal aynı sıralamaya bakıyor, kural tek yerde durmalı. Bu dosyanın
 * işi portala özgü olan kısım — istemcinin "şu videonun önüne/arkasına"
 * isteğini iki komşuya çevirmek ve bayat istekleri ayıklamak.
 */

export type OrderItem = { id: string; queuePosition: number };

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

/** `queue`: bu müşterinin kuyruğu, sırasıyla (taşınan video DAHİL). */
export function planMove(queue: OrderItem[], movingId: string, target: MoveTarget): MovePlan {
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
      const known = rest.some((item) => item.id === target.beforeId);
      return { kind: "error", reason: known ? "stale" : "anchor_not_found" };
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
  if (!needsRenumber(prev, next)) {
    return { kind: "single", position: positionBetween(prev, next) };
  }
  const order = rest.map((item) => item.id);
  order.splice(insertAt, 0, movingId);
  return { kind: "renumber", order };
}

/** Kuyruğun sonu — `queue.ts`in adımıyla (boş kuyrukta ilk pozisyon). */
export function positionAtEnd(maxPosition: number | null): number {
  return positionBetween(maxPosition, null);
}
