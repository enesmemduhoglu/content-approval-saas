"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CaptionStatus, PostStatus, PublishStatus } from "@prisma/client";
import { PortalBadges } from "@/components/portal/portal-badges";
import { IconChevronDown, IconChevronUp, IconGrip } from "@/components/portal/icons";

export type QueueCard = {
  id: string;
  caption: string;
  status: PostStatus;
  captionStatus: CaptionStatus | null;
  publishStatus: PublishStatus;
  publishError: string | null;
  coverUrl: string | null;
};

/** Caption'ın kartta görünen başı; tam metin detay sayfasında. */
function captionHead(card: QueueCard): string {
  if (card.captionStatus === "pending" || card.captionStatus === "generating") {
    return "Caption hazırlanıyor…";
  }
  const text = card.caption.trim();
  if (!text) return "Caption yok";
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/**
 * Taşıma isteğinin gövdesi, YENİ sıradaki komşulardan. Ortadaki bir konum
 * için iki komşu birden gönderiliyor: sunucu ikisinin hâlâ yan yana olduğunu
 * doğruluyor, değilse (başka sekmede sıra değişmiş) 409 — bayat bir görüntüye
 * göre yazmak yerine kullanıcıya yenilemesini söylüyor.
 */
export function moveBody(order: string[], index: number): { beforeId?: string; afterId?: string } {
  const body: { beforeId?: string; afterId?: string } = {};
  if (index > 0) body.afterId = order[index - 1];
  if (index < order.length - 1) body.beforeId = order[index + 1];
  return body;
}

function cardTone(card: QueueCard, requireApproval: boolean): "busy" | "failed" | "pending" | null {
  if (card.captionStatus === "pending" || card.captionStatus === "generating") return "busy";
  if (card.publishStatus === "failed" || card.captionStatus === "failed") return "failed";
  if (card.status === "pending" && requireApproval && card.captionStatus === "ready") return "pending";
  return null;
}

function SortableRow({
  card,
  index,
  total,
  busy,
  requireApproval,
  eta,
  onStep,
}: {
  card: QueueCard;
  index: number;
  total: number;
  busy: boolean;
  requireApproval: boolean;
  eta?: ReactNode;
  onStep: (id: string, delta: -1 | 1) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: card.id, disabled: busy });
  const tone = cardTone(card, requireApproval);

  return (
    <li
      ref={setNodeRef}
      className={`p-qcard${tone ? ` p-qcard--${tone}` : ""}${isDragging ? " p-qcard--dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      {/* Tutamaç yalnızca bu buton: kartın tamamı sürüklenebilir olsaydı
          telefonda sayfayı kaydırmak imkânsızlaşırdı. CSS onu yalnızca
          fare/iz dörtgeninde gösteriyor; dokunmatikte oklar var. */}
      <button
        type="button"
        ref={setActivatorNodeRef}
        className="p-grip"
        aria-label={`${index + 1}. videoyu sürükle`}
        {...attributes}
        {...listeners}
      >
        <IconGrip size={18} />
      </button>
      <Link href={`/portal/video/${card.id}`} className="p-qcard-link">
        {card.coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={card.coverUrl}
            alt=""
            className={`p-cover${tone === "failed" ? " p-cover--dim" : ""}`}
            loading="lazy"
          />
        ) : (
          <span
            className={`p-cover${tone === "busy" ? " p-cover--busy" : ""}${tone === "failed" ? " p-cover--dim" : ""}`}
            aria-hidden="true"
          />
        )}
        <span className="p-qcard-body">
          <span className="p-qcard-meta">
            <PortalBadges video={card} requireApproval={requireApproval} />
            {eta ? <span className="p-eta">{eta}</span> : null}
          </span>
          {tone === "busy" ? (
            <>
              {/* İskelet: metin henüz yok, kartın yeri ve boyu şimdiden belli. */}
              <span className="p-skel" style={{ width: "92%" }} aria-hidden="true" />
              <span className="p-skel" style={{ width: "64%" }} aria-hidden="true" />
              <span className="p-eta">Konuşma yazıya dökülüyor…</span>
            </>
          ) : card.publishStatus === "failed" ? (
            <>
              <span className="p-qcard-error">
                {card.publishError ?? "Instagram'a gönderilemedi."} Video sırada bekliyor.
              </span>
              <span className="p-qcard-cta">Tekrar dene</span>
            </>
          ) : (
            <span className={`p-qcard-caption${card.caption.trim() ? "" : " p-qcard-caption--muted"}`}>
              {captionHead(card)}
            </span>
          )}
        </span>
      </Link>
      <span className="p-arrows">
        <button
          type="button"
          className="p-arrow"
          aria-label="Yukarı taşı"
          disabled={busy || index === 0}
          onClick={() => onStep(card.id, -1)}
        >
          <IconChevronUp size={18} />
        </button>
        <button
          type="button"
          className="p-arrow"
          aria-label="Aşağı taşı"
          disabled={busy || index === total - 1}
          onClick={() => onStep(card.id, 1)}
        >
          <IconChevronDown size={18} />
        </button>
      </span>
    </li>
  );
}

/**
 * Kuyruk: sürükle-bırak (@dnd-kit) + her kartta yukarı/aşağı okları. Oklar
 * yalnızca mobil için değil; klavye ve ekran okuyucu kullanıcısı için de
 * sürüklemenin en basit karşılığı.
 *
 * İyimser güncelleme: sıra önce ekranda değişir, istek başarısızsa geri alınır.
 * Aynı anda tek taşıma uçuşta — iki istek yarışırsa sunucudaki sıra ile
 * ekrandaki sıra ayrışırdı.
 */
export function QueueBoard({
  cards,
  requireApproval,
  etas,
}: {
  cards: QueueCard[];
  requireApproval: boolean;
  /** Kart id'si → tahmini yayın zamanı metni ("Yarın 19:00"); takvimde olmayan kartta yok. */
  etas?: Record<string, ReactNode>;
}) {
  const router = useRouter();
  const [order, setOrder] = useState(() => cards.map((c) => c.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const byId = new Map(cards.map((c) => [c.id, c]));
  // Sunucudan yeni kart gelirse (refresh) yerel sıraya eklenir, silinen düşer.
  const known = order.filter((id) => byId.has(id));
  const fresh = cards.map((c) => c.id).filter((id) => !known.includes(id));
  const ids = [...known, ...fresh];

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  async function commit(next: string[], movedId: string) {
    const previous = ids;
    setOrder(next);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/portal/videos/${movedId}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(moveBody(next, next.indexOf(movedId))),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setOrder(previous);
        setError(data.error ?? "Sıra değiştirilemedi, tekrar dene");
        if (res.status === 409) router.refresh();
        return;
      }
      // Tahmini yayın zamanları sıraya bağlı ve sunucuda hesaplanıyor
      // (projectSchedule); yeni sırayla yeniden çizilsinler.
      router.refresh();
    } catch {
      setOrder(previous);
      setError("Bağlantı hatası, sıra değiştirilemedi");
    } finally {
      setBusy(false);
    }
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id || busy) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    void commit(arrayMove(ids, from, to), String(active.id));
  }

  function onStep(id: string, delta: -1 | 1) {
    if (busy) return;
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    void commit(arrayMove(ids, from, to), id);
  }

  if (ids.length === 0) {
    return (
      <p className="p-empty">
        Kuyruk boş. <Link href="/portal/yukle">Video yükle</Link>, sırası gelince yayınlansın.
      </p>
    );
  }

  return (
    <>
      {error && (
        <p className="p-error" role="alert">
          {error}
        </p>
      )}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ol className="p-list" aria-label="Yayın kuyruğu">
            {ids.map((id, index) => {
              const card = byId.get(id);
              if (!card) return null;
              return (
                <SortableRow
                  key={id}
                  card={card}
                  index={index}
                  total={ids.length}
                  busy={busy}
                  requireApproval={requireApproval}
                  eta={etas?.[id]}
                  onStep={onStep}
                />
              );
            })}
          </ol>
        </SortableContext>
      </DndContext>
    </>
  );
}
