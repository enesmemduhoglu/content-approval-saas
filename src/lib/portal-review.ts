import type { CaptionStatus, PostStatus } from "@prisma/client";

/**
 * Portal — "Onayla ve sıradakine geç" (V7 tasarımı, "Güncelleme 28 Eyl (3)").
 *
 * Müşteri yüklediği 5 videoyu tek oturumda onaylıyor; her onaydan sonra
 * kuyruğa dönüp bir sonrakini bulmak gereksiz iki dokunuş. Onay bekleyen
 * videolar kuyruk sırasıyla gezilir: sıradaki, bu videodan SONRA gelen ilk
 * onaylanabilir video; yoksa baştan ilk (sondaki videoyu onaylayan başa döner).
 */

type ReviewItem = { id: string; status: PostStatus; captionStatus: CaptionStatus | null };

/** Onay düğmesinin açık olduğu video: onay bekliyor ve caption'ı hazır. */
export function isAwaitingDecision(item: Pick<ReviewItem, "status" | "captionStatus">): boolean {
  return item.status === "pending" && item.captionStatus === "ready";
}

export type ReviewNext = {
  /** Bu videodan sonra bakılacak video; başka bekleyen yoksa `null`. */
  nextId: string | null;
  /** Bu video dahil, onay bekleyen video sayısı. */
  awaiting: number;
  /** Bu videonun bekleyenler arasındaki sırası (1'den), bekleyen değilse `null`. */
  index: number | null;
};

export function reviewNext(queue: readonly ReviewItem[], currentId: string): ReviewNext {
  const awaiting = queue.filter(isAwaitingDecision);
  const at = awaiting.findIndex((item) => item.id === currentId);
  const position = queue.findIndex((item) => item.id === currentId);
  const after = awaiting.find((item) => queue.indexOf(item) > position && item.id !== currentId);
  const before = awaiting.find((item) => item.id !== currentId);
  return {
    nextId: (after ?? before)?.id ?? null,
    awaiting: awaiting.length,
    index: at >= 0 ? at + 1 : null,
  };
}
